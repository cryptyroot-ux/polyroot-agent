/**
 * @polyroot/venue — Polymarket VenueAdapter (PR-EXE-01..08, Blueprint B10 / TABLE 15/17).
 *
 * The VenueAdapter is the **only** boundary that talks to the trading venue.
 * It accepts only typed, canonical `SignedOrder` / cancel id requests — never
 * arbitrary calldata, never a raw SDK payload improvised by the strategy layer.
 *
 * Fail-closed by construction: a `VenueActionGate` decides whether an action is
 * legal in the current venue mode **before** any network call. If the mode is
 * `CANCEL_ONLY`, `RESTARTING`, `UNAVAILABLE` or `UNKNOWN`, new orders are
 * refused; cancels remain legal except under `UNAVAILABLE`. This keeps the
 * adapter deterministic and unit-testable without a live network.
 */

import type {
  MarketSnapshot,
  OrderResult,
  SignedOrder,
  VenueMode,
} from "@polyroot/domain";

export type { MarketSnapshot, OrderResult, SignedOrder };

/** Venue actions the adapter is responsible for gating (TABLE 17 matrix). */
export type VenueAction = "ORDER_SUBMIT" | "ORDER_CANCEL" | "READ";

export interface VenueDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

/**
 * Venue-mode action matrix (TABLE 17). Fail-closed: any mode that does not
 * explicitly permit an action refuses it.
 */
const MODE_MATRIX: Record<VenueMode, Record<VenueAction, boolean>> = {
  NORMAL: { ORDER_SUBMIT: true, ORDER_CANCEL: true, READ: true },
  POST_ONLY: { ORDER_SUBMIT: true, ORDER_CANCEL: true, READ: true },
  CANCEL_ONLY: { ORDER_SUBMIT: false, ORDER_CANCEL: true, READ: true },
  RESTARTING: { ORDER_SUBMIT: false, ORDER_CANCEL: true, READ: true },
  UNAVAILABLE: { ORDER_SUBMIT: false, ORDER_CANCEL: false, READ: true },
  UNKNOWN: { ORDER_SUBMIT: false, ORDER_CANCEL: false, READ: false },
};

/** Pure venue-mode gate — deterministic and fully testable. */
export function venueActionGate(
  mode: VenueMode,
  action: VenueAction,
): VenueDecision {
  const permitted = MODE_MATRIX[mode]?.[action] ?? false;
  if (permitted) {
    return {
      allowed: true,
      code: "ALLOWED",
      reason: `${action} legal in ${mode}`,
    };
  }
  return {
    allowed: false,
    code: "MODE_FORBIDS",
    reason: `${action} not permitted in venue mode ${mode}`,
  };
}

/** A single low-level, venular call outcome. */
export type SubmitOutcome =
  | { ok: true; result: OrderResult }
  | { ok: false; code: string; reason: string };

/**
 * VenueAdapter capability contract. Every implementation MUST:
 *  - refuse any request whose venue mode forbids the action (`venueActionGate`);
 *  - narrow `SignedOrder` submission to the canonical type (no arbitrary bytes);
 *  - treat an ACK as "not a fill" and return structured `OrderResult`.
 */
export interface VenueAdapter {
  readonly mode: VenueMode;
  /** Return a fresh market snapshot scoped to a market id. */
  getOrderBook(marketId: string): Promise<MarketSnapshot>;
  /** Submit a typed signed order if and only if the mode gate allows it. */
  placeOrder(order: SignedOrder): Promise<SubmitOutcome>;
  /** Cancel by venue order id, subject to the mode gate. */
  cancelOrder(orderId: string): Promise<SubmitOutcome>;
  /** Set the current operational mode (narrowed by the supervisor). */
  setMode(mode: VenueMode): void;
}
