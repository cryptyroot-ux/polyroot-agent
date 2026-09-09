/**
 * @polyroot/executor — Executor core (PR-EXE-01..08, Blueprint B10/B11 / TABLE 16).
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
 *     by the venue-mode matrix (CANCEL_ONLY/RESTARTING permit cancels).
 *
 * The lifecycle transition table is pure / deterministic and fully unit-tested;
 * the `Executor` wires it to a `VenueAdapter`, a submit-idempotency log and a
 * clock without any live network dependency in the tests.
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

/* ── Executor ───────────────────────────────────────────────────────────── */

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
  /** single-use permit consumed on first (re)submit attempt. */
  markPermitUsed(permitId: string, orderId: string): Promise<void>;
  isPermitUsed(permitId: string): Promise<boolean>;
}

export type TrySubmitResult =
  | { outcome: "SUBMITTED"; result: OrderResult; state: OrderLifecycleState }
  | { outcome: "DUPLICATE"; reason: string; code: string }
  | { outcome: "PERMIT_INVALID"; reason: string; code: string }
  | { outcome: "MODE_FORBIDS"; reason: string; code: string }
  | { outcome: "NEEDS_RECONCILIATION"; orderId: string };

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
   * permit-TTL expiry, and applies the venue mode gate before any network call.
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
    if (permit.single_use && (await this.deps.isPermitUsed(permit.permit_id))) {
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_USED",
        reason: "permit already used",
      };
    }

    // 3. Permit–order binding: when the signed order carries a permit_id it
    //    MUST match the presented permit. This prevents a permit issued for
    //    market A from being used to submit an order bound to market B.
    if (order.permit_id && order.permit_id !== permit.permit_id) {
      return {
        outcome: "PERMIT_INVALID",
        code: "PERMIT_MISMATCH",
        reason: "order.permit_id does not match the presented permit",
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

    // 5. Venue-mode gate — fail closed before any network call. The order is
    //    NOT marked in-flight until this passes, so a gate-blocked order can
    //    still be retried cleanly (no false duplicate lock).
    const gate = venueActionGate(this.deps.adapter.mode, "ORDER_SUBMIT");
    if (!gate.allowed) {
      return { outcome: "MODE_FORBIDS", code: gate.code, reason: gate.reason };
    }

    // Mark in-flight right before the network call (dedupe concurrent submits).
    this.deps.seen.add(order.order_id, "SUBMITTING");

    // 6. Submit exactly once. Consume the permit regardless of outcome (a used
    //    single-use permit must never be reusable for a re-submit).
    const res: SubmitOutcome = await this.deps.adapter.placeOrder(order);
    await this.deps.markPermitUsed(permit.permit_id, order.order_id);

    if (!res.ok) {
      if (res.code === "SUBMISSION_UNKNOWN") {
        this.deps.seen.add(order.order_id, "SUBMISSION_UNKNOWN");
        return { outcome: "NEEDS_RECONCILIATION", orderId: order.order_id };
      }
      const state = orderLifecycleNext("SUBMITTING", "DEFINITIVE_REJECT").state;
      this.deps.seen.add(order.order_id, state);
      return {
        outcome: "PERMIT_INVALID",
        code: res.code,
        reason: `submit refused by venue: ${res.reason}`,
      };
    }

    const st = orderLifecycleNext(
      "SUBMITTING",
      res.result.submit_status ?? "SUBMITTING",
    ).state;
    this.deps.seen.add(order.order_id, st);
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
    return this.deps.adapter.cancelOrder(orderId);
  }

  /** Re-run reconciliation-driven resolution for an unknown order. */
  async reconcile(orderId: string): Promise<OrderLifecycleState> {
    const current = this.deps.seen.get(orderId) ?? "NOT_SEEN";
    // Reconciliation must never turn an unknown order back into a live submit.
    if (current !== "SUBMISSION_UNKNOWN") return current;

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
        return "DEFINITIVE_REJECT";
      }
      // Venue acknowledged the submission — the order is working (LIVE /
      // PARTIAL / MATCHED). No blind re-submit.
      if (result.submit_status === "ACKNOWLEDGED") {
        this.deps.seen.add(orderId, "ACKNOWLEDGED");
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
