/**
 * @polyroot/control — G5 LIVE promotion pack (PRD G5).
 *
 * Autonomous LIVE per strategy/profile requires ALL of:
 *
 *   1. Gates G0–G4 passed for THIS strategy/profile (never borrowed from
 *      another profile's evidence).
 *   2. Explicit capital promotion: owner-signed, from a current cap to a
 *      higher cap, unexpired. Promotion is an event, not a drift.
 *   3. Monitoring declared: system-health, venue-mode and account-mode
 *      streams all present (three distinct signals, never one).
 *   4. Rollback triggers declared with a reduce-then-flatten plan:
 *      drawdown latch, kill switch, mandate expiry.
 *
 * Verdicts: PROMOTE_TO_LIVE / HOLD (growing evidence) / BLOCKED (fault).
 * Pure functions (no I/O): the owner workflow persists what these accept.
 */

export type GateId = "G0" | "G1" | "G2" | "G3" | "G4";

export interface CapitalPromotion {
  fromCapUsd: number;
  toCapUsd: number;
  /** Owner signature over the exact (from, to, expiry, strategy) tuple. */
  ownerAuth: string;
  expiresAt: Date | string;
}

export interface MonitoringDeclaration {
  systemHealth: boolean;
  venueMode: boolean;
  accountMode: boolean;
}

export interface RollbackPlan {
  triggers: string[];
  steps: string[];
}

const REQUIRED_TRIGGERS = ["drawdown-latch", "kill-switch", "mandate-expiry"];

export type PromotionVerdict =
  | { decision: "PROMOTE_TO_LIVE"; reasons: string[] }
  | { decision: "HOLD" | "BLOCKED"; reasons: string[]; code: string };

export function evaluateLivePromotion(input: {
  strategy: string;
  profile: string;
  gates: Record<GateId, boolean>;
  promotion: CapitalPromotion;
  monitoring: MonitoringDeclaration;
  rollback: RollbackPlan;
  now?: Date;
}): PromotionVerdict {
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  // 1. Every gate G0–G4 must pass for THIS strategy/profile.
  const failed = (Object.keys(input.gates) as GateId[]).filter(
    (g) => !input.gates[g],
  );
  if (failed.length > 0) {
    return {
      decision: "HOLD",
      code: "GATES_PENDING",
      reasons: [
        `gates pending for ${input.strategy}/${input.profile}: ${failed.join(", ")}`,
      ],
    };
  }
  reasons.push("gates G0-G4 passed for this strategy/profile");

  // 2. Explicit capital promotion: signed, increasing, unexpired.
  const promo = input.promotion;
  if (!promo.ownerAuth) {
    return {
      decision: "BLOCKED",
      code: "PROMOTION_UNSIGNED",
      reasons: [...reasons, "capital promotion lacks owner authorization"],
    };
  }
  if (
    !Number.isFinite(promo.fromCapUsd) ||
    !Number.isFinite(promo.toCapUsd) ||
    promo.toCapUsd <= promo.fromCapUsd
  ) {
    return {
      decision: "BLOCKED",
      code: "PROMOTION_INVALID",
      reasons: [
        ...reasons,
        "promotion must raise the cap (toCap > fromCap, both finite)",
      ],
    };
  }
  const expiry = promo.expiresAt instanceof Date ? promo.expiresAt : new Date(promo.expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    return {
      decision: "BLOCKED",
      code: "PROMOTION_EXPIRED",
      reasons: [...reasons, "capital promotion expired"],
    };
  }
  reasons.push(
    `explicit capital promotion ${promo.fromCapUsd} -> ${promo.toCapUsd} signed and live`,
  );

  // 3. Monitoring: all three distinct streams declared.
  const missingStreams = (Object.keys(input.monitoring) as Array<
    keyof MonitoringDeclaration
  >).filter((k) => !input.monitoring[k]);
  if (missingStreams.length > 0) {
    return {
      decision: "BLOCKED",
      code: "MONITORING_GAP",
      reasons: [...reasons, `monitoring missing: ${missingStreams.join(", ")}`],
    };
  }
  reasons.push("monitoring declared: system-health, venue-mode, account-mode");

  // 4. Rollback: required triggers plus an ordered reduce-then-flatten plan.
  const missingTriggers = REQUIRED_TRIGGERS.filter(
    (t) => !input.rollback.triggers.includes(t),
  );
  if (missingTriggers.length > 0) {
    return {
      decision: "BLOCKED",
      code: "ROLLBACK_INCOMPLETE",
      reasons: [...reasons, `rollback triggers missing: ${missingTriggers.join(", ")}`],
    };
  }
  if (input.rollback.steps.length === 0) {
    return {
      decision: "BLOCKED",
      code: "ROLLBACK_INCOMPLETE",
      reasons: [...reasons, "rollback plan has no ordered steps"],
    };
  }
  reasons.push("rollback triggers + ordered plan declared");
  return { decision: "PROMOTE_TO_LIVE", reasons };
}
