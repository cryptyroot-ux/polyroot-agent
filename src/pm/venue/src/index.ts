/**
 * @polyroot/venue — Polymarket VenueAdapter (PM-EXE-01..08, Blueprint B10 / TABLE 15/17).
 *
 * The VenueAdapter is the **only** boundary that talks to the trading venue.
 * It accepts only typed, canonical `SignedOrder` / cancel id requests — never
 * arbitrary calldata, never a raw SDK payload improvised by the strategy layer.
 *
 * Fail-closed by construction: a `VenueActionGate` decides whether an action is
 * legal in the current venue mode **before** any network call. If the mode is
 * `CANCEL_ONLY`, `READ_ONLY`, `UNAVAILABLE` or `UNKNOWN`, new orders are
 * refused; cancels remain legal except under `READ_ONLY`/`UNAVAILABLE`. This keeps the
 * adapter deterministic and unit-testable without a live network.
 */

import type {
  AccountMode,
  MarketSnapshot,
  OrderResult,
  SignedOrder,
  VenueCapability,
  VenueMode,
} from "@polyroot/domain";

export type {
  AccountMode,
  MarketSnapshot,
  OrderResult,
  SignedOrder,
  VenueCapability,
};

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
  /** Query the venue for the current status of a submitted order. Returns null if the venue has no record. */
  getOrderStatus(orderId: string): Promise<OrderResult | null>;
  /** Set the current operational mode (narrowed by the supervisor). */
  setMode(mode: VenueMode): void;
}

// Venue-mode gate, capability intersection, error taxonomy, throttling,
// recovery (PM-VENUE-01..06)
export * from "./policy.js";
