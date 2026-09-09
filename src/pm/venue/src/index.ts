/**
 * @polyroot/venue — Polymarket venue adapter (wraps @polymarket/client)
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { MarketSnapshot, SignedOrder, OrderResult } from "@polyroot/domain";

/** Placeholder for VenueAdapter — to be implemented */
export interface VenueAdapter {
  getOrderBook(marketId: string): Promise<unknown>;
  placeOrder(order: SignedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<unknown>;
}

/** Placeholder for ClobAdapter — to be implemented */
export interface ClobAdapter extends VenueAdapter {}

/** Placeholder for NegRiskAdapter — to be implemented */
export interface NegRiskAdapter extends VenueAdapter {}
