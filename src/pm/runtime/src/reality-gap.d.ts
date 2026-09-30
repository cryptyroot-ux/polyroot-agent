/**
 * @polyroot/runtime — Execution Reality Gap gate (Blueprint §13.2, PRD G3/G4).
 *
 * Compares PAPER simulator fills against SHADOW-observed (or micro-LIVE)
 * fills and returns a three-state verdict:
 *
 *   PASS         — evidence sufficient AND all tolerances met
 *   FAIL         — evidence sufficient AND some tolerance violated
 *   INCONCLUSIVE — evidence insufficient; NEVER a silent PASS
 *
 * Thresholds below are the Blueprint §13.2 initial calibration proposal for
 * a tested directional profile (fill-rate gap ≤10pp, mean signed slippage
 * bias ≤0.005 pUSD/share, cancel overfill = 0, invariant violations = 0,
 * minimum 100 independent order attempts per role/profile). They are
 * policy inputs with safe defaults — not universal standards.
 *
 * Pure function (no I/O): fully unit-testable without a database or venue.
 */
export type RealityGapVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export interface RealityGapInput {
    /** Simulator fill rate in [0,1] (fraction of attempts filled). */
    fillRatePaper: number;
    /** Observed fill rate in [0,1] (SHADOW-observed or micro-LIVE). */
    fillRateObserved: number;
    /** Mean signed slippage (observed minus expected) in pUSD per share. */
    meanSignedSlippage: number;
    /** Cancel-overfilled quantity (must be zero). */
    cancelOverfill: number;
    /** Ledger/venue invariant violations observed (must be zero). */
    invariantViolations: number;
    /** Independent order attempts (bursts on one event do NOT count separately). */
    independentAttempts: number;
}
export interface RealityGapTolerances {
    /** Max |paper − observed| fill-rate gap in percentage points. */
    maxFillRateGapPp?: number;
    /** Max |mean signed slippage| in pUSD per share. */
    maxSlippageBias?: number;
    /** Minimum independent attempts before any PASS is allowed. */
    minIndependentAttempts?: number;
}
export interface RealityGapResult {
    verdict: RealityGapVerdict;
    reasons: string[];
    metrics: {
        fillRateGapPp: number;
        absSlippageBias: number;
        independentAttempts: number;
    };
}
/**
 * Evaluate the execution reality gap between simulator and observation.
 * Fail-closed: invalid inputs and insufficient evidence can never PASS.
 */
export declare function evaluateRealityGap(input: RealityGapInput, tolerances?: RealityGapTolerances): RealityGapResult;
//# sourceMappingURL=reality-gap.d.ts.map