/**
 * @polyroot/intelligence — Pre-action gates (FT-27, FT-44).
 *
 *   FT-27 rules/catalyst race (PM-INTEL-07) — an invalidation event that
 *           lands after the consumer watermark and before signing means the
 *           forecast's world may have changed: the permit watermark check
 *           mismatches, the action is rejected, and resting orders are
 *           cancelled per policy (the cancel decision itself travels with
 *           the rejection, it is never implied).
 *   FT-44 model budget exhausted (PM-AI-05) — inference spend past its cap
 *           blocks new research calls. Budgets are per (consumer, window);
 *           exhaustion is fail-closed, never a silent downgrade to a
 *           cheaper model.
 *
 * Pure functions (no I/O): watermarks and spend counters live in the
 * durable stores; these contracts decide what may proceed.
 */

import type { CatalystEvent } from "@polyroot/domain";

export type FreshnessCode = "WATERMARK_MISMATCH" | "WATERMARK_MISSING";

export type FreshnessResult =
  | { fresh: true }
  | {
      fresh: false;
      code: FreshnessCode;
      reason: string;
      /** Invalidating events observed after the watermark. */
      invalidating: CatalystEvent[];
      /** The caller must cancel resting orders per policy on mismatch. */
      cancelRestingPerPolicy: true;
    };

/**
 * Check whether a consumer watermark is still current. Every catalyst
 * category (rules, announcements, polls, observations, schedules,
 * anomalies) is invalidation-relevant: ANY event after the watermark
 * makes the forecast stale. A missing watermark (never initialized) is
 * also stale — bootstrapping it is an explicit, auditable caller action,
 * never an implicit pass.
 */
export function checkCatalystFreshness(input: {
  watermarkEventId: string | null;
  /** Outbox ordered oldest → newest. */
  outbox: CatalystEvent[];
}): FreshnessResult {
  if (!input.watermarkEventId) {
    return {
      fresh: false,
      code: "WATERMARK_MISSING",
      reason: "no consumer watermark recorded; initialize explicitly before acting",
      invalidating: [...input.outbox],
      cancelRestingPerPolicy: true,
    };
  }
  const idx = input.outbox.findIndex((e) => e.event_id === input.watermarkEventId);
  // Unknown watermark id (trimmed outbox, new consumer, forked stream):
  // nothing after it can be proven fresh.
  if (idx < 0) {
    return {
      fresh: false,
      code: "WATERMARK_MISMATCH",
      reason: "watermark id not found in outbox; cannot prove freshness",
      invalidating: [...input.outbox],
      cancelRestingPerPolicy: true,
    };
  }
  const after = input.outbox.slice(idx + 1);
  if (after.length > 0) {
    return {
      fresh: false,
      code: "WATERMARK_MISMATCH",
      reason: `${after.length} invalidation-relevant event(s) after watermark ${input.watermarkEventId}`,
      invalidating: after,
      cancelRestingPerPolicy: true,
    };
  }
  return { fresh: true };
}

/* ─── FT-44: inference budget ──────────────────────────────────────── */

export type BudgetVerdict =
  | { ok: true; remaining: number }
  | { ok: false; code: "BUDGET_EXHAUSTED"; reason: string; remaining: 0 };

/**
 * Inference spend gate. Exhaustion blocks new research calls outright —
 * the caller must not silently fall back to a cheaper/unaligned model,
 * because that would invalidate the calibration segment (FT-40).
 */
export function checkInferenceBudget(input: {
  spent: number;
  cap: number;
}): BudgetVerdict {
  if (
    !Number.isFinite(input.spent) ||
    !Number.isFinite(input.cap) ||
    input.spent < 0 ||
    !(input.cap > 0)
  ) {
    return {
      ok: false,
      code: "BUDGET_EXHAUSTED",
      reason: "invalid budget measurement; fail closed",
      remaining: 0,
    };
  }
  const remaining = input.cap - input.spent;
  if (remaining <= 0) {
    return {
      ok: false,
      code: "BUDGET_EXHAUSTED",
      reason: `inference budget exhausted (spent ${input.spent} of cap ${input.cap})`,
      remaining: 0,
    };
  }
  return { ok: true, remaining };
}
