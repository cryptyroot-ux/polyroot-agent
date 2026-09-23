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

const DEFAULT_TOLERANCES: Required<RealityGapTolerances> = {
  maxFillRateGapPp: 10,
  maxSlippageBias: 0.005,
  minIndependentAttempts: 100,
};

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Evaluate the execution reality gap between simulator and observation.
 * Fail-closed: invalid inputs and insufficient evidence can never PASS.
 */
export function evaluateRealityGap(
  input: RealityGapInput,
  tolerances: RealityGapTolerances = {},
): RealityGapResult {
  const tol = { ...DEFAULT_TOLERANCES, ...tolerances };
  const reasons: string[] = [];

  // 0. Input validity — garbage measurements must not produce a verdict
  //    that looks like evidence. INCONCLUSIVE, never PASS.
  const fields: Array<[string, unknown]> = [
    ["fillRatePaper", input.fillRatePaper],
    ["fillRateObserved", input.fillRateObserved],
    ["meanSignedSlippage", input.meanSignedSlippage],
    ["cancelOverfill", input.cancelOverfill],
    ["invariantViolations", input.invariantViolations],
    ["independentAttempts", input.independentAttempts],
  ];
  for (const [name, value] of fields) {
    if (!isFiniteNumber(value)) {
      return {
        verdict: "INCONCLUSIVE",
        reasons: [`invalid measurement: ${name} is not finite`],
        metrics: {
          fillRateGapPp: Number.NaN,
          absSlippageBias: Number.NaN,
          independentAttempts: 0,
        },
      };
    }
  }
  if (
    input.fillRatePaper < 0 ||
    input.fillRatePaper > 1 ||
    input.fillRateObserved < 0 ||
    input.fillRateObserved > 1
  ) {
    return {
      verdict: "INCONCLUSIVE",
      reasons: ["invalid measurement: fill rates must be in [0,1]"],
      metrics: {
        fillRateGapPp: Number.NaN,
        absSlippageBias: Math.abs(input.meanSignedSlippage),
        independentAttempts: input.independentAttempts,
      },
    };
  }
  if (input.independentAttempts < 0 || input.cancelOverfill < 0 || input.invariantViolations < 0) {
    return {
      verdict: "INCONCLUSIVE",
      reasons: ["invalid measurement: counts must be non-negative"],
      metrics: {
        fillRateGapPp: Math.abs(input.fillRatePaper - input.fillRateObserved) * 100,
        absSlippageBias: Math.abs(input.meanSignedSlippage),
        independentAttempts: input.independentAttempts,
      },
    };
  }

  const fillRateGapPp =
    Math.abs(input.fillRatePaper - input.fillRateObserved) * 100;
  const absSlippageBias = Math.abs(input.meanSignedSlippage);
  const metrics = {
    fillRateGapPp,
    absSlippageBias,
    independentAttempts: input.independentAttempts,
  };

  // 1. Evidence sufficiency — insufficient data is INCONCLUSIVE, never PASS.
  //    (Blueprint §13.2: "jika data tidak cukup, hasil INCONCLUSIVE, bukan PASS".)
  if (input.independentAttempts < tol.minIndependentAttempts) {
    reasons.push(
      `insufficient evidence: ${input.independentAttempts} independent attempts < ${tol.minIndependentAttempts} minimum`,
    );
    return { verdict: "INCONCLUSIVE", reasons, metrics };
  }

  // 2. Zero-tolerance invariants — cancel overfill and ledger/venue
  //    invariant violations must be exactly zero on observed tests.
  if (input.cancelOverfill > 0) {
    reasons.push(`cancel overfill ${input.cancelOverfill} > 0`);
  }
  if (input.invariantViolations > 0) {
    reasons.push(`invariant violations ${input.invariantViolations} > 0`);
  }

  // 3. Calibrated tolerances. A 1e-9 epsilon keeps exact-boundary inputs
  //    (e.g. a 10.000000000000002pp float artifact of 0.8 − 0.7) from
  //    failing a ≤ comparison they mathematically satisfy.
  const EPS = 1e-9;
  if (fillRateGapPp > tol.maxFillRateGapPp + EPS) {
    reasons.push(
      `fill-rate gap ${fillRateGapPp.toFixed(2)}pp > ${tol.maxFillRateGapPp}pp`,
    );
  }
  if (absSlippageBias > tol.maxSlippageBias + EPS) {
    reasons.push(
      `slippage bias ${absSlippageBias.toFixed(4)} > ${tol.maxSlippageBias} pUSD/share`,
    );
  }

  if (reasons.length > 0) {
    return { verdict: "FAIL", reasons, metrics };
  }
  return { verdict: "PASS", reasons: ["reality gap within tolerance"], metrics };
}
