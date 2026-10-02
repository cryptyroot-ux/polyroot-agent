/**
 * @polyroot/runtime — Durable live-guard latch store.
 *
 * Persists the loss-cap latch (`live_guard_state`, single row keyed
 * 'micro-live') so a breach stays engaged across restarts until an
 * explicit owner reset. Accepts any pg-Pool-like `{ query }` for testability.
 */

import type { LossGuardState } from "./micro-live-guard.js";
import {
  resolveLiveAdmission,
  type GateId,
  type MonitoringDeclaration,
  type RollbackPlan,
} from "@polyroot/control";

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

/* ─── Owner-signed LIVE promotions (admission source) ─────────────────── */

export interface PromotionRow {
  id: string;
  strategy: string;
  profile: string;
  fromCapUsd: number;
  toCapUsd: number;
  expiresAt: string;
  ownerAddress: string;
  signature: string;
  monitoring: MonitoringDeclaration;
  rollback: RollbackPlan;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    if (typeof value === "string") return JSON.parse(value) as T;
    if (typeof value === "object" && value !== null) return value as T;
  } catch {
    // fall through
  }
  return fallback;
}

export class PgPromotionStore {
  constructor(private readonly pool: QueryablePool) {}

  /** Latest live (unrevoked, unexpired) promotion for a strategy/profile. */
  async latest(
    strategy: string,
    profile: string,
    now: Date = new Date(),
  ): Promise<(PromotionRow & { id: string }) | null> {
    let res;
    try {
      res = await this.pool.query(
        `SELECT id, strategy, profile, from_cap_usd, to_cap_usd, expires_at,
                owner_address, signature, monitoring_json, rollback_json
         FROM live_promotions
         WHERE strategy = $1 AND profile = $2
           AND revoked_at IS NULL AND expires_at > $3::timestamptz
         ORDER BY created_at DESC LIMIT 1`,
        [strategy, profile, now.toISOString()],
      );
    } catch {
      return null; // table missing (migrations pending) = no admission
    }
    const row = res.rows[0];
    if (!row) return null;
    const num = (v: unknown): number =>
      typeof v === "string" ? Number(v) : (v as number);
    const iso = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : String(v ?? "");
    return {
      id: String(row["id"]),
      strategy: String(row["strategy"]),
      profile: String(row["profile"]),
      fromCapUsd: num(row["from_cap_usd"]),
      toCapUsd: num(row["to_cap_usd"]),
      expiresAt: iso(row["expires_at"]),
      ownerAddress: String(row["owner_address"]),
      signature: String(row["signature"]),
      monitoring: parseJson<MonitoringDeclaration>(row["monitoring_json"], {
        systemHealth: false,
        venueMode: false,
        accountMode: false,
      }),
      rollback: parseJson<RollbackPlan>(row["rollback_json"], {
        triggers: [],
        steps: [],
      }),
    };
  }

  async insert(input: {
    strategy: string;
    profile: string;
    fromCapUsd: number;
    toCapUsd: number;
    expiresAt: string;
    ownerAddress: string;
    signature: string;
    monitoring: MonitoringDeclaration;
    rollback: RollbackPlan;
    createdBy: string;
  }): Promise<string> {
    const res = await this.pool.query(
      `INSERT INTO live_promotions
         (strategy, profile, from_cap_usd, to_cap_usd, expires_at,
          owner_address, signature, monitoring_json, rollback_json, created_by)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9::jsonb,$10)
       RETURNING id`,
      [
        input.strategy,
        input.profile,
        input.fromCapUsd,
        input.toCapUsd,
        input.expiresAt,
        input.ownerAddress,
        input.signature,
        JSON.stringify(input.monitoring),
        JSON.stringify(input.rollback),
        input.createdBy,
      ],
    );
    return String(res.rows[0]?.["id"] ?? "");
  }

  async revoke(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE live_promotions SET revoked_at = now()
       WHERE id = $1::uuid AND revoked_at IS NULL`,
      [id],
    );
    return ((res as { rowCount?: number | null }).rowCount ?? 0) > 0;
  }

  async listActive(
    strategy?: string,
    profile?: string,
  ): Promise<PromotionRow[]> {
    const conds: string[] = ["revoked_at IS NULL"];
    const params: unknown[] = [];
    if (strategy) {
      params.push(strategy);
      conds.push(`strategy = $${params.length}`);
    }
    if (profile) {
      params.push(profile);
      conds.push(`profile = $${params.length}`);
    }
    const res = await this.pool.query(
      `SELECT id, strategy, profile, from_cap_usd, to_cap_usd, expires_at,
              owner_address, signature, monitoring_json, rollback_json
       FROM live_promotions WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC LIMIT 50`,
      params,
    );
    const num = (v: unknown): number =>
      typeof v === "string" ? Number(v) : (v as number);
    const iso = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : String(v ?? "");
    return res.rows.map((row) => ({
      id: String(row["id"]),
      strategy: String(row["strategy"]),
      profile: String(row["profile"]),
      fromCapUsd: num(row["from_cap_usd"]),
      toCapUsd: num(row["to_cap_usd"]),
      expiresAt: iso(row["expires_at"]),
      ownerAddress: String(row["owner_address"]),
      signature: String(row["signature"]),
      monitoring: parseJson<MonitoringDeclaration>(row["monitoring_json"], {
        systemHealth: false,
        venueMode: false,
        accountMode: false,
      }),
      rollback: parseJson<RollbackPlan>(row["rollback_json"], {
        triggers: [],
        steps: [],
      }),
    }));
  }
}

export interface StartupAdmissionDeps {
  pool: QueryablePool;
  ownerAddress: string;
  strategy: string;
  profile: string;
  /** Applied migration filenames (G0: schema-current). */
  appliedMigrations: string[];
  /** Migration filenames shipped with this build. */
  shippedMigrations: string[];
  /**
   * Code identity (G1): release_manifest.json lockfile sha vs the running
   * tree's package-lock.json sha. Both hex digests; equal = built tree.
   */
  manifestLockSha?: string;
  runningLockSha?: string;
  /** G3: wallet key resolvable + venue creds present. */
  walletOk: boolean;
  venueCredsOk: boolean;
  staleMinutes?: number;
  now?: Date;
}

export interface StartupAdmission {
  admitted: boolean;
  promotionId?: string | undefined;
  reasons: string[];
  code?: string | undefined;
  gates?: Record<GateId, boolean> | undefined;
}

/**
 * Startup LIVE admission: crypto proof + live operational gates.
 * Every leg names its reason; anything unverifiable blocks (fail-closed).
 * Only called for mode === LIVE; other modes never consult it.
 */
export async function resolveStartupAdmission(
  deps: StartupAdmissionDeps,
): Promise<StartupAdmission> {
  const now = deps.now ?? new Date();
  const store = new PgPromotionStore(deps.pool);
  const promo = await store.latest(deps.strategy, deps.profile, now);
  if (!promo) {
    return {
      admitted: false,
      code: "PROMOTION_ABSENT",
      reasons: [
        `no live owner-signed promotion for ${deps.strategy}/${deps.profile} — grant one with \`polyroot live-promote\``,
      ],
    };
  }

  const gates: Record<GateId, boolean> = {
    G0: false,
    G1: false,
    G2: false,
    G3: false,
    G4: false,
  };
  const blockers: string[] = [];

  // G0: every shipped migration applied.
  try {
    const applied = new Set(deps.appliedMigrations);
    const missing = deps.shippedMigrations.filter((f) => !applied.has(f));
    gates.G0 = missing.length === 0;
    if (!gates.G0)
      blockers.push(`G0 schema stale: missing ${missing.join(", ")}`);
  } catch {
    blockers.push("G0 schema check failed");
  }

  // G1: running tree is the manifested tree (lockfile digest match).
  if (
    deps.manifestLockSha &&
    deps.runningLockSha &&
    deps.manifestLockSha === deps.runningLockSha
  ) {
    gates.G1 = true;
  } else {
    blockers.push(
      "G1 code identity unproven (release manifest lockfile mismatch or unreadable)",
    );
  }

  // G2: loss latch clear + reconciliation clean (operational, re-checked live).
  try {
    const latch = await new PgLiveGuardStore(deps.pool).load();
    const staleMinutes = deps.staleMinutes ?? 30;
    let stale = -1;
    try {
      const r = await deps.pool.query(
        `SELECT count(*)::text AS c FROM recovery_ledger
         WHERE resolved = false
           AND state IN ('SUBMISSION_UNKNOWN', 'CANCEL_UNKNOWN')
           AND updated_at < now() - make_interval(mins => $1)`,
        [staleMinutes],
      );
      stale = Number(r.rows[0]?.["c"] ?? 0);
    } catch {
      stale = -1;
    }
    gates.G2 = (latch?.halted ?? false) === false && stale === 0;
    if ((latch?.halted ?? false) !== false)
      blockers.push("G2 loss latch engaged");
    if (stale !== 0)
      blockers.push(
        stale < 0
          ? "G2 reconciliation state unreadable"
          : `G2 ${stale} stale unknown order(s) — reconcile first`,
      );
  } catch {
    blockers.push("G2 guard state unreadable");
  }

  // G3: key custody + venue credentials.
  gates.G3 = deps.walletOk && deps.venueCredsOk;
  if (!deps.walletOk) blockers.push("G3 wallet key unresolvable");
  if (!deps.venueCredsOk) blockers.push("G3 venue credentials absent");

  // G4: SHADOW baseline (30d / 100 clusters) from the durable row.
  try {
    const r = await deps.pool.query(
      `SELECT observed_days, resolved_clusters FROM shadow_baseline ORDER BY id DESC LIMIT 1`,
    );
    const check = checkShadowBaselineRow(
      (r.rows[0] as ShadowBaselineRow | undefined) ?? null,
    );
    if (check.ok === true) {
      gates.G4 = true;
    } else {
      blockers.push(`G4 ${check.reason}`);
    }
  } catch {
    blockers.push("G4 shadow baseline unreadable");
  }

  const decision = resolveLiveAdmission({
    tuple: {
      strategy: promo.strategy,
      profile: promo.profile,
      fromCapUsd: promo.fromCapUsd,
      toCapUsd: promo.toCapUsd,
      expiresAt: promo.expiresAt,
    },
    signature: promo.signature,
    ownerAddress: deps.ownerAddress,
    gates,
    monitoring: promo.monitoring,
    rollback: promo.rollback,
    now,
  });
  return {
    admitted: decision.admitted,
    promotionId: decision.admitted ? promo.id : undefined,
    reasons: [...blockers, ...decision.reasons],
    code: decision.admitted
      ? undefined
      : (decision.code ?? "ADMISSION_BLOCKED"),
    gates,
  };
}
