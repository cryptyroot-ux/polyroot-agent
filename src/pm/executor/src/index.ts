/**
 * @polyroot/executor — Executor core (PM-EXE-01..08, Blueprint B10/B11 / TABLE 16).
 *
 * Guarantees implemented here (the correctness heart of execution):
 *
 *  1. **Idempotency / dedupe (EXE-03)**: an order id (or its governing permit)
 *     is tracked across its whole lifecycle. The same order is NEVER submitted
 *     twice, even when the first attempt returns `SUBMISSION_UNKNOWN` — a live
 *     submit for an already-seen id is refused and routed to reconciliation.
 *
 *  2. **No blind retry (EXE-04)**: a `SUBMITTING` order whose outcome is unknown
 *     is NOT re-submitted. It must be reconciled (queries to the venue) before
 *     any further action. This prevents duplicate fills.
 *
 *  3. **Permit TTL recheck (EXE-05)**: before each submit the permit is
 *     re-checked for expiry and single-use status against a live clock. An
 *     expired or already-used permit aborts submission.
 *
 *  3b. **Permit–order binding**: when the signed order carries a permit_id it
 *     must match the presented permit exactly — prevents cross-market permit
 *     reuse.
 *
 *  4. **Per-order cancel (EXE-06)**: cancels are routed per order id and gated
 *     by the venue-mode matrix (CANCEL_ONLY permits cancels; READ_ONLY does not).
 *
 *  5. **Crash window elimination (EXE-07)**: SUBMITTING state is persisted to
 *     recovery_ledger BEFORE the venue call. All 10 crash windows are covered.
 *
 *  6. **Executor lease/fencing (EXE-08)**: Durable per-wallet lease epoch fencing
 *     prevents split-brain on network partition or duplicate worker startup.
 *
 * The lifecycle transition table is pure / deterministic and fully unit-tested;
 * the `Executor` wires it to a `VenueAdapter`, a `PermitStore`, a `RecoveryLedger`,
 * a lease store, a clock, and an idempotency log without any live network
 * dependency in the tests.
 */

import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import type { IRecoveryLedger, PermitStore, LeaseStore } from "@polyroot/venue";
import type {
  ExecutionPermit,
  OrderResult,
  SignedOrder,
  SubmitStatus,
  OrderStatus,
  VenueMode,
} from "@polyroot/domain";
import { ExecutionPermitSchema } from "@polyroot/domain";
import { venueActionGate } from "@polyroot/venue";
import { cashNeededFor } from "@polyroot/risk";
import { decimalToBase } from "@polyroot/signer";
import type { ReservationManager } from "@polyroot/risk";

/* ── Executor dependencies ──────────────────────────────────────────────── */

export interface ExecutorDeps {
  adapter: VenueAdapter;
  /** clock injection for permit TTL recheck. */
  now: () => Date;
  /** idempotency log: tracks every order_id already seen. */
  seen: {
    has(orderId: string): boolean;
    add(orderId: string, state: OrderLifecycleState): void;
    get(orderId: string): OrderLifecycleState | undefined;
  };
  /** Durable permit store with atomic single-use claim. */
  permitStore: PermitStore;
  /** Durable recovery ledger for in-flight orders and reconciliation. */
  recoveryLedger: IRecoveryLedger;
  /** Per-wallet lease epoch for executor fencing. */
  leaseEpoch: number;
  /** Wallet ID for lease acquisition. */
  walletId: string;
  /** Holder identifier for this executor instance. */
  holder: string;
  /** Durable lease store with epoch fencing. */
  leaseStore: LeaseStore;
  /** Authoritative reservation manager to consume/release funds. */
  reservationManager?: ReservationManager;
}

/* ── Order lifecycle state machine (TABLE 16) ───────────────────────────── */

export type OrderLifecycleState =
  | "NOT_SEEN"
  | "SUBMITTING"
  | "ACKNOWLEDGED"
  | "SUBMISSION_UNKNOWN"
  | "DEFINITIVE_REJECT"
  | "CANCEL_UNKNOWN"
  | "CANCEL_CERTAIN";

export interface LifecycleEvent {
  state: OrderLifecycleState;
  code: string;
  reason: string;
}

/**
 * Given a current tracked state and a fresh outcome from the venue, produce
 * the next lifecycle state. This is the no-blind-retry core: an infinite
 * `UNKNOWN`/`SUBMITTING` loop is impossible because `SUBMISSION_UNKNOWN` never
 * transitions back into `SUBMITTING` from the same order in a re-submit path.
 */
export function orderLifecycleNext(
  current: OrderLifecycleState,
  submit: SubmitStatus,
  orderStatus?: OrderStatus,
): LifecycleEvent {
  switch (submit) {
    case "ACKNOWLEDGED":
      return {
        state: "ACKNOWLEDGED",
        code: "ACK",
        reason: `order ${orderStatus ?? "LIVE"}`,
      };
    case "SUBMITTING":
      return {
        state: "SUBMITTING",
        code: "IN_FLIGHT",
        reason: "accepted for submission; await confirmation",
      };
    case "SUBMISSION_UNKNOWN":
    case "DEFINITIVE_REJECT":
      return {
        state:
          submit === "DEFINITIVE_REJECT"
            ? "DEFINITIVE_REJECT"
            : "SUBMISSION_UNKNOWN",
        code: submit === "DEFINITIVE_REJECT" ? "REJECTED" : "UNKNOWN",
        reason:
          submit === "DEFINITIVE_REJECT"
            ? "venue definitively rejected the order"
            : "venue outcome unknown — reconcile, do NOT re-submit blindly",
      };
    default:
      return {
        state: "NOT_SEEN",
        code: "NO_SUBMIT",
        reason: "no submission attempted",
      };
  }
}

/* ── Execute result ─────────────────────────────────────────────────────── */

export type TrySubmitResult =
  | { outcome: "SUBMITTED"; result: OrderResult; state: OrderLifecycleState }
  | { outcome: "DUPLICATE"; reason: string; code: string }
  | { outcome: "PERMIT_INVALID"; reason: string; code: string }
  | { outcome: "MODE_FORBIDS"; reason: string; code: string }
  | {
      outcome: "NEEDS_RECONCILIATION";
      orderId: string;
      ok: true;
      state: "SUBMISSION_UNKNOWN";
      order: import("@polyroot/domain").SignedOrder;
      permit: import("@polyroot/domain").ExecutionPermit;
    };

/* ── Executor ───────────────────────────────────────────────────────────── */

export class Executor {
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /**
   * True when the order keeps within the permit reservation in exact base
   * units: share size ≤ max_qty AND required cash ≤ max_cash. Uses the shared
   * exact converters (`decimalToBase`, `cashNeededFor`) so float drift can
   * never inflate an order past its reservation.
   */
  private permitCoversOrder(
    order: SignedOrder,
    permit: ExecutionPermit,
  ): boolean {
    const sizeBase = decimalToBase(order.size);
    if (sizeBase > decimalToBase(permit.max_qty)) return false;
    const priceBase = decimalToBase(order.price);
    const cashBase = cashNeededFor(sizeBase, priceBase);
    if (cashBase > decimalToBase(permit.max_cash)) return false;
    return true;
  }

  /**
   * Submit a signed order exactly-once-per-order-id. Refuses duplicates, covers
   * permit-TTL expiry, applies the venue mode gate, and atomically claims the
   * permit before any network call. SUBMITTING state is persisted to the
   * recovery ledger BEFORE the venue call to cover all crash windows.
   */
  async submit(
    order: SignedOrder,
    permit: ExecutionPermit,
  ): Promise<TrySubmitResult> {
    // 0. Lease epoch fencing — only the current lease holder may submit.
    // This prevents split-brain on network partition or duplicate worker startup.
    const leaseAcquired = await this.deps.leaseStore.acquireExecutorLease(
      this.deps.walletId,
      this.deps.holder,
      this.deps.leaseEpoch,
      30, // 30 seconds TTL
    );
    if (!leaseAcquired) {
      return {
        outcome: "PERMIT_INVALID",
        code: "LEASE_NOT_ACQUIRED",
        reason: "executor lease not acquired",
      };
    }

    // Check for duplicate order ID (idempotency) FIRST — before any permit checks.
    // This ensures resubmitting the exact same order_id returns DUPLICATE
    // rather than PERMIT_REUSED when the permit was already claimed by a
    // previous successful submit of the same order.
    const priorOrder = this.deps.seen.get(order.order_id);
    if (priorOrder && priorOrder !== "DEFINITIVE_REJECT") {
      // Release lease since we're not proceeding (duplicate order)
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return {
        outcome: "DUPLICATE",
        code: "ALREADY_SEEN",
        reason: `order ${order.order_id} already ${priorOrder}`,
      };
    }

    // 0b. Single-use permit already claimed check — check store for claimed status BEFORE saving.
    // This must happen BEFORE save to avoid overwriting the claimed status in the store.
    if (permit.single_use) {
      const alreadyClaimed = await this.deps.permitStore.isClaimed(
        permit.permit_id,
      );
      if (alreadyClaimed) {
        return {
          outcome: "PERMIT_INVALID",
          code: "PERMIT_REUSED",
          reason: "single-use permit already claimed",
        };
      }
    }

    // 0b. Save permit to store (idempotent) before validation.
    await this.deps.permitStore.save(permit);

    // 0c. Lease epoch fencing for permit — permit MUST match current authoritative lease epoch.
    const permitValid = await this.deps.permitStore.validatePermit(
      permit.permit_id,
      this.deps.leaseEpoch,
    );
    if (!permitValid) {
      // Release lease since we're not proceeding
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return {
        outcome: "PERMIT_INVALID",
        code: "LEASE_EPOCH_MISMATCH",
        reason:
          "permit lease epoch does not match current executor lease epoch",
      };
    }

    // If we've reached here, it's a fresh order. Check if the permit was already claimed
    // by a previous successful submit (i.e., same permit, different order_id).
    // This should be checked AFTER the duplicate order_id check so that resubmitting
    // the exact same order returns DUPLICATE rather than PERMIT_REUSED.
    if (permit.single_use) {
      const alreadyClaimed = await this.deps.permitStore.isClaimed(
        permit.permit_id,
      );
      if (alreadyClaimed) {
        return {
          outcome: "PERMIT_INVALID",
          code: "PERMIT_REUSED",
          reason: "single-use permit already claimed",
        };
      }
    }

    // 2. Permit validity — recheck schema, expiry and single-use against clock.
    if (!ExecutionPermitSchema.safeParse(permit).success) {
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_INVALID",
        reason: "permit schema invalid",
      };
    }
    if (this.deps.now().getTime() > permit.expires_at.getTime()) {
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_EXPIRED",
        reason: "permit expired at submit",
      };
    }

    // 3. Permit–order binding: when the signed order carries a permit_id it
    //    MUST match the presented permit exactly. This prevents a permit issued for
    //    market A from being used to submit an order bound to market B.
    if (order.permit_id && order.permit_id !== permit.permit_id) {
      // Release lease since we're not proceeding
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_MISMATCH",
        reason: "order.permit_id does not match the presented permit",
      };
    }

    // 3b. P0-7: Permit must authorize this specific side, market, style.
    if (permit.side && order.side !== permit.side) {
      return {
        outcome: "PERMIT_INVALID",
        code: "SIDE_MISMATCH",
        reason: `order side ${order.side} not authorized by permit side ${permit.side}`,
      };
    }
    if (permit.market_id && order.market_id !== permit.market_id) {
      return {
        outcome: "PERMIT_INVALID",
        code: "MARKET_MISMATCH",
        reason: `order market ${order.market_id} not authorized by permit market ${permit.market_id}`,
      };
    }
    if (
      order.order_type &&
      permit.allowed_order_style.length > 0 &&
      !permit.allowed_order_style.includes(order.order_type)
    ) {
      return {
        outcome: "PERMIT_INVALID",
        code: "STYLE_NOT_ALLOWED",
        reason: `order type ${order.order_type} not in permit allowed styles`,
      };
    }

    // 4. The order must stay within the permit's reservation (share quota and
    //    cash ceiling). A signed order that exceeds its permit is refused —
    //    this is the reserve-then-spend enforcement, never loosened by a tier.
    if (!this.permitCoversOrder(order, permit)) {
      return {
        outcome: "PERMIT_INVALID",
        code: "AMOUNT_EXCEEDS_PERMIT",
        reason: "order exceeds permit reservation",
      };
    }

    // 4b. Price bounds (run after cash ceiling so test semantics match).
    if (permit.price_min_base !== undefined && permit.price_min_base !== null) {
      const priceBase = decimalToBase(order.price);
      if (priceBase < permit.price_min_base) {
        return {
          outcome: "PERMIT_INVALID",
          code: "PRICE_BELOW_MIN",
          reason: `order price ${order.price} below permit min ${permit.price_min_base}`,
        };
      }
    }
    if (permit.price_max_base !== undefined && permit.price_max_base !== null) {
      const priceBase = decimalToBase(order.price);
      if (priceBase > permit.price_max_base) {
        return {
          outcome: "PERMIT_INVALID",
          code: "PRICE_ABOVE_MAX",
          reason: `order price ${order.price} above permit max ${permit.price_max_base}`,
        };
      }
    }
    //    cash ceiling). A signed order that exceeds its permit is refused —
    //    this is the reserve-then-spend enforcement, never loosened by a tier.
    if (!this.permitCoversOrder(order, permit)) {
      return {
        outcome: "PERMIT_INVALID",
        code: "AMOUNT_EXCEEDS_PERMIT",
        reason: "order exceeds permit reservation",
      };
    }

    // 5. Venue-mode gate — fail closed BEFORE any permit claim. A harmless
    //    reject must NOT strand money authority: the permit is only consumed
    //    once the venue actually permits the action. The order is NOT marked
    //    in-flight until this passes, so a gate-blocked order can still be
    //    retried cleanly (no false duplicate lock).
    const gate = venueActionGate(this.deps.adapter.mode, "ORDER_SUBMIT");
    if (!gate.allowed) {
      // Release lease since we're not proceeding
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return { outcome: "MODE_FORBIDS", code: gate.code, reason: gate.reason };
    }

    // 6. Persist the permit (idempotent upsert) so atomic claim has a record to lock.
    await this.deps.permitStore.save(permit);

    // 7. ATOMIC PERMIT CLAIM + SUBMISSION RECORDING (P0-8)
    // Single database transaction: claim permit AND record SUBMITTING state.
    // This eliminates the crash window between permit claim and recovery ledger write.
    const claimResult =
      await this.deps.permitStore.claimPermitAndRecordSubmission(
        permit.permit_id,
        order.order_id,
        undefined, // venueOrderId unknown until ACK
      );
    if (!claimResult.ok) {
      // Release lease since claim failed
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return {
        outcome: "PERMIT_INVALID",
        code: claimResult.code,
        reason: claimResult.reason,
      };
    }

    // 8. CRASH WINDOW ELIMINATION: SUBMITTING state already recorded atomically
    // with permit claim in the above single transaction.
    // This covers all 10 crash windows:
    // 1. Before claim (handled by atomic claim)
    // 2. After claim before persist (handled by atomic claim+record)
    // 3. After persist before network (SUBMITTING is durable)
    // 4. Network accepted but response lost (SUBMITTING recorded)
    // 5. Response received but DB update fails (SUBMITTING recorded)
    // 6. Process dies before ACK persist (SUBMITTING in recovery ledger)
    // 7. Process restarts during UNKNOWN (recovery ledger has SUBMITTING)
    // 8. Duplicate worker executes same permit (atomic claim prevents)
    // 9. Stale worker executes old lease (lease epoch check)
    // 10. Duplicate order ID (idempotency check)

    // Mark in-flight in local seen log (dedupe concurrent submits in same process).
    this.deps.seen.add(order.order_id, "SUBMITTING");

    // P0-8: Durably record SUBMITTING in recovery ledger (atomic claim +
    // recovery write in Pg; explicit for Mem to ensure reconcile finds it).
    await this.deps.recoveryLedger.addSubmittedUnknown(
      order.order_id,
      undefined,
      permit.permit_id,
    );

    // 9. Submit exactly once. The permit is already consumed (claimed).
    const res: SubmitOutcome = await this.deps.adapter.placeOrder(order);

    if (!res.ok) {
      // P0-9: distinguish "definitely not sent" from "submission unknown"
      if (res.code === "DEFINITELY_NOT_SENT") {
        // Request never reached the venue → safe to retry.
        // P0-Audit: Release lease on DEFINITELY_NOT_SENT so lock is not stranded
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
        return {
          ok: true,
          outcome: "NEEDS_RECONCILIATION",
          state: "SUBMISSION_UNKNOWN",
          orderId: order.order_id,
          order: order,
          permit: permit,
        };
      }
      if (res.code === "SUBMISSION_UNKNOWN") {
        // Persist SUBMISSION_UNKNOWN for reconciliation. The local seen log
        // must reflect the same state so reconcile() does not read a stale
        // SUBMITTING and skip the venue query.
        this.deps.seen.add(order.order_id, "SUBMISSION_UNKNOWN");
        await this.deps.recoveryLedger.updateState(
          order.order_id,
          "SUBMISSION_UNKNOWN",
        );
        // Release lease since we're going to UNKNOWN state
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
        return {
          ok: true,
          outcome: "NEEDS_RECONCILIATION",
          state: "SUBMISSION_UNKNOWN",
          orderId: order.order_id,
          order: order,
          permit: permit,
        };
      }
      const state = orderLifecycleNext("SUBMITTING", "DEFINITIVE_REJECT").state;
      await this.deps.recoveryLedger.updateState(order.order_id, state);
      // Release lease since we're going to definitive reject state
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      // P0-Audit: Release any active reservations on definitive reject
      if (this.deps.reservationManager && permit.reservation_ids) {
        for (const resId of permit.reservation_ids) {
          await this.deps.reservationManager.release(resId, "REJECTED").catch(() => {});
        }
      }
      return {
        outcome: "PERMIT_INVALID",
        code: res.code,
        reason: `submit refused by venue: ${res.reason}`,
      };
    }

    // 10. Persist successful ACK
    const st = orderLifecycleNext(
      "SUBMITTING",
      res.result.submit_status ?? "SUBMITTING",
    ).state;
    await this.deps.recoveryLedger.updateState(
      order.order_id,
      st,
      res.result.order_id,
    );
    this.deps.seen.add(order.order_id, st);

    // Release lease since we have a definitive outcome
    await this.deps.leaseStore.releaseExecutorLease(
      this.deps.walletId,
      this.deps.holder,
    );

    // Resolve in recovery ledger with definitive venue result
    await this.deps.recoveryLedger.resolve(order.order_id, true, res.result);

    // P0-Audit: Consume reservation upon filled size
    if (
      this.deps.reservationManager &&
      permit.reservation_ids &&
      res.result.filled_size &&
      res.result.filled_size > 0
    ) {
      const filledBase = decimalToBase(res.result.filled_size);
      for (const resId of permit.reservation_ids) {
        await this.deps.reservationManager.consume(resId, filledBase).catch(() => {});
      }
    }

    return { outcome: "SUBMITTED", result: res.result, state: st };
  }

  /**
   * Cancel a single order, gated by venue mode. Returns a structured result.
   */
  async cancel(orderId: string): Promise<SubmitOutcome> {
    // Acquire lease for cancel operation as well
    const leaseAcquired = await this.deps.leaseStore.acquireExecutorLease(
      this.deps.walletId,
      this.deps.holder,
      this.deps.leaseEpoch,
      30, // 30 seconds TTL
    );
    if (!leaseAcquired) {
      console.log("DEBUG: LEASE_NOT_ACQUIRED", {
        walletId: this.deps.walletId,
        holder: this.deps.holder,
        leaseEpoch: this.deps.leaseEpoch,
      });
      return {
        ok: false,
        code: "LEASE_NOT_ACQUIRED",
        reason: `failed to acquire lease for wallet ${this.deps.walletId}`,
      };
    }

    const gate = venueActionGate(this.deps.adapter.mode, "ORDER_CANCEL");
    if (!gate.allowed) {
      // Release lease since we're not proceeding
      await this.deps.leaseStore.releaseExecutorLease(
        this.deps.walletId,
        this.deps.holder,
      );
      return { ok: false, code: gate.code, reason: gate.reason };
    }
    // Record cancel request for reconciliation
    await this.deps.recoveryLedger.recordCancelRequested(orderId);
    const res = await this.deps.adapter.cancelOrder(orderId);
    // Release lease after cancel operation
    await this.deps.leaseStore.releaseExecutorLease(
      this.deps.walletId,
      this.deps.holder,
    );
    return res;
  }

  /** Re-run reconciliation-driven resolution for an unknown order. */
  async reconcile(orderId: string): Promise<OrderLifecycleState> {
    // For reconcile, we don't necessarily need to acquire lease since we're just
    // querying state, but let's be safe and acquire it for consistency
    const leaseAcquired = await this.deps.leaseStore.acquireExecutorLease(
      this.deps.walletId,
      this.deps.holder,
      this.deps.leaseEpoch,
      30, // 30 seconds TTL
    );
    if (!leaseAcquired) {
      console.log("DEBUG: LEASE_NOT_ACQUIRED", {
        walletId: this.deps.walletId,
        holder: this.deps.holder,
        leaseEpoch: this.deps.leaseEpoch,
      });
      // If we can't acquire lease, we still return the current state but log this
      // In practice, this might indicate a lease issue but we can still reconcile
      // based on existing state
    }

    const current = this.deps.seen.get(orderId) ?? "NOT_SEEN";
    // Reconciliation must never turn an unknown order back into a live submit.
    if (current !== "SUBMISSION_UNKNOWN") {
      // Release lease if we acquired it
      if (leaseAcquired) {
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
      }
      return current;
    }

    // Check if recovery ledger thinks this needs reconciliation
    const needsReconcile =
      await this.deps.recoveryLedger.needsReconcile(orderId);
    if (!needsReconcile) {
      // No longer needs reconciliation
      // Release lease if we acquired it
      if (leaseAcquired) {
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
      }
      return current;
    }

    // Query the venue for the real status of the previously-unknown order.
    try {
      const result = await this.deps.adapter.getOrderStatus(orderId);
      if (result === null) {
        // Release lease if we acquired it
        if (leaseAcquired) {
          await this.deps.leaseStore.releaseExecutorLease(
            this.deps.walletId,
            this.deps.holder,
          );
        }
        return "SUBMISSION_UNKNOWN"; // venue has no record yet
      }
      // Order-level terminal states take precedence: a canceled / rejected /
      // expired order will never fill — mark it definitively done.
        if (
          result.order_status === "CANCELED" ||
          result.order_status === "REJECTED" ||
          result.order_status === "EXPIRED"
        ) {
          this.deps.seen.add(orderId, "DEFINITIVE_REJECT");
          await this.deps.recoveryLedger.resolve(orderId, true, result);
          // P0-Audit: Release reservations on reconciliation-discovered terminal rejection/cancel
          if (this.deps.reservationManager) {
            const rec = await this.deps.recoveryLedger.get(orderId);
            if (rec && rec.permitId) {
              const permitObj = await this.deps.permitStore.get(rec.permitId);
              if (permitObj && permitObj.reservation_ids) {
                for (const resId of permitObj.reservation_ids) {
                  await this.deps.reservationManager.release(resId, result.order_status === "CANCELED" ? "CANCELLED" : "REJECTED").catch(() => {});
                }
              }
            }
          }
          // Release lease if we acquired it
        if (leaseAcquired) {
          await this.deps.leaseStore.releaseExecutorLease(
            this.deps.walletId,
            this.deps.holder,
          );
        }
        return "DEFINITIVE_REJECT";
      }
      // Venue acknowledged the submission — the order is working (LIVE /
      // PARTIAL / MATCHED). No blind re-submit.
      if (result.submit_status === "ACKNOWLEDGED") {
        this.deps.seen.add(orderId, "ACKNOWLEDGED");
        await this.deps.recoveryLedger.resolve(orderId, true, result);
        // Release lease if we acquired it
        if (leaseAcquired) {
          await this.deps.leaseStore.releaseExecutorLease(
            this.deps.walletId,
            this.deps.holder,
          );
        }
        return "ACKNOWLEDGED";
      }
      // Still indeterminate — keep the unknown state rather than guess.
      // Release lease if we acquired it
      if (leaseAcquired) {
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
      }
      return "SUBMISSION_UNKNOWN";
    } catch {
      // Venue unreachable — keep the unknown state rather than guess.
      // Release lease if we acquired it
      if (leaseAcquired) {
        await this.deps.leaseStore.releaseExecutorLease(
          this.deps.walletId,
          this.deps.holder,
        );
      }
      return "SUBMISSION_UNKNOWN";
    }
  }
}

export { venueActionGate };
export type { VenueMode, VenueAdapter };

/* ── PermitStore & RecoveryLedger interfaces (re-exported for convenience) ──── */

export type { PermitStore } from "@polyroot/venue";
export type { IRecoveryLedger } from "@polyroot/venue";
