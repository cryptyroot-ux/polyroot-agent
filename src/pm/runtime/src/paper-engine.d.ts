/**
 * @polyroot/runtime — Paper trading engine + probabilistic & economic metrics +
 * experiment registry (PR-VAL-04..08, G4/G5).
 *
 * Pure logic only; no financial I/O. All fill/queue/latency models are
 * injectable so the engine stays deterministic and unit-testable.
 */
export type SimulatedFill = {
    status: "FILLED";
    filledSize: number;
    fillPrice: number;
    makerFee: number;
    takerFee: number;
    latencyMs: number;
} | {
    status: "PARTIAL";
    filledSize: number;
    fillPrice: number;
    makerFee: number;
    takerFee: number;
    latencyMs: number;
} | {
    status: "CANCELLED";
    filledSize: 0;
    fillPrice: 0;
    makerFee: 0;
    takerFee: 0;
    latencyMs: number;
};
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
/**
 * Deterministic-ish fill simulation: picks the touch price, applies maker/taker
 * fees, and outputs one of FILLED / PARTIAL / CANCELLED.
 */
export declare function simulateFill(input: FillModelInput): SimulatedFill;
export interface ShadowCriteria {
    /** Minimum independent resolved event clusters required (>=30d baseline). */
    minResolvedClusters: number;
    /** Minimum administrative baseline in calendar days. */
    minDays: number;
}
export declare function evaluateShadowCandidate(input: {
    observedDays: number;
    resolvedClusters: number;
    criteria: ShadowCriteria;
}): {
    passed: boolean;
    reason: string;
};
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
export declare function brierScore(probabilities: number[], outcomes: number[]): number;
/** Log loss with clipping to avoid -Infinity. */
export declare function logLoss(probabilities: number[], outcomes: number[]): number;
/** Binned calibration error: E[| avg_fit_observed_freq - avg_predicted |] across B bins. */
export declare function calibrationError(probabilities: number[], outcomes: number[], bins?: number): number;
/** Sharpness: mean distance-from-0.5 of predictions. */
export declare function sharpness(probabilities: number[]): number;
/** Coverage: fraction of binary outcomes inside a prediction band (e.g. |p-y|<=0.25). */
export declare function coverage(probabilities: number[], outcomes: number[], band?: number): number;
/** Abstention rate: fraction of near-0.5 (uncertain) forecasts. */
export declare function abstentionRate(probabilities: number[], threshold?: number): number;
export declare function computeProbQuality(input: ProbQualityInput): ProbQuality;
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
    /** Total submitted quantity across all orders. */
    totalSubmittedQty: number;
    /** Total filled quantity across all orders. */
    totalFilledQty: number;
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
export declare function maxDrawdown(equityCurve: number[]): number;
/** Herfindahl index over per-market PnL shares; 1 = fully concentrated. */
export declare function concentrationIndex(perMarketPnl: number[]): number;
export declare function computeEconomicMetrics(input: EconomicInput): EconomicMetrics;
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
export declare class ExperimentRegistry {
    private readonly specs;
    preregister(spec: Omit<ExperimentSpec, "id" | "status" | "preregisteredAt">): ExperimentSpec;
    conclude(id: string, result: ProbQuality): ExperimentSpec | undefined;
    withdraw(id: string): ExperimentSpec | undefined;
    get(id: string): ExperimentSpec | undefined;
    all(): ExperimentSpec[];
    countByStatus(): Record<ExperimentSpec["status"], number>;
}
export interface PaperLoopDeps {
    /** Produce a forecast for a given market snapshot. Pure. */
    forecast: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }) => number | null;
    /** Produce an intended size given the forecast and edge. Pure. */
    sizeIntent: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }, p: number) => number;
}
export type PaperDecision = {
    action: "NO_TRADE";
    market_id: string;
    reason: string;
} | {
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
export declare function runPaperLoop(deps: PaperLoopDeps, markets: Array<{
    market_id: string;
    bid: number;
    ask: number;
}>, feeInput: Omit<FillModelInput, "size" | "bid" | "ask">): PaperLoopResult;
export interface PaperFinancialDecision {
    market_id: string;
    action: "BUY" | "SELL";
    p: number;
    size: number;
    fill: SimulatedFill;
    pnl: number;
}
export interface RunPaperLoopWithOrchestratorParams {
    markets: Array<{
        market_id: string;
        bid: number;
        ask: number;
    }>;
    feeInput: Omit<FillModelInput, "size" | "bid" | "ask">;
    forecast: (m: {
        market_id: string;
        bid: number;
        ask: number;
    }) => number | null;
    sizeIntent: (m: {
        market_id: string;
        bid: number;
        ask: number;
    }, p: number) => number;
    /** Financial gate (PRD P3.2): only ALLOW lets a new order reach the orchestrator. */
    computeGate: (m: {
        market_id: string;
        bid: number;
        ask: number;
    }) => "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED";
    /** Side effect that runs before each entry attempt (permission/eligibility hook). */
    onEntry: (m: {
        market_id: string;
        bid: number;
        ask: number;
    }) => void;
    /** The real money path: MoneyKernel -> Executor -> SignerVault (PR-EXE-01). */
    orchestrate: (m: {
        market_id: string;
        bid: number;
        ask: number;
        p: number;
        size: number;
    }) => Promise<unknown>;
}
export interface RunPaperLoopWithOrchestratorResult {
    decisions: PaperFinancialDecision[];
    economic: EconomicMetrics;
}
/**
 * The full autonomous loop but routes each tradable decision through the REAL
 * pipeline (orchestrate). The financial gate decides entry admission per
 * market; only ALLOW reaches the money path. This fixes the prior gap where
 * PAPER simulated fills without touching MoneyKernel/Executor/Signer.
 */
export declare function runPaperLoopWithOrchestrator(params: RunPaperLoopWithOrchestratorParams): Promise<RunPaperLoopWithOrchestratorResult>;
//# sourceMappingURL=paper-engine.d.ts.map