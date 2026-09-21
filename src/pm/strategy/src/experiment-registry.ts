/**
 * @polyroot/strategy — Immutable Experiment Registry (PR-VAL-08).
 *
 * Preregisters experiment specifications immutably. Records gate results
 * and promotes to LIVE_QUALIFIED only when all gates pass. Prevents
 * p-hacking, cherry-picking, and post-hoc specification changes.
 */

import { randomUUID } from "crypto";
import type { Pool, QueryResult } from "pg"; // eslint-disable-line @typescript-eslint/no-unused-vars
import type { ParameterEnvelope } from "./adaptive-tuner.js";

export interface ExperimentSpec {
  strategy: string;
  version: string;
  params: object;
  envelope: ParameterEnvelope;
}

export interface GateResult {
  gate_name: string;
  passed: boolean;
  score: number;
  threshold: number;
}

export interface GateReport {
  all_passed: boolean;
  gates: GateResult[];
  evaluated_at: Date;
}

export type ExperimentStatus =
  | "PREREGISTERED"
  | "LIVE_QUALIFIED"
  | "REJECTED"
  | "ARCHIVED";

export interface ExperimentRecord {
  id: string;
  spec_hash: string;
  strategy: string;
  version: string;
  params_json: string;
  envelope_json: string;
  status: ExperimentStatus;
  gate_report_json: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Experiment Registry for immutable experiment tracking.
 *
 * Key properties:
 * - Spec is hashed and immutable after registration
 * - Promotion to LIVE_QUALIFIED requires ALL gates to pass
 * - Failed gates result in REJECTED status (no partial promotion)
 * - All operations are auditable via ledger
 */
export class ExperimentRegistry {
  constructor(private pool: Pool) {}

  /**
   * Register a new experiment specification.
   * Returns the experiment ID.
   */
  async register(spec: ExperimentSpec): Promise<string> {
    const specHash = this.hashSpec(spec);
    const id = `exp_${randomUUID()}`;
    const now = new Date();

    // Check for duplicate spec
    const existing = await this.pool.query(
      `SELECT id FROM experiments WHERE spec_hash = $1 AND status != 'ARCHIVED'`,
      [specHash],
    );
    if (existing.rows.length > 0) {
      throw new Error(`Experiment with same spec already exists: ${existing.rows[0].id}`);
    }

    await this.pool.query(
      `INSERT INTO experiments (id, spec_hash, strategy, version, params_json, envelope_json, status, gate_report_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        specHash,
        spec.strategy,
        spec.version,
        JSON.stringify(spec.params),
        JSON.stringify(spec.envelope),
        "PREREGISTERED",
        null,
        now,
        now,
      ],
    );

    return id;
  }

  /**
   * Promote experiment to LIVE_QUALIFIED if all gates pass.
   * If any gate fails, status becomes REJECTED.
   * Cannot change status from LIVE_QUALIFIED or REJECTED.
   */
  async promote(experimentId: string, gateResults: GateReport): Promise<void> {
    const current = await this.get(experimentId);
    if (!current) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    if (current.status === "LIVE_QUALIFIED" || current.status === "REJECTED") {
      throw new Error(
        `Cannot promote experiment in terminal state: ${current.status}`,
      );
    }

    const newStatus: ExperimentStatus = gateResults.all_passed
      ? "LIVE_QUALIFIED"
      : "REJECTED";

    await this.pool.query(
      `UPDATE experiments
       SET status = $1, gate_report_json = $2, updated_at = $3
       WHERE id = $4 AND status = 'PREREGISTERED'`,
      [
        newStatus,
        JSON.stringify(gateResults),
        new Date(),
        experimentId,
      ],
    );

    const result = await this.pool.query(
      `SELECT id FROM experiments WHERE id = $1 AND status = $2`,
      [experimentId, newStatus],
    );

    if (result.rowCount === 0) {
      throw new Error(`Failed to promote experiment ${experimentId} to ${newStatus}`);
    }
  }

  /**
   * Get experiment record by ID.
   */
  async get(experimentId: string): Promise<ExperimentRecord | null> {
    const result = await this.pool.query(
      `SELECT id, spec_hash, strategy, version, params_json, envelope_json, status, gate_report_json, created_at, updated_at
       FROM experiments WHERE id = $1`,
      [experimentId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      spec_hash: row.spec_hash,
      strategy: row.strategy,
      version: row.version,
      params_json: row.params_json,
      envelope_json: row.envelope_json,
      status: row.status as ExperimentStatus,
      gate_report_json: row.gate_report_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * List experiments with optional filters.
   */
  async list(filters?: {
    strategy?: string;
    status?: ExperimentStatus;
    limit?: number;
    offset?: number;
  }): Promise<ExperimentRecord[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.strategy) {
      conditions.push(`strategy = $${paramIndex++}`);
      params.push(filters.strategy);
    }
    if (filters?.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    params.push(limit, offset);
    const limitClause = `LIMIT $${paramIndex++} OFFSET $${paramIndex}`;

    const result = await this.pool.query(
      `SELECT id, spec_hash, strategy, version, params_json, envelope_json, status, gate_report_json, created_at, updated_at
       FROM experiments ${whereClause}
       ORDER BY created_at DESC ${limitClause}`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      spec_hash: row.spec_hash,
      strategy: row.strategy,
      version: row.version,
      params_json: row.params_json,
      envelope_json: row.envelope_json,
      status: row.status as ExperimentStatus,
      gate_report_json: row.gate_report_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /**
   * Archive an experiment (soft delete, preserves history).
   */
  async archive(experimentId: string): Promise<void> {
    const current = await this.get(experimentId);
    if (!current) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    await this.pool.query(
      `UPDATE experiments SET status = 'ARCHIVED', updated_at = $1 WHERE id = $2`,
      [new Date(), experimentId],
    );
  }

  private hashSpec(spec: ExperimentSpec): string {
    // Create a deterministic hash of the experiment spec
    const normalized = JSON.stringify({
      strategy: spec.strategy,
      version: spec.version,
      params: spec.params,
      envelope: {
        envelope_id: spec.envelope.envelope_id,
        envelope_version: spec.envelope.envelope_version,
        allowed_ranges: spec.envelope.allowed_ranges,
        max_step_pct: spec.envelope.max_step_pct,
        pinned_params: spec.envelope.pinned_params.sort(),
        min_data_points: spec.envelope.min_data_points,
      },
    });

    // Simple hash - in production would use crypto.subtle.digest
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `sha_${Math.abs(hash).toString(16)}`;
  }
}

/**
 * SQL schema for the experiments table.
 * Run this migration to create the table.
 */
export const EXPERIMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  spec_hash TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL,
  version TEXT NOT NULL,
  params_json JSONB NOT NULL,
  envelope_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREREGISTERED', 'LIVE_QUALIFIED', 'REJECTED', 'ARCHIVED')),
  gate_report_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiments_strategy ON experiments(strategy);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_created ON experiments(created_at);
`;

export default ExperimentRegistry;