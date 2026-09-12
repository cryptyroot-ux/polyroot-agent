/**
 * @polyroot/venue — Adapter contract types (PR-EXE-02).
 * Defined here (not in index.ts) to avoid circular runtime imports between
 * index.ts and the concrete adapter implementations.
 */

import type { MarketSnapshot, OrderResult, SignedOrder, VenueMode } from "@polyroot/domain";

export type { MarketSnapshot, OrderResult, SignedOrder, VenueMode };

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
  getOrderBook(marketId: string): Promise<MarketSnapshot>;
  placeOrder(order: SignedOrder): Promise<SubmitOutcome>;
  cancelOrder(orderId: string): Promise<SubmitOutcome>;
  getOrderStatus(orderId: string): Promise<OrderResult | null>;
  setMode(mode: VenueMode): void;
}