/**
 * @polyroot/control — Signal (edge) evaluation.
 *
 * Pure, deterministic decision of whether a calibrated forecast offers a
 * tradeable edge against the current venue book. No financial effect; the
 * result only shapes intent generation (PR-STR / B8).
 *
 * Edge candidates:
 *   YES side:  edge = p - yes_price
 *   NO side:   edge = (1 - p) - no_price
 *
 * The net edge subtracts the venue taker fee from the gross edge. The larger
 * net edge wins; a non-positive net edge (after fees) is never traded.
 */

import type { Forecast, MarketSnapshot } from "@polyroot/domain";

export type SignalSide = "YES" | "NO";

export type EdgeResult = {
  action: "TRADE" | "NO_TRADE";
  /** Winning side when action is TRADE, otherwise the best candidate or null. */
  side: SignalSide | null;
  /** Gross edge of the best candidate. */
  edge: number;
  /** Net edge after the taker fee. */
  edge_after_fees: number;
  probability: number | null;
  /** Venue price of the winning side (reference price). */
  reference_price: number | null;
  reason: string;
  code: "OK" | "NO_BOOK" | "NO_PROBABILITY" | "NEGATIVE_EDGE" | "MIN_EDGE_UNMET";
};

export interface SignalInput {
  forecast: Forecast;
  book: MarketSnapshot;
}

export interface SignalOpts {
  /** Minimum net edge required to trade (after fees). */
  minEdge: number;
  /** Overrides the book's taker fee when provided. */
  takerFeeBps?: number;
}

export function evaluateEdge(
  input: SignalInput,
  opts: SignalOpts,
): EdgeResult {
  const f = input.forecast;
  const b = input.book;

  const probability = f.p_calibrated ?? f.p_raw ?? f.probability_yes ?? null;
  if (probability === null) {
    return {
      action: "NO_TRADE",
      side: null,
      edge: 0,
      edge_after_fees: 0,
      probability: null,
      reference_price: null,
      reason: "forecast carries no usable probability",
      code: "NO_PROBABILITY",
    };
  }

  const yes = b.yes_price;
  const no = b.no_price;
  if (yes === undefined && no === undefined) {
    return {
      action: "NO_TRADE",
      side: null,
      edge: 0,
      edge_after_fees: 0,
      probability,
      reference_price: null,
      reason: "book has neither a YES nor a NO price",
      code: "NO_BOOK",
    };
  }

  const takerBps = opts.takerFeeBps ?? b.fee_taker_bps ?? 0;
  const feeRate = takerBps / 10_000;

  const candidates: Array<{
    side: SignalSide;
    gross: number;
    price: number;
  }> = [];
  if (yes !== undefined) {
    candidates.push({ side: "YES", gross: probability - yes, price: yes });
  }
  if (no !== undefined) {
    candidates.push({
      side: "NO",
      gross: 1 - probability - no,
      price: no,
    });
  }

  candidates.sort((a, z) => z.gross - a.gross);
  const best = candidates[0]!;
  const edge = best.gross;
  const edge_after_fees = edge - feeRate;

  if (edge_after_fees <= 0) {
    return {
      action: "NO_TRADE",
      side: best.side,
      edge,
      edge_after_fees,
      probability,
      reference_price: best.price,
      reason: "best edge is not positive after fees",
      code: "NEGATIVE_EDGE",
    };
  }
  if (edge_after_fees < opts.minEdge) {
    return {
      action: "NO_TRADE",
      side: best.side,
      edge,
      edge_after_fees,
      probability,
      reference_price: best.price,
      reason: "net edge below the required minimum",
      code: "MIN_EDGE_UNMET",
    };
  }

  return {
    action: "TRADE",
    side: best.side,
    edge,
    edge_after_fees,
    probability,
    reference_price: best.price,
    reason: `${best.side} edge ${edge_after_fees.toFixed(4)} meets the threshold`,
    code: "OK",
  };
}

export type { Forecast, MarketSnapshot };