/**
 * @polyroot/strategy — Exit/Reallocation Engine (PM-STR-08).
 *
 * Evaluates whether to HOLD, EXIT, REDUCE, or REALLOCATE a position
 * based on hold EV considering bid/depth, fees, adverse selection, and time-to-resolution.
 */

import type {
  Position,
  Forecast,
  MarketFeeSettings,
  OrderBookFrame,
  TradeIntent,
} from "@polyroot/domain";

export interface ExitEngineConfig {
  /** Minimum hold EV threshold; exit if hold EV < this value. */
  minHoldEV: number;
  /** Adverse selection buffer as fraction of spread. */
  adverseSelectionBuffer?: number;
  /** Minimum size for a reduce/exit intent. */
  minExitSize?: number;
}

interface EvaluateInput {
  position: Position;
  book: OrderBookFrame;
  forecast: Forecast;
  time_to_resolution_sec: number;
  fees: MarketFeeSettings;
}

interface EvaluateOutput {
  intent: TradeIntent | null;
  holdEV: number;
  decision: "HOLD" | "EXIT" | "REDUCE";
  reason: string;
}

/**
 * Exit Engine evaluates hold vs exit/reduce for a position.
 *
 * HOLD EV = (p * (1 - price) - (1-p) * price) * size - fees - adverse_selection
 *
 * If hold EV < minHoldEV: emit EXIT/REDUCE intent
 */
export class ExitEngine {
  constructor(private config: ExitEngineConfig) {}

  async evaluate(input: EvaluateInput): Promise<EvaluateOutput> {
    const { position, book, forecast, time_to_resolution_sec, fees } = input;

    const p = this.getConservativeProbability(forecast, position.side);
    const currentPrice = this.getCurrentPrice(book, position.side);
    const size = Math.abs(position.size);
    const avgPrice = position.avg_price ?? currentPrice;

    // Calculate hold EV
    // Expected value of holding: p * payoff_if_resolves_yes + (1-p) * payoff_if_resolves_no
    // For YES position: resolves to 1 with prob p, 0 with prob (1-p) => payoff = p - currentPrice
    // For NO position: resolves to 1 with prob p(NO), 0 with prob (1-p(NO)) => payoff = p(NO) - currentPrice
    const expectedPayoffPerShare = p - currentPrice;

    // Fees (taker fee to exit)
    const feePerShare = (fees.fee_taker_bps ?? 0) / 10000;

    // Adverse selection buffer (half spread)
    const spread = (book.asks?.[0]?.[0] ?? 1) - (book.bids?.[0]?.[0] ?? 0);
    const adverseSelection = (this.config.adverseSelectionBuffer ?? 0.5) * spread;

    // Time decay factor - closer to resolution means less time for edge to materialize
    const timeDecayFactor = Math.max(0.1, 1 - time_to_resolution_sec / (30 * 24 * 3600));

    const holdEV =
      (expectedPayoffPerShare - feePerShare - adverseSelection) * size * timeDecayFactor;

    // Decide action
    if (holdEV < this.config.minHoldEV) {
      const side = "SELL"; // Exit is always selling the held position
      const exitSize = Math.max(this.config.minExitSize ?? 1, size);

      const intent: TradeIntent = {
        schema_version: "1.0.0",
        intent_id: `exit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        dedupe_key: `exit_${position.market_id}_${position.side}_${Date.now()}`,
        purpose: holdEV < -size * 0.01 ? "EXIT" : "REDUCE",
        market_id: position.market_id,
        side,
        desired_qty: exitSize,
        limit_price: currentPrice,
        forecast_refs: [forecast.forecast_id ?? ""],
        evidence_ids: forecast.evidence_ids ?? [],
        status: "CREATED",
        price: currentPrice,
        size: exitSize,
        created_at: new Date(),
      };

      return {
        intent,
        holdEV,
        decision: holdEV < -size * 0.01 ? "EXIT" : "REDUCE",
        reason: `Hold EV ${holdEV.toFixed(4)} < minHoldEV ${this.config.minHoldEV}`,
      };
    }

    return {
      intent: null,
      holdEV,
      decision: "HOLD",
      reason: `Hold EV ${holdEV.toFixed(4)} >= minHoldEV ${this.config.minHoldEV}`,
    };
  }

  private getConservativeProbability(forecast: Forecast, positionSide: "YES" | "NO"): number {
    // Use conservative probability for the position's side
    const pYes =
      forecast.p_conservative ??
      forecast.p_calibrated ??
      forecast.p_raw ??
      forecast.probability_yes ??
      0.5;

    return positionSide === "YES" ? pYes : 1 - pYes;
  }

  private getCurrentPrice(book: OrderBookFrame, positionSide: "YES" | "NO"): number {
    // For YES position, we sell at bid; for NO position, we sell at ask (which is 1 - YES bid)
    if (positionSide === "YES") {
      return book.bids?.[0]?.[0] ?? book.asks?.[0]?.[0] ?? 0.5;
    } else {
      // NO price = 1 - YES ask (best price to sell NO)
      const yesAsk = book.asks?.[0]?.[0] ?? 1;
      return 1 - yesAsk;
    }
  }
}