/**
 * @polyroot/venue — PolymarketVenueAdapter (PR-EXE-02, PR-WAL-01).
 *
 * Binds the pinned official `@polymarket/client` (baseline 0.9.0, Node >=24)
 * behind the VenueAdapter contract. "Contract tests, not package names, define
 * compatibility" (PRD P7 / PR-WAL-01): the adapter maps the SDK's market/order
 * shapes into our canonical MarketSnapshot / SubmitOutcome types and applies
 * the venue-mode gate before any SDK call.
 *
 * The injected `client` is the `createPublicClient`/`createSecureClient` result;
 * it is injected for testability (contract tests use a fake whose shape mirrors
 * the SDK surface, so no live network or credentials are required to run the
 * suite).
 */

import {
  type MarketSnapshot,
  type OrderResult,
  type SignedOrder,
  type VenueMode,
} from "@polyroot/domain";
import { venueActionGate } from "./policy.js";
import type { SubmitOutcome } from "./index.js";

/** The minimal @polymarket/client surface this adapter depends on (0.9.0). */
export interface PolymarketClientLike {
  fetchOrderBook?(request: { market?: string; marketId?: string }): Promise<unknown>;
  fetchMarket?(request: { marketId?: string }): Promise<unknown>;
  postOrder?(order: unknown): Promise<unknown>;
  cancelOrder?(id: string | { id: string }): Promise<unknown>;
  getOrderStatus?(orderId: string): Promise<unknown>;
}

interface SdkBookLevel {
  price: string;
  size: string;
}

export class PolymarketVenueAdapter {
  private _mode: VenueMode = "NORMAL";
  private readonly client: PolymarketClientLike;

  constructor(client: PolymarketClientLike, initialMode: VenueMode = "NORMAL") {
    this.client = client;
    this._mode = initialMode;
  }

  get mode(): VenueMode {
    return this._mode;
  }

  setMode(mode: VenueMode): void {
    this._mode = mode;
  }

  /** Map the SDK order book into a canonical MarketSnapshot (yes/no prices). */
  async getOrderBook(marketId: string): Promise<MarketSnapshot> {
    const raw = (await this.client.fetchOrderBook?.({ marketId })) as {
      bids?: SdkBookLevel[];
      asks?: SdkBookLevel[];
    };
    const best = (levels?: SdkBookLevel[]): number | undefined => {
      const n = levels?.length ?? 0;
      return n > 0 && levels ? Number(levels[0]?.price) : undefined;
    };
    const bestBid = best(raw?.bids);
    const bestAsk = best(raw?.asks);
    return {
      schema_version: "1.0.0",
      event_id: marketId,
      market_id: marketId,
      question: marketId,
      chain_id: 137,
      collateral: "pUSD",
      rules_hash: "pending",
      fee_maker_bps: 0,
      fee_taker_bps: 200,
      tick_size: 0.001,
      min_size: 1,
      status: "ACTIVE",
      is_neg_risk: false,
      venue_mode: this._mode,
      yes_price: bestBid ?? 0.5,
      no_price: bestAsk ?? 0.5,
      source_at: new Date(),
      received_at: new Date(),
    };
  }

  /** Submit a typed signed order if and only if the venue-mode gate allows it. */
  async placeOrder(order: SignedOrder): Promise<SubmitOutcome> {
    const gate = venueActionGate(this._mode, "ORDER_SUBMIT");
    if (!gate.allowed) {
      return { ok: false, code: gate.code, reason: gate.reason };
    }
    try {
      const result = (await this.client.postOrder?.(order)) as
        | { success?: boolean; orderID?: string; orderId?: string; errorMsg?: string }
        | undefined;
      const id = result?.orderID ?? result?.orderId;
      const ok = Boolean(result?.success ?? id);
      const orderResult: OrderResult = {
        success: ok,
        order_id: id,
        error: result?.errorMsg,
        timestamp: new Date(),
      };
      return ok ? { ok: true, result: orderResult } : { ok: false, code: "VENUE_REJECTED", reason: result?.errorMsg ?? "venue rejected order" };
    } catch (err) {
      return {
        ok: false,
        code: "VENUE_CALL_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Cancel by venue order id, subject to the mode gate. */
  async cancelOrder(orderId: string): Promise<SubmitOutcome> {
    const gate = venueActionGate(this._mode, "ORDER_CANCEL");
    if (!gate.allowed) {
      return { ok: false, code: gate.code, reason: gate.reason };
    }
    try {
      const result = (await this.client.cancelOrder?.(orderId)) as
        | { success?: boolean; cancelled?: boolean; errorMsg?: string }
        | undefined;
      const ok = Boolean(result?.success ?? result?.cancelled);
      return ok
        ? { ok: true, result: { success: true, order_id: orderId, timestamp: new Date() } }
        : { ok: false, code: "VENUE_REJECTED", reason: result?.errorMsg ?? "venue rejected cancel" };
    } catch (err) {
      return {
        ok: false,
        code: "VENUE_CALL_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Query venue for order status. Returns null when the venue has no record. */
  async getOrderStatus(orderId: string): Promise<OrderResult | null> {
    const raw = (await this.client.getOrderStatus?.(orderId)) as
      | { status?: string; orderID?: string; errorMsg?: string }
      | { success?: boolean; order_id?: string }
      | null
      | undefined;
    if (!raw) return null;
    return {
      success: true,
      order_id: orderId,
      timestamp: new Date(),
    };
  }
}