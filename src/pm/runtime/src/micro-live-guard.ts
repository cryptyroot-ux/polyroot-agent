/**
 * @polyroot/runtime — G4 micro-LIVE safety harness (PRD G4, Blueprint §8/§13).
 *
 * Micro-LIVE is owner-capped calibration, not a promotion: bounded loss,
 * authenticated venue behavior, and reality-gap coverage must all hold
 * before a single real order is allowed. This module is the pure,
 * unit-testable core of that gate:
 *
 *   1. Loss-cap latch — realized loss vs the owner-set cap. Once breached
 *      the latch STAYS engaged until an explicit owner reset; there is no
 *      timed auto-resume (a restart must never clear a breach). Cancel,
 *      reconcile and monitoring paths are never blocked — only entries.
 *   2. G4 readiness — combines the SHADOW baseline (days + resolved
 *      clusters), the reality-gap verdict, and the loss latch into one
 *      three-state decision: PROMOTE / HOLD / BLOCKED.
 *
 * Pure functions (no I/O): the caller persists the returned latch state.
 */

import { levelAtLeast, type KillLevel } from "@polyroot/risk";
import {
  evaluateShadowCandidate,
  type ShadowCriteria,
} from "./paper-engine.js";
import {
  evaluateRealityGap,
  type RealityGapInput,
  type RealityGapTolerances,
} from "./reality-gap.js";

/* ─── Loss-cap latch ─────────────────────────────────────────────────── */

export type LossGuardCode =
  | "LOSS_WITHIN_CAP"
  | "LOSS_CAP_BREACHED"
  | "LOSS_CAP_LATCHED"
  | "LOSS_CAP_UNCONFIGURED";

export interface LossGuardState {
  halted: boolean;
  haltedAt?: string | undefined;
  realizedLossPusd: number;
}

export interface LossGuardInput {
  /** Realized loss in pUSD (>= 0). Never a forecast or unrealized value. */
  realizedLossPusd: number;
  /** Owner-set loss cap in pUSD. Must be finite and > 0. */
  lossCapPusd: number;
  /** Explicit owner reset. Clears the latch only if loss is back under cap. */
  reset: boolean;
  /** Previously persisted latch state, or null on first evaluation. */
  previous: LossGuardState | null;
  now?: Date;
}

export interface LossGuardResult {
  halted: boolean;
  /** Kill level to enforce: PAUSE_ENTRIES while halted, NONE otherwise. */
  level: KillLevel;
  code: LossGuardCode;
  reason: string;
  /** Persist this state; the next evaluation must receive it as `previous`. */
  state: LossGuardState;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function evaluateLossGuard(input: LossGuardInput): LossGuardResult {
  const now = input.now ?? new Date();
  const state: LossGuardState = {
    halted: false,
    realizedLossPusd: input.realizedLossPusd,
  };

  // 0. Unconfigured cap is fail-closed: micro-LIVE without an explicit
  //    owner loss cap is never allowed to trade.
  if (
    !isFiniteNonNegative(input.lossCapPusd) ||
    input.lossCapPusd <= 0 ||
    !isFiniteNonNegative(input.realizedLossPusd)
  ) {
    return {
      halted: true,
      level: "PAUSE_ENTRIES",
      code: "LOSS_CAP_UNCONFIGURED",
      reason: "micro-LIVE requires a finite positive owner loss cap",
      state: { ...state, halted: true, haltedAt: now.toISOString() },
    };
  }

  // 1. Latched breach persists across evaluations AND restarts until an
  //    explicit owner reset. There is deliberately no timeout path.
  if (input.previous?.halted && !input.reset) {
    return {
      halted: true,
      level: "PAUSE_ENTRIES",
      code: "LOSS_CAP_LATCHED",
      reason: `loss-cap breach latched since ${input.previous.haltedAt ?? "unknown"}; explicit owner reset required`,
      state: {
        halted: true,
        haltedAt: input.previous.haltedAt,
        realizedLossPusd: input.realizedLossPusd,
      },
    };
  }

  // 2. Fresh breach (or reset attempted while still in breach).
  if (input.realizedLossPusd >= input.lossCapPusd) {
    return {
      halted: true,
      level: "PAUSE_ENTRIES",
      code: input.reset ? "LOSS_CAP_LATCHED" : "LOSS_CAP_BREACHED",
      reason: input.reset
        ? `reset refused: realized loss ${input.realizedLossPusd} still at/over cap ${input.lossCapPusd}`
        : `realized loss ${input.realizedLossPusd} breached owner cap ${input.lossCapPusd}`,
      state: {
        halted: true,
        haltedAt: input.previous?.haltedAt ?? now.toISOString(),
        realizedLossPusd: input.realizedLossPusd,
      },
    };
  }

  // 3. Under cap (reset clears a prior latch).
  return {
    halted: false,
    level: "NONE",
    code: "LOSS_WITHIN_CAP",
    reason:
      input.previous?.halted && input.reset
        ? "owner reset accepted: loss back under cap"
        : `realized loss ${input.realizedLossPusd} within owner cap ${input.lossCapPusd}`,
    state,
  };
}

/** Entries follow the kill-switch lattice: halted ⇒ blocked at PAUSE_ENTRIES. */
export function microLiveEntriesBlocked(level: KillLevel): boolean {
  return levelAtLeast(level, "PAUSE_ENTRIES");
}

/* ─── G4 readiness gate ──────────────────────────────────────────────── */

export type G4Readiness = "PROMOTE" | "HOLD" | "BLOCKED";

export interface G4ReadinessInput {
  observedDays: number;
  resolvedClusters: number;
  criteria: ShadowCriteria;
  gap: RealityGapInput;
  gapTolerances?: RealityGapTolerances;
  loss: Omit<LossGuardInput, "now"> & { now?: Date };
}

export interface G4ReadinessResult {
  decision: G4Readiness;
  reasons: string[];
  shadow: { passed: boolean; reason: string };
  gapVerdict: string;
  lossCode: LossGuardCode;
  lossHalted: boolean;
}

/**
 * Single promotion gate for SHADOW → MICRO_LIVE.
 *
 *   PROMOTE — baseline met, reality gap PASS, loss latch clear.
 *   HOLD    — baseline growing or evidence insufficient (time/data, not a fault).
 *   BLOCKED — reality-gap FAIL or loss latch engaged (a fault that needs action).
 */
export function evaluateG4Readiness(
  input: G4ReadinessInput,
): G4ReadinessResult {
  const reasons: string[] = [];

  const shadow = evaluateShadowCandidate({
    observedDays: input.observedDays,
    resolvedClusters: input.resolvedClusters,
    criteria: input.criteria,
  });
  if (!shadow.passed) {
    reasons.push(`shadow baseline: ${shadow.reason}`);
    return {
      decision: "HOLD",
      reasons,
      shadow,
      gapVerdict: "NOT_EVALUATED",
      lossCode: "LOSS_WITHIN_CAP",
      lossHalted: false,
    };
  }

  const gap = evaluateRealityGap(input.gap, input.gapTolerances);
  if (gap.verdict === "INCONCLUSIVE") {
    reasons.push(`reality gap inconclusive: ${gap.reasons.join("; ")}`);
    return {
      decision: "HOLD",
      reasons,
      shadow,
      gapVerdict: gap.verdict,
      lossCode: "LOSS_WITHIN_CAP",
      lossHalted: false,
    };
  }
  if (gap.verdict === "FAIL") {
    reasons.push(`reality gap failed: ${gap.reasons.join("; ")}`);
    return {
      decision: "BLOCKED",
      reasons,
      shadow,
      gapVerdict: gap.verdict,
      lossCode: "LOSS_WITHIN_CAP",
      lossHalted: false,
    };
  }

  const loss = evaluateLossGuard(input.loss);
  if (loss.halted) {
    reasons.push(`loss guard: ${loss.reason}`);
    return {
      decision: "BLOCKED",
      reasons,
      shadow,
      gapVerdict: gap.verdict,
      lossCode: loss.code,
      lossHalted: true,
    };
  }

  reasons.push("shadow baseline met; reality gap PASS; loss within cap");
  return {
    decision: "PROMOTE",
    reasons,
    shadow,
    gapVerdict: gap.verdict,
    lossCode: loss.code,
    lossHalted: false,
  };
}
