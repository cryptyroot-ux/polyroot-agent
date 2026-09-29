/**
 * @polyroot/strategy — Multi-outcome arbitrage detector (PM-STR-10).
 *
 * Single binary markets misprice in one direction; multi-outcome events
 * (neg-risk, elections, sports brackets) misprice in SUM: when Σ YES prices
 * ≠ 1, a basket of all legs locks a risk-free payout. Pure, no I/O.
 *
 *   BUY_ALL_YES: cost Σ(yesᵢ + feeᵢ), guaranteed payout exactly $1
 *                (exactly one outcome resolves YES).
 *   BUY_ALL_NO:  cost Σ(1 − yesᵢ + feeᵢ), guaranteed payout $(n−1)
 *                (all but one NO resolve YES).
 *
 * Per-leg taker fee uses the CLOB formula Θ·p·(1−p) (Θ=0.05 default, same
 * source as control/signal.ts — intentionally duplicated, not imported, to
 * keep strategy free of control-layer coupling).
 */

export interface MultiOutcomeLeg {
  tokenId: string;
  /** YES price (0,1 exclusive — dust cannot arb). */
  yesPrice: number;
}

export type MultiOutcomeDirection = "BUY_ALL_YES" | "BUY_ALL_NO";

export interface MultiOutcomeVerdict {
  direction: MultiOutcomeDirection | null;
  /** Total entry cost including per-leg taker fees. */
  totalCost: number;
  guaranteedPayout: number;
  /** guaranteedPayout − totalCost. */
  edge: number;
  valid: boolean;
  reason:
    | "OK_YES_SUM_UNDER_ONE"
    | "OK_NO_SUM_OVER_ONE"
    | "NO_EDGE"
    | "BAD_INPUT";
}

export function thetaFeePerShare(price: number, theta = 0.05): number {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  if (!Number.isFinite(theta) || theta < 0) return 0;
  return theta * price * (1 - price);
}

export function evaluateMultiOutcomeArb(
  legs: MultiOutcomeLeg[],
  opts: { minEdge?: number; feeTheta?: number } = {},
): MultiOutcomeVerdict {
  const minEdge = opts.minEdge ?? 0.03;
  const theta = opts.feeTheta ?? 0.05;
  const fail = (
    reason: MultiOutcomeVerdict["reason"],
  ): MultiOutcomeVerdict => ({
    direction: null,
    totalCost: NaN,
    guaranteedPayout: NaN,
    edge: Number.NEGATIVE_INFINITY,
    valid: false,
    reason,
  });
  if (!Array.isArray(legs) || legs.length < 2) return fail("BAD_INPUT");
  for (const leg of legs) {
    if (
      !leg ||
      typeof leg.tokenId !== "string" ||
      !leg.tokenId ||
      !Number.isFinite(leg.yesPrice) ||
      leg.yesPrice <= 0 ||
      leg.yesPrice >= 1
    ) {
      return fail("BAD_INPUT");
    }
  }
  if (!(minEdge > 0)) return fail("BAD_INPUT");

  const yesCost =
    legs.reduce((s, l) => s + l.yesPrice + thetaFeePerShare(l.yesPrice, theta), 0);
  const yesEdge = 1 - yesCost;
  if (yesEdge >= minEdge) {
    return {
      direction: "BUY_ALL_YES",
      totalCost: yesCost,
      guaranteedPayout: 1,
      edge: yesEdge,
      valid: true,
      reason: "OK_YES_SUM_UNDER_ONE",
    };
  }
  const noCost = legs.reduce(
    (s, l) => s + (1 - l.yesPrice) + thetaFeePerShare(1 - l.yesPrice, theta),
    0,
  );
  const noEdge = legs.length - 1 - noCost;
  if (noEdge >= minEdge) {
    return {
      direction: "BUY_ALL_NO",
      totalCost: noCost,
      guaranteedPayout: legs.length - 1,
      edge: noEdge,
      valid: true,
      reason: "OK_NO_SUM_OVER_ONE",
    };
  }
  return {
    direction: null,
    totalCost: Math.min(yesCost, noCost),
    guaranteedPayout: NaN,
    edge: Math.max(yesEdge, noEdge),
    valid: false,
    reason: "NO_EDGE",
  };
}
