/**
 * @polyroot/runtime-pg — PostgreSQL-backed logging/runtime for gates G4-G6.
 * Connects the Paper/Shadow engine to migration 0006 tables.
 */

import { Pool, type PoolConfig } from "pg";
import type { SimulatedFill, ProbQuality } from "./paper-engine.js";

export interface PaperLogRow {
  market_id: string;
  action: "BUY" | "SELL" | "NO_TRADE" | "ABSTAIN";
  forecastP: number | null;
  size: number;
  fillStatus: SimulatedFill["status"];
  filledSize: number;
  fillPrice: number | null;
  makerFee: number;
  takerFee: number;
  uncertainty: number;
  experimentId: string | null;
  loopEpoch: number;
}

export type ExperimentMode = "PAPER" | "SHADOW" | "MICRO_LIVE";

export interface ExperimentRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  preregisteredRule: string;
  status: "PREREGISTERED" | "RUNNING" | "CONCLUDED" | "WITHDRAWN";
  mode: ExperimentMode;
  createdAt: Date;
  concludedAt: Date | null;
}

/**
 * PostgreSQL-backed Paper log (G4). Every simulated decision is persisted.
 * No financial I/O — this is the full-universe logging requirement.
 */
export class PgPaperLog {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async insert(row: PaperLogRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO paper_log
         (market_id, action, forecast_p, size, fill_status, filled_size, fill_price,
          maker_fee, taker_fee, pnl_latency_ms, uncertainty, experiment_id, loop_epoch, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12, now())`,
      [
        row.market_id,
        row.action,
        row.forecastP,
        row.size,
        row.fillStatus,
        row.filledSize,
        row.fillPrice,
        row.makerFee,
        row.takerFee,
        row.uncertainty,
        row.experimentId,
        row.loopEpoch,
      ],
    );
  }

  async count(): Promise<number> {
    const r = await this.pool.query("SELECT COUNT(*)::int AS c FROM paper_log");
    return r.rows[0].c as number;
  }

  async countByAction(): Promise<Record<string, number>> {
    const r = await this.pool.query(
      "SELECT action, COUNT(*)::int AS c FROM paper_log GROUP BY action",
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.action] = row.c;
    return out;
  }
}

/**
 * PostgreSQL-backed experiment registry (PR-VAL-08, append-only).
 */
export class PgExperimentRegistry {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  /** Preregister an experiment BEFORE it runs (no cherry-picking). */
  async preregister(input: {
    name: string;
    version: string;
    description?: string;
    preregisteredRule: string;
    mode: ExperimentMode;
  }): Promise<ExperimentRow> {
    const r = await this.pool.query(
      `INSERT INTO experiments (name, version, description, preregistered_rule, mode, status)
       VALUES ($1,$2,$3,$4,$5,'PREREGISTERED') RETURNING *`,
      [
        input.name,
        input.version,
        input.description ?? null,
        input.preregisteredRule,
        input.mode,
      ],
    );
    return this.mapRow(r.rows[0]);
  }

  async conclude(
    id: string,
    metrics: { quality: ProbQuality; netPnl: number; maxDrawdownPct: number },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE experiments SET status='CONCLUDED', concluded_at=now() WHERE id=$1`,
      [id],
    );
    await this.pool.query(
      `INSERT INTO experiment_results
         (experiment_id, brier, log_loss, calibration_error, sharpness, coverage,
          abstention_rate, n, net_pnl, max_drawdown_pct, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [
        id,
        metrics.quality.brier,
        metrics.quality.logLoss,
        metrics.quality.calibrationError,
        metrics.quality.sharpness,
        metrics.quality.coverage,
        metrics.quality.abstentionRate,
        metrics.quality.n,
        metrics.netPnl,
        metrics.maxDrawdownPct,
      ],
    );
  }

  async get(id: string): Promise<ExperimentRow | undefined> {
    const r = await this.pool.query(`SELECT * FROM experiments WHERE id=$1`, [
      id,
    ]);
    return r.rows[0] ? this.mapRow(r.rows[0]) : undefined;
  }

  async all(): Promise<ExperimentRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM experiments ORDER BY created_at`,
    );
    return r.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): ExperimentRow {
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      version: String(row["version"]),
      description: row["description"] ? String(row["description"]) : null,
      preregisteredRule: String(row["preregistered_rule"]),
      status: row["status"] as ExperimentRow["status"],
      mode: row["mode"] as ExperimentMode,
      createdAt: new Date(row["created_at"] as string),
      concludedAt: row["concluded_at"]
        ? new Date(row["concluded_at"] as string)
        : null,
    };
  }
}

export interface ShadowBaselineSnapshot {
  observedDays: number;
  resolvedClusters: number;
  versionsFrozenSha: string | null;
  preregistered: boolean;
  stStoppingRule: string | null;
  gatePassed: boolean;
}

/**
 * PostgreSQL-backed SHADOW baseline tracker (G5). The gate is defined by
 * eval criteria (30 days / 100 clusters); the DB is the source of truth.
 */
export class PgShadowBaseline {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async recordDay(_account = "default"): Promise<void> {
    await this.pool.query(
      `UPDATE shadow_baseline
       SET observed_days = EXTRACT(EPOCH FROM (now() - observed_started_at))/86400.0,
           updated_at = now()
       WHERE id='00000000-0000-0000-0000-000000000001'`,
    );
  }

  async snapshot(_account = "default"): Promise<ShadowBaselineSnapshot> {
    const r = await this.pool.query(
      `SELECT observed_days, resolved_clusters, versions_frozen_sha, preregistered, pr_stopping_rule
       FROM shadow_baseline WHERE id='00000000-0000-0000-0000-000000000001'`,
    );
    const s = r.rows[0];
    const observedDays = Number(s?.observed_days ?? 0);
    const resolvedClusters = Number(s?.resolved_clusters ?? 0);
    return {
      observedDays,
      resolvedClusters,
      versionsFrozenSha: s?.versions_frozen_sha ?? null,
      preregistered: Boolean(s?.preregistered),
      stStoppingRule: s?.pr_stopping_rule ?? null,
      gatePassed: observedDays >= 30 && resolvedClusters >= 100,
    };
  }

  async freezeVersion(
    sha: string,
    prerule: string,
    _account = "default",
  ): Promise<void> {
    await this.pool.query(
      `UPDATE shadow_baseline
       SET versions_frozen_sha=$1, pr_stopping_rule=$2, preregistered=TRUE, updated_at=now()
       WHERE id='00000000-0000-0000-0000-000000000001'`,
      [sha, prerule],
    );
  }
}

/**
 * PostgreSQL-backed SHADOW decision log (G5).
 * Mirrors paper_log but for SHADOW mode (live data, no financial I/O).
 * No fill simulation — records actual market decisions without execution.
 */
export interface ShadowLogRow {
  market_id: string;
  action: "BUY" | "SELL" | "NO_TRADE" | "ABSTAIN";
  forecastP: number | null;
  size: number;
  uncertainty: number;
  experimentId: string | null;
  loopEpoch: number;
}

export class PgShadowLog {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async insert(row: ShadowLogRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO shadow_log
         (market_id, action, forecast_p, size, fill_status, filled_size, fill_price,
          maker_fee, taker_fee, pnl_latency_ms, uncertainty, experiment_id, loop_epoch, created_at)
       VALUES ($1,$2,$3,$4,'NONE',0,NULL,0,0,0,$5,$6,$7,now())`,
      [
        row.market_id,
        row.action,
        row.forecastP,
        row.size,
        row.uncertainty,
        row.experimentId,
        row.loopEpoch,
      ],
    );
  }

  async count(): Promise<number> {
    const r = await this.pool.query("SELECT COUNT(*)::int AS c FROM shadow_log");
    return r.rows[0].c as number;
  }

  async countByAction(): Promise<Record<string, number>> {
    const r = await this.pool.query(
      "SELECT action, COUNT(*)::int AS c FROM shadow_log GROUP BY action",
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.action] = row.c;
    return out;
  }
}

/**
 * PostgreSQL-backed resolved cluster tracker (G5).
 * Tracks resolved independent event clusters for the 100-cluster requirement.
 */
export interface ResolvedClusterRow {
  clusterId: string;
  eventId: string;
  marketIds: string[];
  resolutionOutcome: string;
  resolvedAt: Date;
  isIndependent: boolean;
  clusterHash: string;
}

export class PgResolvedClusters {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async insert(row: ResolvedClusterRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO resolved_clusters
         (cluster_id, event_id, market_ids, resolution_outcome, resolved_at, is_independent, cluster_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (cluster_hash) DO NOTHING`,
      [
        row.clusterId,
        row.eventId,
        row.marketIds,
        row.resolutionOutcome,
        row.resolvedAt,
        row.isIndependent,
        row.clusterHash,
      ],
    );
  }

  async count(): Promise<number> {
    const r = await this.pool.query(
      "SELECT COUNT(*)::int AS c FROM resolved_clusters WHERE is_independent = TRUE",
    );
    return r.rows[0].c as number;
  }

  async getByHash(hash: string): Promise<ResolvedClusterRow | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM resolved_clusters WHERE cluster_hash = $1",
      [hash],
    );
    if (r.rows.length === 0) return undefined;
    return this.mapRow(r.rows[0]);
  }

  async listRecent(limit = 100): Promise<ResolvedClusterRow[]> {
    const r = await this.pool.query(
      "SELECT * FROM resolved_clusters WHERE is_independent = TRUE ORDER BY resolved_at DESC LIMIT $1",
      [limit],
    );
    return r.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): ResolvedClusterRow {
    return {
      clusterId: String(row["cluster_id"]),
      eventId: String(row["event_id"]),
      marketIds: row["market_ids"] as string[],
      resolutionOutcome: String(row["resolution_outcome"]),
      resolvedAt: new Date(row["resolved_at"] as string),
      isIndependent: Boolean(row["is_independent"]),
      clusterHash: String(row["cluster_hash"]),
    };
  }
}

/**
 * PostgreSQL-backed SHADOW gate evaluation log.
 * Records each G5 gate evaluation attempt for audit trail.
 */
export interface ShadowGateEvaluationRow {
  evaluatedAt: Date;
  observedDays: number;
  resolvedClusters: number;
  gatePassed: boolean;
  snapshot: Record<string, unknown>;
  account: string;
}

export class PgShadowGateEvaluation {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async insert(row: ShadowGateEvaluationRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO shadow_gate_evaluations
         (evaluated_at, observed_days, resolved_clusters, gate_passed, snapshot, account)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.evaluatedAt,
        row.observedDays,
        row.resolvedClusters,
        row.gatePassed,
        JSON.stringify(row.snapshot),
        row.account,
      ],
    );
  }

  async getLatest(account = "default"): Promise<ShadowGateEvaluationRow | undefined> {
    const r = await this.pool.query(
      `SELECT * FROM shadow_gate_evaluations WHERE account = $1 ORDER BY evaluated_at DESC LIMIT 1`,
      [account],
    );
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    return {
      evaluatedAt: new Date(row.evaluated_at as string),
      observedDays: Number(row.observed_days),
      resolvedClusters: Number(row.resolved_clusters),
      gatePassed: Boolean(row.gate_passed),
      snapshot: row.snapshot as Record<string, unknown>,
      account: String(row.account),
    };
  }

  async list(account = "default", limit = 50): Promise<ShadowGateEvaluationRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM shadow_gate_evaluations WHERE account = $1 ORDER BY evaluated_at DESC LIMIT $2`,
      [account, limit],
    );
    return r.rows.map((row) => ({
      evaluatedAt: new Date(row.evaluated_at as string),
      observedDays: Number(row.observed_days),
      resolvedClusters: Number(row.resolved_clusters),
      gatePassed: Boolean(row.gate_passed),
      snapshot: row.snapshot as Record<string, unknown>,
      account: String(row.account),
    }));
  }
}

export function createPgRuntimeStores(config: PoolConfig | string): {
  paperLog: PgPaperLog;
  shadowLog: PgShadowLog;
  experiments: PgExperimentRegistry;
  shadow: PgShadowBaseline;
  resolvedClusters: PgResolvedClusters;
  shadowGate: PgShadowGateEvaluation;
  pool: Pool;
} {
  const pool = new Pool(
    typeof config === "string" ? { connectionString: config } : config,
  );
  return {
    paperLog: new PgPaperLog(pool),
    shadowLog: new PgShadowLog(pool),
    experiments: new PgExperimentRegistry(pool),
    shadow: new PgShadowBaseline(pool),
    resolvedClusters: new PgResolvedClusters(pool),
    shadowGate: new PgShadowGateEvaluation(pool),
    pool,
  };
}
