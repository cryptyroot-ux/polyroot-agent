/**
 * @polyroot/runtime — Paper trading engine + probabilistic & economic metrics +
 * experiment registry (PR-VAL-04..08, G4/G5).
 *
 * Pure logic only; no financial I/O. All fill/queue/latency models are
 * injectable so the engine stays deterministic and unit-testable.
 */

/* ─── PR-VAL-04: Paper simulator (fill / queue / latency / fees) ─────────── */

export type SimulatedFill =
  | { status: "FILLED"; filledSize: number; fillPrice: number; makerFee: number; takerFee: number; latencyMs: number }
  | { status: "PARTIAL"; filledSize: number; fillPrice: number; makerFee: number; takerFee: number; latencyMs: number }
  | { status: "CANCELLED"; filledSize: 0; fillPrice: 0; makerFee: 0; takerFee: 0; latencyMs: number };

export interface FillModelInput {
  /** Order size in shares. */
  size: number;
  /** Market bid (maker) price for the side. */
  bid: number;
  /** Market ask (taker) price for the side. */
  ask: number;
  /** Depth available at the touch (notional). */
  depth: number;
  /** True if taking liquidity (post fee applies), else maker. */
  taker: boolean;
  /** Maker fee in bps. */
  makerFeeBps: number;
  /** Taker fee in bps. */
  takerFeeBps: number;
  /** Simulated latency in ms. */
  latencyMs: number;
  /** 0..1 probability an order is fully rejected (slippage/no-match). */
  cancelProbability: number;
  /** Fraction of size assumed to fill when only partial depth is present. */
  partialFraction: number;
  /** Injectable RNG for determinism in tests. */
  rng?: () => number;
}

const defaultRng = Math.random;

/**
 * Deterministic-ish fill simulation: picks the touch price, applies maker/taker
 * fees, and outputs one of FILLED / PARTIAL / CANCELLED.
 */
export function simulateFill(input: FillModelInput): SimulatedFill {
  const r = input.rng ?? defaultRng;
  const fillPrice = input.taker ? input.ask : input.bid;

  // Cancel path (venue says no match / order lost).
  if (r() < input.cancelProbability) {
    return { status: "CANCELLED", filledSize: 0, fillPrice: 0, makerFee: 0, takerFee: 0, latencyMs: input.latencyMs };
  }

  // Partial fill when the order exceeds touch depth.
  const filled = input.size <= input.depth ? input.size : Math.floor(input.size * input.partialFraction);
  if (filled <= 0) {
    return { status: "CANCELLED", filledSize: 0, fillPrice: 0, makerFee: 0, takerFee: 0, latencyMs: input.latencyMs };
  }

  const notional = filled * fillPrice;
  const makerFee = input.taker ? 0 : Math.round((notional * input.makerFeeBps) / 1e4);
  const takerFee = input.taker ? Math.round((notional * input.takerFeeBps) / 1e4) : 0;

  return {
    status: filled < input.size ? "PARTIAL" : "FILLED",
    filledSize: filled,
    fillPrice,
    makerFee,
    takerFee,
    latencyMs: input.latencyMs,
  };
}

/* ─── PR-VAL-05: Prospective SHADOW evaluation helper ─────────────────────── */

export interface ShadowCriteria {
  /** Minimum independent resolved event clusters required (>=30d baseline). */
  minResolvedClusters: number;
  /** Minimum administrative baseline in calendar days. */
  minDays: number;
}

export function evaluateShadowCandidate(input: {
  observedDays: number;
  resolvedClusters: number;
  criteria: ShadowCriteria;
}): { passed: boolean; reason: string } {
  if (input.observedDays < input.criteria.minDays) {
    return { passed: false, reason: `baseline ${input.observedDays}d < ${input.criteria.minDays}d` };
  }
  if (input.resolvedClusters < input.criteria.minResolvedClusters) {
    return {
      passed: false,
      reason: `resolved clusters ${input.resolvedClusters} < ${input.criteria.minResolvedClusters}`,
    };
  }
  return { passed: true, reason: "SHADOW baseline met" };
}

/* ─── PR-VAL-06: Probabilistic quality metrics ────────────────────────────── */

export interface ProbQualityInput {
  /** Forecast probabilities (same-timestamp as outcomes). */
  probabilities: number[];
  /** Binary outcomes 0/1. */
  outcomes: number[];
  /** Forecast horizon per item (seconds), for sharpness/coverage by horizon. */
  horizons?: number[];
}

export interface ProbQuality {
  brier: number;
  logLoss: number;
  calibrationError: number;
  sharpness: number;
  coverage: number;
  abstentionRate: number;
  n: number;
}

/** Brier score: mean((p - y)^2), smaller is better. */
export function brierScore(probabilities: number[], outcomes: number[]): number {
  if (probabilities.length !== outcomes.length) throw new Error("length mismatch");
  let s = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    const y = outcomes[i];
    if (p !== undefined && y !== undefined) s += (p - y) ** 2;
  }
  return s / probabilities.length;
}

/** Log loss with clipping to avoid -Infinity. */
export function logLoss(probabilities: number[], outcomes: number[]): number {
  if (probabilities.length !== outcomes.length) throw new Error("length mismatch");
  const eps = 1e-9;
  let s = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const pRaw = probabilities[i];
    const y = outcomes[i];
    if (pRaw === undefined || y === undefined) continue;
    const p = Math.min(1 - eps, Math.max(eps, pRaw));
    s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return s / probabilities.length;
}

/** Binned calibration error: E[| avg_fit_observed_freq - avg_predicted |] across B bins. */
export function calibrationError(probabilities: number[], outcomes: number[], bins = 10): number {
  if (probabilities.length !== outcomes.length) throw new Error("length mismatch");
  let err = 0;
  let usedBins = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let sumPred = 0;
    let sumObs = 0;
    let cnt = 0;
    for (let i = 0; i < probabilities.length; i++) {
      const p = probabilities[i];
      const y = outcomes[i];
      if (p !== undefined && y !== undefined && p >= lo && p < hi) {
        sumPred += p;
        sumObs += y;
        cnt++;
      }
    }
    if (cnt > 0) {
      err += Math.abs(sumObs / cnt - sumPred / cnt);
      usedBins++;
    }
  }
  return usedBins === 0 ? 0 : err / usedBins;
}

/** Sharpness: mean distance-from-0.5 of predictions. */
export function sharpness(probabilities: number[]): number {
  const n = probabilities.length;
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = probabilities[i];
    if (p !== undefined) s += Math.abs(p - 0.5);
  }
  return s / n;
}

/** Coverage: fraction of binary outcomes inside a prediction band (e.g. |p-y|<=0.25). */
export function coverage(probabilities: number[], outcomes: number[], band = 0.25): number {
  if (probabilities.length !== outcomes.length) throw new Error("length mismatch");
  const n = probabilities.length;
  if (n === 0) return NaN;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const p = probabilities[i];
    const y = outcomes[i];
    if (p !== undefined && y !== undefined && Math.abs(p - y) <= band) hits++;
  }
  return hits / n;
}

/** Abstention rate: fraction of near-0.5 (uncertain) forecasts. */
export function abstentionRate(probabilities: number[], threshold = 0.02): number {
  const n = probabilities.length;
  if (n === 0) return NaN;
  let a = 0;
  for (const p of probabilities) {
    if (p !== undefined && Math.abs(p - 0.5) < threshold) a++;
  }
  return a / n;
}

export function computeProbQuality(input: ProbQualityInput): ProbQuality {
  return {
    brier: brierScore(input.probabilities, input.outcomes),
    logLoss: logLoss(input.probabilities, input.outcomes),
    calibrationError: calibrationError(input.probabilities, input.outcomes),
    sharpness: sharpness(input.probabilities),
    coverage: coverage(input.probabilities, input.outcomes),
    abstentionRate: abstentionRate(input.probabilities),
    n: input.probabilities.length,
  };
}

/* ─── PR-VAL-07: Economic metrics ─────────────────────────────────────────── */

export interface EconomicInput {
  /** Running equity curve value history. */
  equityCurve: number[];
  /** Initial equity. */
  initialEquity: number;
  /** Cumulative fees paid. */
  totalFees: number;
  /** Cumulative gross PnL (before fees). */
  grossPnl: number;
  /** Gross turnover (sum of notional traded). */
  turnover: number;
  /** Capacity ceiling (max deployable base). */
  capacityUsd: number;
  /** Per-market PnL for concentration (Herfindahl). */
  perMarketPnl: number[];
}

export interface EconomicMetrics {
  netPnl: number;
  maxDrawdownPct: number;
  fillRatio: number;
  turnover: number;
  capacityUtilizationPct: number;
  concentration: number;
}

/**
 * Max drawdown from an equity curve (peak-to-trough), as fraction.
 */
export function maxDrawdown(equityCurve: number[]): number {
  const n = equityCurve.length;
  if (n === 0) return 0;
  const first = equityCurve[0] ?? 0;
  let peak = first;
  let maxDd = 0;
  for (let i = 0; i < n; i++) {
    const v = equityCurve[i];
    if (v === undefined) continue;
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Herfindahl index over per-market PnL shares; 1 = fully concentrated. */
export function concentrationIndex(perMarketPnl: number[]): number {
  const total = perMarketPnl.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const v of perMarketPnl) {
    const share = v / total;
    h += share * share;
  }
  return h;
}

export function computeEconomicMetrics(input: EconomicInput): EconomicMetrics {
  const netPnl = input.grossPnl - input.totalFees;
  return {
    netPnl,
    maxDrawdownPct: maxDrawdown(input.equityCurve),
    fillRatio: input.turnover > 0 ? Math.max(0, 1 - input.totalFees / Math.max(input.grossPnl, 1e-9)) : 0,
    turnover: input.turnover,
    capacityUtilizationPct: input.capacityUsd > 0 ? Math.min(100, (input.turnover / input.capacityUsd) * 100) : 0,
    concentration: concentrationIndex(input.perMarketPnl),
  };
}

/* ─── PR-VAL-08: Experiment registry (preregistration, no cherry-picking) ─── */

export interface ExperimentSpec {
  id: string;
  name: string;
  version: string;
  description: string;
  preregisteredAt: number;
  /** Predicted effect / stopping rule recorded BEFORE running. */
  preregisteredRule: string;
  status: "PREREGISTERED" | "RUNNING" | "CONCLUDED" | "WITHDRAWN";
  result?: ProbQuality;
}

/** Append-only registry. A preregistered spec can never be edited after creation. */
export class ExperimentRegistry {
  private readonly specs: ExperimentSpec[] = [];

  preregister(spec: Omit<ExperimentSpec, "id" | "status" | "preregisteredAt">): ExperimentSpec {
    const entry: ExperimentSpec = {
      ...spec,
      id: crypto.randomUUID(),
      preregisteredAt: Date.now(),
      status: "PREREGISTERED",
    };
    this.specs.push(entry);
    return entry;
  }

  conclude(id: string, result: ProbQuality): ExperimentSpec | undefined {
    const s = this.specs.find((x) => x.id === id);
    if (!s) return undefined;
    s.status = "CONCLUDED";
    s.result = result;
    return s;
  }

  withdraw(id: string): ExperimentSpec | undefined {
    const s = this.specs.find((x) => x.id === id);
    if (!s) return undefined;
    s.status = "WITHDRAWN";
    return s;
  }

  get(id: string): ExperimentSpec | undefined {
    return this.specs.find((s) => s.id === id);
  }

  all(): ExperimentSpec[] {
    return [...this.specs];
  }

  countByStatus(): Record<ExperimentSpec["status"], number> {
    const out: Record<ExperimentSpec["status"], number> = {
      PREREGISTERED: 0,
      RUNNING: 0,
      CONCLUDED: 0,
      WITHDRAWN: 0,
    };
    for (const s of this.specs) out[s.status]++;
    return out;
  }
}

/* ─── G4: full autonomous loop (no financial I/O) ─────────────────────────── */

export interface PaperLoopDeps {
  /** Produce a forecast for a given market snapshot. Pure. */
  forecast: (market: { market_id: string; bid: number; ask: number }) => number | null;
  /** Produce an intended size given the forecast and edge. Pure. */
  sizeIntent: (market: { market_id: string; bid: number; ask: number }, p: number) => number;
}

export type PaperDecision =
  | { action: "NO_TRADE"; market_id: string; reason: string }
  | {
      action: "BUY" | "SELL";
      market_id: string;
      p: number;
      size: number;
      fill: SimulatedFill;
      pnl: number;
    };

export interface PaperLoopResult {
  decisions: PaperDecision[];
  probabilities: number[];
  outcomes: number[];
  economic: EconomicMetrics;
  probQuality: ProbQuality;
}

/**
 * Runs one full pass over a set of markets: forecast → size → simulate fill →
 * book PnL. No venue I/O; fills are simulated. Outcomes array is populated
 * with the paper decision treated as a 1 for a BUY (a proxy for calibration
 * checks only — real SHADOW uses resolved market outcomes).
 */
export function runPaperLoop(deps: PaperLoopDeps, markets: Array<{ market_id: string; bid: number; ask: number }>, feeInput: Omit<FillModelInput, "size" | "bid" | "ask">): PaperLoopResult {
  const decisions: PaperDecision[] = [];
  const probabilities: number[] = [];
  const outcomes: number[] = [];
  const perMarketPnl: number[] = [];
  const equityCurve = [1000];
  const fills: SimulatedFill[] = [];

  let totalFees = 0;
  let grossPnl = 0;
  let turnover = 0;

  for (const m of markets) {
    const p = deps.forecast(m);
    if (p === null || p <= 0.02 || p >= 0.98 || Math.abs(p - 0.5) < 0.02) {
      decisions.push({ action: "NO_TRADE", market_id: m.market_id, reason: "forecast uncertain" });
      continue;
    }
    const size = deps.sizeIntent(m, p);
    const fill = simulateFill({ ...feeInput, size, bid: m.bid, ask: m.ask });
    const pnl = fill.status === "CANCELLED" ? 0 : (p - 0.5) * fill.filledSize - (fill.makerFee + fill.takerFee);

    probabilities.push(p);
    outcomes.push(p > 0.5 ? 1 : 0);
    perMarketPnl.push(pnl);
    grossPnl += pnl + (fill.makerFee + fill.takerFee);
    turnover += fill.filledSize * fill.fillPrice;
    totalFees += fill.makerFee + fill.takerFee;
    fills.push(fill);

    decisions.push({
      action: p > 0.5 ? "BUY" : "SELL",
      market_id: m.market_id,
      p,
      size,
      fill,
      pnl,
    });
    const last = equityCurve[equityCurve.length - 1] ?? 1000;
    equityCurve.push(last + pnl);
  }

  const economic = computeEconomicMetrics({
    equityCurve,
    initialEquity: equityCurve[0] ?? 1000,
    totalFees,
    grossPnl,
    turnover,
    capacityUsd: 10_000,
    perMarketPnl,
  });

  const probQuality = computeProbQuality({
    probabilities,
    outcomes,
  });

  return { decisions, probabilities, outcomes, economic, probQuality };
}