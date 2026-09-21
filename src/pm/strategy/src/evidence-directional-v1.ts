/**
 * @polyroot/strategy — EvidenceDirectionalV1: Placeholder for legacy strategy.
 * 
 * This is the legacy evidence_directional_v1 strategy that has been
 * superseded by evidence_directional_v2. Kept for backward compatibility
 * and comparison purposes only.
 */
import type { Forecast, TradeIntent } from "@polyroot/domain";

export interface EvidenceDirectionalV1Config {
  minEdgeAfterCost: number;
}

export interface StrategyProposal {
  schema_version: string;
  strategy: string;
  version: string;
  intent: TradeIntent;
  no_trade_code?: string;
}

export class EvidenceDirectionalV1 {
  constructor(private readonly config: EvidenceDirectionalV1Config) {}

  async run(input: {
    forecast: Forecast;
    book: { yes_price: number; no_price: number };
    fees: { taker_bps: number };
  }): Promise<StrategyProposal | null> {
    const p = input.forecast.p_conservative ?? input.forecast.p_calibrated ?? input.forecast.p_raw ?? 0.5;
    const side = p > 0.5 ? "YES" : "NO";
    const bookPrice = side === "YES" ? input.book.yes_price : input.book.no_price;
    const edge = Math.abs(p - bookPrice) - input.fees.taker_bps / 10000;

    if (edge < this.config.minEdgeAfterCost) {
      return {
        schema_version: "1.0.0",
        strategy: "evidence_directional_v1",
        version: "1.0.0",
        intent: {
          schema_version: "1.0.0",
          intent_id: `int_${input.forecast.forecast_id}`,
          dedupe_key: `int_${input.forecast.forecast_id}`,
          purpose: "ENTRY",
          market_id: input.forecast.market_id,
          token_id: "",
          side: side as "BUY" | "SELL",
          desired_qty: 0,
          limit_price: bookPrice,
          forecast_refs: [input.forecast.forecast_id],
          evidence_ids: input.forecast.evidence_ids,
          status: "CREATED",
          price: bookPrice,
          size: 0,
          forecast_id: input.forecast.forecast_id,
          created_at: new Date(),
        },
        no_trade_code: "MIN_EDGE_UNMET",
      };
    }

    return {
      schema_version: "1.0.0",
      strategy: "evidence_directional_v1",
      version: "1.0.0",
      intent: {
        schema_version: "1.0.0",
        intent_id: `int_${input.forecast.forecast_id}`,
        dedupe_key: `int_${input.forecast.forecast_id}`,
        purpose: "ENTRY",
        market_id: input.forecast.market_id,
        token_id: "",
        side: side as "BUY" | "SELL",
        desired_qty: edge * 100,
        limit_price: bookPrice,
        forecast_refs: [input.forecast.forecast_id],
        evidence_ids: input.forecast.evidence_ids,
        status: "CREATED",
        price: bookPrice,
        size: edge * 100,
        forecast_id: input.forecast.forecast_id,
        created_at: new Date(),
      },
    };
  }
}