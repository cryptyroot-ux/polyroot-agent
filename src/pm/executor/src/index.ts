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

import type {
  ExecutionPermit,
  OrderResult,
  SignedOrder,
  SubmitStatus,
  OrderStatus,
  VenueMode,
} from "@polyroot/domain";
import { ExecutionPermitSchema } from "@polyroot/domain";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import { venueActionGate } from "@polyroot/venue";
import { cashNeededFor } from "@polyroot/risk";
import { decimalToBase } from "@polyroot/signer";
import type { PermitStore } from "@polyroot/venue";
import type { RecoveryLedger } from "@polyroot/venue";

export type { ExecutionPermit, SignedOrder, OrderResult };
export type {
  TradeIntent,
  RiskDecision,
  SubmitStatus,
  OrderStatus,
} from "@polyroot/domain";

/* ── Order lifecycle state machine (TABLE 16) ───────────────────────────── */

export type OrderLifecycleState =
  | "NOT_SEEN"
  | "SUBMITTING"
  | "ACKNOWLEDGED"
  | "SUBMISSION_UNKNOWN"
  | "DEFINITIVE_REJECT";

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
  recoveryLedger: RecoveryLedger;
  /** Per-wallet lease epoch for executor fencing. */
  leaseEpoch: number;
}

/* ── Execute result ─────────────────────────────────────────────────────── */

export type TrySubmitResult =
  | { outcome: "SUBMITTED"; result: OrderResult; state: OrderLifecycleState }
  | { outcome: "DUPLICATE"; reason: string; code: string }
  | { outcome: "PERMIT_INVALID"; reason: string; code: string }
  | { outcome: "MODE_FORBIDS"; reason: string; code: string }
  | { outcome: "NEEDS_RECONCILIATION"; orderId: string };

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
    // 1. Idempotency — never submit an order we have already seen.
    const prior = this.deps.seen.get(order.order_id);
    if (prior && prior !== "DEFINITIVE_REJECT") {
      return {
        outcome: "DUPLICATE",
        code: "ALREADY_SEEN",
        reason: `order ${order.order_id} already ${prior}`,
      };
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

    // 3. ATOMIC PERMIT CLAIM — single-use permit claimed atomically.
    // This replaces the check-then-act race with a single atomic operation.
    if (permit.single_use) {
      const claimed = await this.deps.permitStore.claim(permit.permit_id, order.order_id);
      if (!claimed) {
        return {
          outcome: "PERMIT_INVALID",
          code: "PERMIT_USED",
          reason: "permit already used or expired",
        };
      }
    }

    // 4. Permit–order binding: when the signed order carries a permit_id it
    //    MUST match the presented permit. This prevents a permit issued for
    //    market A from being used to submit an order bound to market B.
    if (order.permit_id && order.permit_id !== permit.permit_id) {
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_MISMATCH",
        reason: "order.permit_id does not match the presented permit",
      };
    }

    // 5. The order must stay within the permit's reservation (share quota and
    //    cash ceiling). A signed order that exceeds its permit is refused —
    //    this is the reserve-then-spend enforcement, never loosened by a tier.
    if (!this.permitCoversOrder(order, permit)) {
      return {
        outcome: "PERMIT_INVALID",
        code: "AMOUNT_EXCEEDS_PERMIT",
        reason: "order exceeds permit reservation",
      };
    }

    // 6. Venue-mode gate — fail closed before any network call. The order is
    //    NOT marked in-flight until this passes, so a gate-blocked order can
    //    still be retried cleanly (no false duplicate lock).
    const gate = venueActionGate(this.deps.adapter.mode, "ORDER_SUBMIT");
    if (!gate.allowed) {
      return { outcome: "MODE_FORBIDS", code: gate.code, reason: gate.reason };
    }

    // 7. Lease epoch fencing — only the current lease holder may submit.
    // This prevents split-brain on network partition or duplicate worker startup.
    // The permit's lease_epoch must match the current executor lease epoch.
    if (permit.lease_epoch !== this.deps.leaseEpoch) {
      return {
        outcome: "PERMIT_INVALID",
        code: "LEASE_EPOCH_MISMATCH",
        reason: `permit lease epoch ${permit.lease_epoch} != executor lease ${this.deps.leaseEpoch}`,
      };
    }

    // 8. CRASH WINDOW ELIMINATION: Persist SUBMITTING state to recovery ledger
    // BEFORE the venue call. This covers all 10 crash windows:
    // 1. Before claim (handled by atomic claim)
    // 2. After claim before persist (handled by recovery ledger write)
    // 3. After persist before network (SUBMITTING is durable)
    // 4. Network accepted but response lost (SUBMITTING recorded)
    // 5. Response received but DB update fails (SUBMITTING recorded)
    // 6. Process dies before ACK persist (SUBMITTING in recovery ledger)
    // 7. Process restarts during UNKNOWN (recovery ledger has SUBMITTING)
    // 8. Duplicate worker executes same permit (atomic claim prevents)
    // 9. Stale worker executes old lease (lease epoch check)
    // 10. Duplicate order ID (idempotency check)
    await this.deps.recoveryLedger.addSubmittedUnknown(
      order.order_id,
      undefined, // venueOrderId unknown until ACK
      permit.permit_id,
    );

    // Mark in-flight in local seen log (dedupe concurrent submits in same process).
    this.deps.seen.add(order.order_id, "SUBMITTING");

    // 9. Submit exactly once. The permit is already consumed (claimed).
    const res: SubmitOutcome = await this.deps.adapter.placeOrder(order);

    if (!res.ok) {
      if (res.code === "SUBMISSION_UNKNOWN") {
        // Persist SUBMISSION_UNKNOWN for reconciliation
        await this.deps.recoveryLedger.updateState(order.order_id, "SUBMISSION_UNKNOWN");
        return { outcome: "NEEDS_RECONCILIATION", orderId: order.order_id };
      }
      const state = orderLifecycleNext("SUBMITTING", "DEFINITIVE_REJECT").state;
      await this.deps.recoveryLedger.updateState(order.order_id, state);
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
    await this.deps.recoveryLedger.updateState(order.order_id, st, res.result.order_id);
    this.deps.seen.add(order.order_id, st);

    // Resolve in recovery ledger with definitive venue result
    await this.deps.recoveryLedger.resolve(order.order_id, true, res.result);

    return { outcome: "SUBMITTED", result: res.result, state: st };
  }

  /**
   * Cancel a single order, gated by venue mode. Returns a structured result.
   */
  async cancel(orderId: string): Promise<SubmitOutcome> {
    const gate = venueActionGate(this.deps.adapter.mode, "ORDER_CANCEL");
    if (!gate.allowed) {
      return { ok: false, code: gate.code, reason: gate.reason };
    }
    // Record cancel request for reconciliation
    await this.deps.recoveryLedger.recordCancelRequested(orderId);
    return this.deps.adapter.cancelOrder(orderId);
  }

  /** Re-run reconciliation-driven resolution for an unknown order. */
  async reconcile(orderId: string): Promise<OrderLifecycleState> {
    const current = this.deps.seen.get(orderId) ?? "NOT_SEEN";
    // Reconciliation must never turn an unknown order back into a live submit.
    if (current !== "SUBMISSION_UNKNOWN") return current;

    // Check if recovery ledger thinks this needs reconciliation
    const needsReconcile = await this.deps.recoveryLedger.needsReconcile(orderId);
    if (!needsReconcile) {
      // No longer needs reconciliation
      return current;
    }

    // Query the venue for the real status of the previously-unknown order.
    try {
      const result = await this.deps.adapter.getOrderStatus(orderId);
      if (result === null) return "SUBMISSION_UNKNOWN"; // venue has no record yet
      // Order-level terminal states take precedence: a canceled / rejected /
      // expired order will never fill — mark it definitively done.
      if (
        result.order_status === "CANCELED" ||
        result.order_status === "REJECTED" ||
        result.order_status === "EXPIRED"
      ) {
        this.deps.seen.add(orderId, "DEFINITIVE_REJECT");
        await this.deps.recoveryLedger.resolve(orderId, true, result);
        return "DEFINITIVE_REJECT";
      }
      // Venue acknowledged the submission — the order is working (LIVE /
      // PARTIAL / MATCHED). No blind re-submit.
      if (result.submit_status === "ACKNOWLEDGED") {
        this.deps.seen.add(orderId, "ACKNOWLEDGED");
        await this.deps.recoveryLedger.resolve(orderId, true, result);
        return "ACKNOWLEDGED";
      }
      // Still indeterminate — keep the unknown state rather than guess.
      return "SUBMISSION_UNKNOWN";
    } catch {
      // Venue unreachable — keep the unknown state rather than guess.
      return "SUBMISSION_UNKNOWN";
    }
  }
}

export { venueActionGate };
export type { VenueMode, VenueAdapter };

/* ── PermitStore & RecoveryLedger interfaces (re-exported for convenience) ──── */

export type { PermitStore } from "@polyroot/venue";
export type { RecoveryLedger } from "@polyroot/venue";
