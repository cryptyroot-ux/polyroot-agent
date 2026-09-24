/**
 * @polyroot/strategy — Structural safety contracts (FT-30, FT-31, FT-32).
 *
 * Cross-market structure is where silent overconfidence lives:
 *
 *   FT-31 false exclusivity (PM-GRAPH-02) — outcomes claimed exclusive but
 *           not proven exhaustive must NEVER yield a "guaranteed payout"
 *           proof. The solver rejects; it does not round the proof.
 *   FT-32 one leg only (PM-GRAPH-06) — a partially filled multi-leg
 *           proposal carries residual exposure that must stay bounded;
 *           only hedge/unwind within the mandate is allowed, never a
 *           larger speculative leg.
 *   FT-30 correlation gap (PM-GRAPH-04) — unknown or unavailable graph
 *           relations share the conservative cap: no diversification
 *           credit without verified proof. Every overlapping group limit
 *           is consumed independently (gross, never netted away).
 *
 * Pure functions (no I/O).
 */

export type StructuralCode =
  "INCOMPLETE_EXCLUSIVITY" | "RESIDUAL_OVER_CAP" | "UNKNOWN_RELATION";

export type StructuralResult =
  | { ok: true; note: string }
  | { ok: false; code: StructuralCode; reason: string };

/* ─── FT-31: exclusivity proof ─────────────────────────────────────── */

export interface ExclusivityClaim {
  /** Outcome ids claimed mutually exclusive. */
  outcomes: string[];
  /** State ids the claim covers (must be exhaustive to prove payout). */
  coveredStates: string[];
  /** All possible terminal states of the event. */
  allStates: string[];
  /** Minimum guaranteed payout if the proof held. */
  claimedMinPayout: number;
}

/**
 * A guaranteed-payout proof requires BOTH: pairwise-disjoint outcomes
 * (by construction of distinct outcome ids) AND exhaustive state
 * coverage. An "exclusive but incomplete" claim is rejected — the
 * solver never certifies a guarantee over states it cannot see.
 */
export function proveGuaranteedPayout(
  claim: ExclusivityClaim,
): StructuralResult {
  const all = new Set(claim.allStates);
  if (all.size === 0) {
    return {
      ok: false,
      code: "INCOMPLETE_EXCLUSIVITY",
      reason: "empty state universe: nothing proven",
    };
  }
  const covered = new Set(claim.coveredStates);
  const missing = [...all].filter((s) => !covered.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "INCOMPLETE_EXCLUSIVITY",
      reason: `exclusivity unproven over ${missing.length} uncovered state(s) (e.g. ${missing[0]})`,
    };
  }
  const dupes = claim.coveredStates.length !== covered.size;
  if (dupes) {
    return {
      ok: false,
      code: "INCOMPLETE_EXCLUSIVITY",
      reason: "covered states contain duplicates: disjointness unproven",
    };
  }
  if (!(claim.claimedMinPayout > 0)) {
    return {
      ok: false,
      code: "INCOMPLETE_EXCLUSIVITY",
      reason: "claimed minimum payout is not positive",
    };
  }
  return { ok: true, note: "exclusivity proven over all terminal states" };
}

/* ─── FT-32: residual exposure bound ───────────────────────────────── */

export interface ResidualCheck {
  /** Notional of legs already filled. */
  filledNotional: number;
  /** Total intended notional across all legs. */
  totalNotional: number;
  /** Maximum unhedged cash exposure the mandate allows. */
  maxUnhedged: number;
}

export type ResidualVerdict =
  | { ok: true; residual: number; allowed: "HOLD" | "HEDGE_UNWIND_ONLY" }
  | { ok: false; code: "RESIDUAL_OVER_CAP"; reason: string };

/**
 * A partially filled multi-leg leaves residual exposure. Below the cap the
 * only allowed actions are hold or hedge/unwind within the mandate —
 * never opening a larger speculative leg to "complete" the structure.
 */
export function boundResidualExposure(check: ResidualCheck): ResidualVerdict {
  for (const [name, v] of [
    ["filledNotional", check.filledNotional],
    ["totalNotional", check.totalNotional],
    ["maxUnhedged", check.maxUnhedged],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      return {
        ok: false,
        code: "RESIDUAL_OVER_CAP",
        reason: `invalid measurement: ${name} must be finite non-negative`,
      };
    }
  }
  if (check.filledNotional > check.totalNotional) {
    return {
      ok: false,
      code: "RESIDUAL_OVER_CAP",
      reason: "filled notional exceeds total intended notional",
    };
  }
  const residual = check.totalNotional - check.filledNotional;
  if (residual > check.maxUnhedged) {
    return {
      ok: false,
      code: "RESIDUAL_OVER_CAP",
      reason: `residual exposure ${residual} exceeds mandate cap ${check.maxUnhedged}`,
    };
  }
  return {
    ok: true,
    residual,
    allowed: residual === 0 ? "HOLD" : "HEDGE_UNWIND_ONLY",
  };
}

/* ─── FT-30: correlation fallback cap ──────────────────────────────── */

export interface GroupCapInput {
  /** Verified group caps that apply to the position (all consumed). */
  verifiedGroupCaps: number[];
  /** True when any relation is unknown/unavailable (graph gap). */
  hasUnknownRelation: boolean;
  /** Conservative fallback cap used under uncertainty. */
  conservativeCap: number;
}

export type GroupCapVerdict =
  | { ok: true; effectiveCap: number; note: string }
  | {
      ok: false;
      code: "UNKNOWN_RELATION";
      reason: string;
      effectiveCap: number;
    };

/**
 * Overlapping group limits are ALL consumed (gross). Unknown relations
 * share the conservative cap — statistical correlation grants scenario
 * estimates, never automatic diversification credit. Sparse data raises
 * uncertainty; it never zeroes the cap via a VaR of zero.
 */
export function groupCapWithFallback(input: GroupCapInput): GroupCapVerdict {
  if (!(input.conservativeCap > 0) || !Number.isFinite(input.conservativeCap)) {
    return {
      ok: false,
      code: "UNKNOWN_RELATION",
      reason: "conservative fallback cap must be finite positive",
      effectiveCap: 0,
    };
  }
  for (const cap of input.verifiedGroupCaps) {
    if (!(cap > 0) || !Number.isFinite(cap)) {
      return {
        ok: false,
        code: "UNKNOWN_RELATION",
        reason: "verified group caps must be finite positive",
        effectiveCap: input.conservativeCap,
      };
    }
  }
  if (input.hasUnknownRelation) {
    return {
      ok: true,
      effectiveCap: input.conservativeCap,
      note: "unknown relation: conservative cap shared, no diversification credit",
    };
  }
  const effectiveCap = Math.min(
    input.conservativeCap,
    ...input.verifiedGroupCaps,
  );
  return {
    ok: true,
    effectiveCap,
    note: "all overlapping group caps consumed (gross)",
  };
}
