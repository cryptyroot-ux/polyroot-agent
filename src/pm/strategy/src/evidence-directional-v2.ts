/**
 * evidence_directional_v2 — Directional Strategy from Evidence-Based Forecasts
 *
 * Consumes a Forecast and order book, produces StrategyProposal or NO_TRADE.
 * Uses conservative probability (p_conservative) to compute edge after fees.
 */
import { randomUUID } from "crypto";
import type {
  Forecast,
  StrategyProposal,
  MarketFeeSettings, // eslint-disable-line @typescript-eslint/no-unused-vars
} from "@polyroot/domain";

export interface EvidenceDirectionalV2Config {
  minEdgeAfterCost: number;
}

export interface EvidenceDirectionalV2Input {
  forecast: Forecast;
  book: { yes_price: number; no_price: number };
  fees: { taker_bps: number };
}

export class EvidenceDirectionalV2 {
  constructor(private config: EvidenceDirectionalV2Config) {}

  async run(
    input: EvidenceDirectionalV2Input,
  ): Promise<StrategyProposal | null> {
    const { forecast, book, fees } = input;

    // 1. Validate forecast has required fields
    if (
      forecast.p_conservative === undefined ||
      forecast.p_conservative === null
    ) {
      return this.noTrade("MISSING_CONSERVATIVE_PROB", forecast.forecast_id);
    }

    if (forecast.evidence_ids.length === 0) {
      return this.noTrade("NO_EVIDENCE", forecast.forecast_id);
    }

    // 2. Compute edge vs book after conservative probability + fees
    const pConservative = forecast.p_conservative;
    const takerFee = fees.taker_bps / 10000; // bps to decimal

    // Determine which side to trade based on conservative probability
    const side = pConservative > 0.5 ? "YES" : "NO";
    const bookPrice = side === "YES" ? book.yes_price : book.no_price;

    if (bookPrice <= 0 || bookPrice >= 1) {
      return this.noTrade("INVALID_BOOK_PRICE", forecast.forecast_id);
    }

    // Edge = p_conservative - book_price (for YES) or (1 - p_conservative) - book_price (for NO)
    // But we need to account for fees: we pay taker fee on entry
    const effectiveEdge =
      side === "YES"
        ? pConservative - bookPrice - takerFee
        : 1 - pConservative - bookPrice - takerFee;

    // 3. If edge < minEdgeAfterCost: return NO_TRADE
    if (effectiveEdge < this.config.minEdgeAfterCost) {
      return this.noTrade("MIN_EDGE_UNMET", forecast.forecast_id);
    }

    // 4. Size via PositionSizer (injected) - simplified here
    // In production, this would use SizingEngine from @polyroot/risk
    const rawSize = Math.abs(pConservative - 0.5) * 2;
    const desiredQty = Math.max(0.01, rawSize); // minimum 0.01 shares

    // 5. Return StrategyProposal with dedupe_key
    return {
      schema_version: "1.0.0",
      proposal_id: randomUUID(),
      strategy: "evidence_directional_v2",
      strategy_version: "1.0.0",
      strategy_params: {
        market_id: forecast.market_id,
        side,
        desired_qty: desiredQty,
        purpose: "ENTRY",
        limit_price: bookPrice,
      },
      forecast_refs: [forecast.forecast_id],
      graph_refs: [],
      entry_thesis: `Conservative p=${pConservative.toFixed(3)} vs book=${bookPrice.toFixed(3)} edge=${effectiveEdge.toFixed(4)}`,
      exit_thesis: "Hold to resolution or stop-loss at -50% EV",
      cost_assumptions: { taker_bps: fees.taker_bps },
      expected_edge_distribution: { mean: effectiveEdge, std: 0.01 },
      expires_at: new Date(Date.now() + 3600000), // 1 hour
      reason_code: "EDGE_QUALIFIED",
      no_trade_code: undefined,
    };
  }

  private noTrade(code: string, forecastId: string): StrategyProposal {
    return {
      schema_version: "1.0.0",
      proposal_id: randomUUID(),
      strategy: "evidence_directional_v2",
      strategy_version: "1.0.0",
      strategy_params: {},
      forecast_refs: [forecastId],
      graph_refs: [],
      expires_at: new Date(Date.now() + 3600000),
      no_trade_code: code,
    };
  }
}
