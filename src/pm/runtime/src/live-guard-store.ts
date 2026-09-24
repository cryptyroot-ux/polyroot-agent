/**
 * @polyroot/runtime — Durable live-guard latch store.
 *
 * Persists the loss-cap latch (`live_guard_state`, single row keyed
 * 'micro-live') so a breach stays engaged across restarts until an
 * explicit owner reset. Accepts any pg-Pool-like `{ query }` for testability.
 */

import type { LossGuardState } from "./micro-live-guard.js";

/** SHADOW baseline required before MICRO_LIVE may start (mirrors the
 *  G4 defaults in getDefaultModeConfig: 30 days, 100 resolved clusters). */
export const SHADOW_BASELINE_MIN_DAYS = 30;
export const SHADOW_BASELINE_MIN_CLUSTERS = 100;

export interface ShadowBaselineRow {
  observed_days: unknown;
  resolved_clusters: unknown;
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Pure startup-gate decision: may MICRO_LIVE start given this baseline row? */
export function checkShadowBaselineRow(
  row: ShadowBaselineRow | null,
): { ok: true } | { ok: false; code: string; reason: string } {
  const days = row ? toFiniteNumber(row.observed_days) : undefined;
  const clusters = row ? toFiniteNumber(row.resolved_clusters) : undefined;
  if (days === undefined || clusters === undefined) {
    return {
      ok: false,
      code: "MICRO_LIVE_NOT_READY",
      reason: "no shadow baseline row found: run SHADOW mode first",
    };
  }
  if (
    days < SHADOW_BASELINE_MIN_DAYS ||
    clusters < SHADOW_BASELINE_MIN_CLUSTERS
  ) {
    return {
      ok: false,
      code: "MICRO_LIVE_NOT_READY",
      reason:
        `shadow baseline ${days}d/${clusters} clusters < ` +
        `${SHADOW_BASELINE_MIN_DAYS}d/${SHADOW_BASELINE_MIN_CLUSTERS} clusters`,
    };
  }
  return { ok: true };
}

/** Pure owner-reset decision: may a latched breach be cleared? */
export function decideGuardReset(
  state: LossGuardState | null,
  realizedLossPusd: number,
  lossCapPusd: number,
): { ok: true; reason: string } | { ok: false; code: string; reason: string } {
  if (!state || !state.halted) {
    return { ok: true, reason: "latch already clear: nothing to reset" };
  }
  if (
    !Number.isFinite(realizedLossPusd) ||
    !Number.isFinite(lossCapPusd) ||
    lossCapPusd <= 0
  ) {
    return {
      ok: false,
      code: "GUARD_RESET_INVALID",
      reason: "reset requires a finite measured loss and a positive loss cap",
    };
  }
  if (realizedLossPusd >= lossCapPusd) {
    return {
      ok: false,
      code: "GUARD_RESET_REFUSED",
      reason: `reset refused: realized loss ${realizedLossPusd} still at/over cap ${lossCapPusd}`,
    };
  }
  return {
    ok: true,
    reason: `latch cleared: realized loss ${realizedLossPusd} back under cap ${lossCapPusd}`,
  };
}

export interface QueryablePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

const LATCH_KEY = "micro-live";

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

export class PgLiveGuardStore {
  constructor(private readonly pool: QueryablePool) {}

  async load(): Promise<LossGuardState | null> {
    const res = await this.pool.query(
      `SELECT halted, halted_at, realized_loss_pusd
       FROM live_guard_state WHERE key = $1`,
      [LATCH_KEY],
    );
    const row = res.rows[0];
    if (!row) return null;
    const state: LossGuardState = {
      halted: row["halted"] === true,
      realizedLossPusd: toNumber(row["realized_loss_pusd"]),
    };
    if (typeof row["halted_at"] === "string") {
      state.haltedAt = row["halted_at"] as string;
    } else if (row["halted_at"] instanceof Date) {
      state.haltedAt = (row["halted_at"] as Date).toISOString();
    }
    return state;
  }

  async save(state: LossGuardState): Promise<void> {
    await this.pool.query(
      `INSERT INTO live_guard_state (key, halted, halted_at, realized_loss_pusd, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         halted = EXCLUDED.halted,
         halted_at = EXCLUDED.halted_at,
         realized_loss_pusd = EXCLUDED.realized_loss_pusd,
         updated_at = now()`,
      [LATCH_KEY, state.halted, state.haltedAt ?? null, state.realizedLossPusd],
    );
  }
}
