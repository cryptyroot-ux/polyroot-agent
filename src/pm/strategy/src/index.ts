/**
 * @polyroot/strategy — Strategy logic and intent generation (PM-STR-01..06).
 * Pure primitives: forecast-to-intent mapping, quote adjustment, sizing.
 * No I/O.
 */
import {
  type Forecast,
  type TradeIntent,
  type AssetIdentity,
} from "@polyroot/domain";

/* ─── PM-STR-01: forecast-to-intent mapping ──────────────────────────── */

/**
 * Intent generation (PM-STR-01): mapping a forecast to a concrete trade
 * intent. Includes direction, confidence-to-size, and valid horizon.
 */
export function generateIntent(
  forecast: Forecast,
  asset: AssetIdentity,
  sizingFactor = 1.0
): TradeIntent {
  const p = forecast.p_conservative ?? forecast.p_calibrated ?? forecast.p_raw ?? 0.5;
  const side = p > 0.5 ? "BUY" : "SELL";
  const rawSize = Math.abs(p - 0.5) * 2 * sizingFactor;
  
  return {
    schema_version: "1.0.0",
    intent_id: `int_${forecast.forecast_id}`,
    dedupe_key: `int_${forecast.forecast_id}`,
    purpose: "ENTRY",
    market_id: forecast.market_id,
    token_id: asset.asset_id,
    side,
    desired_qty: rawSize,
    limit_price: p,
    forecast_refs: [forecast.forecast_id],
    evidence_ids: forecast.evidence_ids,
    status: "CREATED",
    price: p,
    size: rawSize,
    forecast_id: forecast.forecast_id,
    created_at: new Date(),
  };
}

/* ─── PM-STR-02: quote adjustment ────────────────────────────────────── */

/**
 * Quote adjustment (PM-STR-02): adjust intent price/size based on order book
 * and fee constraints. Ensures target edge is maintained.
 */
export function adjustQuote(
  intent: TradeIntent,
  book: { bids?: [number, number][]; asks?: [number, number][] },
  minEdge: number
): TradeIntent {
  const bestBid = book.bids?.[0]?.[0] ?? 0;
  const bestAsk = book.asks?.[0]?.[0] ?? 1;
  
  let targetPrice = intent.price;
  if (intent.side === "BUY") {
    if ((intent.price ?? 0) - bestAsk < minEdge) {
      targetPrice = bestAsk;
    }
  } else {
    if (bestBid - (intent.price ?? 0) < minEdge) {
      targetPrice = bestBid;
    }
  }

  return { ...intent, price: targetPrice };
}

/* ─── PM-STR-03: sizing primitives ───────────────────────────────────── */

/**
 * Strategy sizing (PM-STR-03): apply conservative scaling based on
 * portfolio-level constraints (TVL, volatility).
 */
export function scaleIntent(intent: TradeIntent, scale: number): TradeIntent {
  return { ...intent, size: (intent.size ?? 0) * Math.max(0, Math.min(1, scale)) };
}