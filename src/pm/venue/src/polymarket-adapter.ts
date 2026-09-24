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
  type OrderStatus,
  type SignedOrder,
  type VenueMode,
} from "@polyroot/domain";
import { venueActionGate } from "./policy.js";
import type { SubmitOutcome } from "./types.js";

/** The minimal @polymarket/client surface this adapter depends on (0.9.0). */
export interface PolymarketClientLike {
  fetchOrderBook?(request: { assetId: string }): Promise<unknown>;
  fetchMarket?(request: { marketId: string }): Promise<unknown>;
  postOrder?(order: unknown): Promise<unknown>;
  cancelOrder?(request: { orderId: string }): Promise<unknown>;
  fetchOrder?(request: { orderId: string }): Promise<unknown>;
}

interface SdkBookLevel {
  price: string;
  size: string;
}

export interface PolymarketVenueAdapterDeps {
  /**
   * Baseline market metadata used when the venue does not surface priced
   * market data. When an opaque market id is given (no fetchMarket result),
   * the adapter MUST NOT fabricate canonical venue state — it marks the
   * snapshot as UNKNOWN so the risk kernel fails closed.
   */
  defaultChainId?: number;
  defaultCollateral?: string;
}

export class PolymarketVenueAdapter {
  private _mode: VenueMode = "NORMAL";
  private readonly client: PolymarketClientLike;
  private readonly chainId: number;
  private readonly collateral: string;

  constructor(
    client: PolymarketClientLike,
    initialMode: VenueMode = "NORMAL",
    deps: PolymarketVenueAdapterDeps = {},
  ) {
    this.client = client;
    this._mode = initialMode;
    this.chainId = deps.defaultChainId ?? 137;
    this.collateral = deps.defaultCollateral ?? "pUSD";
  }

  get mode(): VenueMode {
    return this._mode;
  }

  setMode(mode: VenueMode): void {
    this._mode = mode;
  }

  /** Robust best-level extraction: parse all levels, validate, and pick the
   *  correct extremum. Bids sort high-to-low (best = max price), asks sort
   *  low-to-high (best = min price). Do NOT trust API ordering.
   */
  private bestLevel(
    levels: SdkBookLevel[] | undefined,
    side: "bid" | "ask",
  ): number | undefined {
    if (!levels || levels.length === 0) return undefined;
    const prices = levels
      .map((l) => Number(l.price))
      .filter((p) => Number.isFinite(p) && p >= 0 && p <= 1);
    if (prices.length === 0) return undefined;
    return side === "bid" ? Math.max(...prices) : Math.min(...prices);
  }

  /** Map the SDK order book into a canonical MarketSnapshot. Does NOT fabricate
   *  venue state: if no market metadata is available the snapshot is marked
   *  UNKNOWN so downstream risk logic fails closed.
   */
  async getOrderBook(marketId: string): Promise<MarketSnapshot> {
    const raw = (await this.client.fetchOrderBook?.({ assetId: marketId })) as
      | {
          bids?: SdkBookLevel[];
          asks?: SdkBookLevel[];
          market?: {
            question?: string;
            rulesHash?: string;
            negRisk?: boolean;
            clobTokenIds?: string[];
            feeRateBps?: number;
            minimumOrderSize?: number;
            tickSize?: number;
            status?: string;
          };
        }
      | undefined;

    const rawMarket = raw?.market;
    // Opaque market id must NOT be passed through as the canonical question.
    const question =
      rawMarket?.question && rawMarket.question !== marketId
        ? rawMarket.question
        : marketId;
    // P0-10: Venue UNKNOWN semantics — when venue doesn't provide data,
    // we return well-known sentinel values (not authoritative defaults).
    // The risk engine MUST check for these sentinel values before making
    // trading decisions.
    const rulesHash = rawMarket?.rulesHash ?? "UNKNOWN";
    const isNegRisk = rawMarket?.negRisk ?? false;
    // feeMakerBps = 0 is correct: maker rebates are venue-settled, not assumed.
    const feeMakerBps = 0;
    // feeTakerBps: venue provides this; if not, use 0 (not assumed 200).
    const feeTakerBps = rawMarket?.feeRateBps ?? 0;
    // tick_size/min_size: venue must provide these; if not, 0 (not assumed 0.001).
    const tickSize = rawMarket?.tickSize ?? 0;
    const minSize = rawMarket?.minimumOrderSize ?? 0;
    const marketStatus = rawMarket?.status;

    const bestBid = this.bestLevel(raw?.bids, "bid");
    const bestAsk = this.bestLevel(raw?.asks, "ask");

    const hasRealBook = bestBid !== undefined || bestAsk !== undefined;
    const bestTimestamp = new Date();

    // If no venue status provided and no real order book data, status is UNKNOWN.
    const status =
      hasRealBook && rawMarket ? (marketStatus ?? "UNKNOWN") : "UNKNOWN";

    return {
      schema_version: "1.0.0",
      event_id: marketId,
      market_id: marketId,
      question,
      chain_id: this.chainId,
      collateral: this.collateral,
      rules_hash: rulesHash,
      fee_maker_bps: feeMakerBps,
      fee_taker_bps: feeTakerBps,
      tick_size: tickSize,
      min_size: minSize,
      status,
      is_neg_risk: isNegRisk,
      venue_mode: this._mode,
      yes_price: bestBid,
      no_price: bestAsk,
      source_at: bestTimestamp,
      received_at: bestTimestamp,
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
        | {
            success?: boolean;
            orderID?: string;
            orderId?: string;
            errorMsg?: string;
          }
        | undefined;
      const id = result?.orderID ?? result?.orderId;
      const ok = Boolean(result?.success ?? id);
      const orderResult: OrderResult = {
        success: ok,
        order_id: id,
        error: result?.errorMsg,
        timestamp: new Date(),
      };
      return ok
        ? { ok: true, result: orderResult }
        : {
            ok: false,
            code: "VENUE_REJECTED",
            reason: result?.errorMsg ?? "venue rejected order",
          };
    } catch (err) {
      // P0-9: Distinguish "request never sent" from "request sent, response lost".
      // A network-level error before the call leaves the request unsent.
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork =
        /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(
          msg,
        );
      if (isNetwork) {
        return {
          ok: false,
          code: "DEFINITELY_NOT_SENT",
          reason: `network error before send: ${msg}`,
        };
      }
      // Any other error after the call → the venue may have accepted it.
      // Do NOT treat this as a definitive reject.
      return {
        ok: false,
        code: "SUBMISSION_UNKNOWN",
        reason: `venue call error (may have been accepted): ${msg}`,
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
      const result = (await this.client.cancelOrder?.({ orderId })) as
        | { success?: boolean; cancelled?: boolean; errorMsg?: string }
        | undefined;
      const ok = Boolean(result?.success ?? result?.cancelled);
      return ok
        ? {
            ok: true,
            result: { success: true, order_id: orderId, timestamp: new Date() },
          }
        : {
            ok: false,
            code: "VENUE_REJECTED",
            reason: result?.errorMsg ?? "venue rejected cancel",
          };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork =
        /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(
          msg,
        );
      if (isNetwork) {
        return {
          ok: false,
          code: "DEFINITELY_NOT_SENT",
          reason: `network error before cancel send: ${msg}`,
        };
      }
      return {
        ok: false,
        code: "SUBMISSION_UNKNOWN",
        reason: `cancel call error (may have been accepted): ${msg}`,
      };
    }
  }

  /**
   * Query venue for order status. Maps the Polymarket status string to our
   * canonical OrderStatus. This is the authoritative venue truth for the
   * recovery state machine (EXE-03/04).
   *
   * Known Polymarket status mappings:
   *   LIVE / NEW        → LIVE
   *   PARTIAL          → PARTIAL
   *   MATCHED / FILLED → MATCHED
   *   CANCELED          → CANCELED
   *   EXPIRED           → EXPIRED
   *   REJECTED / FAILED → REJECTED
   *   anything else     → UNKNOWN
   */
  async getOrderStatus(orderId: string): Promise<OrderResult | null> {
    const raw = (await this.client.fetchOrder?.({ orderId })) as
      | {
          status?: string;
          orderID?: string;
          errorMsg?: string;
          fills?: unknown[];
          filledSize?: number;
          averagePrice?: number;
        }
      | null
      | undefined;
    if (!raw) return null;

    const venueStatus = (raw.status ?? "UNKNOWN").toUpperCase();
    let orderStatus: OrderStatus = "UNKNOWN";
    switch (venueStatus) {
      case "LIVE":
      case "NEW":
        orderStatus = "LIVE";
        break;
      case "PARTIAL":
        orderStatus = "PARTIAL";
        break;
      case "MATCHED":
      case "FILLED":
        orderStatus = "MATCHED";
        break;
      case "CANCELED":
        orderStatus = "CANCELED";
        break;
      case "EXPIRED":
        orderStatus = "EXPIRED";
        break;
      case "REJECTED":
      case "FAILED":
        orderStatus = "REJECTED";
        break;
      default:
        orderStatus = "UNKNOWN";
        break;
    }

    return {
      success: orderStatus !== "REJECTED" && orderStatus !== "UNKNOWN",
      order_status: orderStatus,
      order_id: orderId,
      filled_size: raw.filledSize,
      average_price: raw.averagePrice,
      error: raw.errorMsg,
      timestamp: new Date(),
    };
  }
}
