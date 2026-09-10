/**
 * @polyroot/control-pg — PostgreSQL implementations for Supervisor/Reconciler ports.
 * Connects Control plane to the PostgreSQL schema (migration 0005).
 */

import { Pool, type PoolConfig } from "pg";
import type { Persistence, OrchestrateResult } from "./index.js";
import { Reconciler } from "./reconciler.js";
import { Supervisor } from "./supervisor.js";

/**
 * PostgreSQL Persistence implementation.
 * Uses the `recovery_ledger`, `supervisor_state`, and `balance_entries` tables from migration 0005.
 */
export class PgPersistence implements Persistence {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async get(orderId: string): Promise<import("@polyroot/executor").OrderLifecycleState | undefined> {
    const result = await this.pool.query(
      `SELECT state FROM recovery_ledger WHERE order_id = $1`,
      [orderId],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].state as import("@polyroot/executor").OrderLifecycleState;
  }

  async set(orderId: string, state: import("@polyroot/executor").OrderLifecycleState): Promise<void> {
    await this.pool.query(
      `INSERT INTO recovery_ledger (order_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (order_id) DO UPDATE SET state = $2, updated_at = now()`,
      [orderId, state],
    );
  }

  async listUnknown(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT order_id FROM recovery_ledger WHERE state = 'SUBMISSION_UNKNOWN'`,
    );
    return result.rows.map((r) => r.order_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * PostgreSQL Reconciler implementation.
 * Uses the Executor's reconcile method and updates recovery_ledger.
 */
export class PgReconciler extends Reconciler {
  private readonly pool: Pool;

  constructor(executor: import("@polyroot/executor").Executor, config: PoolConfig | string | Pool) {
    const pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
    const persistence = new PgPersistence(pool);
    
    // Call parent constructor with required dependencies
    super(executor, persistence);

    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  /**
   * Override reconcileAll to use PostgreSQL for querying unknown orders.
   */
  override async reconcileAll(): Promise<void> {
    const unknownIds = await this.pool.query(
      `SELECT order_id FROM recovery_ledger WHERE state = 'SUBMISSION_UNKNOWN'`,
    );

    for (const row of unknownIds.rows) {
      const orderId = row.order_id;
      const newState = await this.executor.reconcile(orderId);
      
      await this.pool.query(
        `UPDATE recovery_ledger SET state = $2, last_reconcile_at = now(), reconcile_count = reconcile_count + 1, updated_at = now()
         WHERE order_id = $1`,
        [row.order_id, newState],
      );

      if (newState === "ACKNOWLEDGED" || newState === "DEFINITIVE_REJECT") {
        await this.pool.query(
          `UPDATE recovery_ledger SET resolved = true, resolved_at = now(), resolved_state = $2
           WHERE order_id = $1`,
          [row.order_id, newState],
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * PostgreSQL Supervisor implementation.
 * Persists health counters and reconciliation state.
 */
export class PgSupervisor extends Supervisor {
  private readonly pool: Pool;

  constructor(
    reconciler: Reconciler,
    config: PoolConfig | string | Pool,
    _policy: import("@polyroot/domain").RiskPolicy,
  ) {
    const pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
    new PgPersistence(pool); // Created for parent constructor only

    // Call parent constructor with required dependencies
    super({
      reconciler: reconciler as any,
      persistence: new PgPersistence(pool) as any,
      policy: {} as any,
      now: () => new Date(),
    } as any);

    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  override async onOrchestrateResult(res: OrchestrateResult): Promise<void> {
    if (!res.ok) return;
    // State is already set by Executor via recovery_ledger
    // Just update supervisor counters
    await this.pool.query(
      `UPDATE supervisor_state SET total_order_count = total_order_count + 1,
                                  unknown_order_count = (SELECT COUNT(*) FROM recovery_ledger WHERE state = 'SUBMISSION_UNKNOWN'),
                                  unresolved_intent_count = (SELECT COUNT(*) FROM recovery_ledger WHERE state = 'SUBMISSION_UNKNOWN'),
                                  updated_at = now()
       WHERE id = '00000000-0000-0000-0000-000000000001'::uuid`,
    );
  }

  override async runReconciliation(): Promise<void> {
    await this.deps.reconciler.reconcileAll();
    await this.pool.query(
      `UPDATE supervisor_state SET last_reconcile_run = now(), last_reconcile_count = last_reconcile_count + 1 WHERE id = '00000000-0000-0000-0000-000000000001'::uuid`,
    );
  }

  override async getHealthReport(): Promise<import("./supervisor.js").HealthReport> {
    const result = await this.pool.query(
      `SELECT total_order_count, unknown_order_count, unresolved_intent_count, last_reconcile_run
       FROM supervisor_state WHERE id = '00000000-0000-0000-0000-000000000001'::uuid`,
    );
    const row = result.rows[0] || { total_order_count: 0, unknown_order_count: 0, unresolved_intent_count: 0, last_reconcile_run: null };
    return {
      timestamp: new Date(),
      unknownOrderCount: Number(row.unknown_order_count),
      totalOrderCount: Number(row.total_order_count),
      unresolvedIntents: Number(row.unresolved_intent_count),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Factory to create all control-plane stores from a single connection pool.
 * The caller must provide an Executor instance to wire up Reconciler and Supervisor.
 */
export function createPgControlStores(config: PoolConfig | string | Pool, executor: import("@polyroot/executor").Executor, _policy: import("@polyroot/domain").RiskPolicy): {
  persistence: PgPersistence;
  reconciler: PgReconciler;
  supervisor: PgSupervisor;
  pool: Pool;
} {
  const pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  
  const persistence = new PgPersistence(pool);
  const reconciler = new PgReconciler(executor, pool);
  const supervisor = new PgSupervisor(reconciler, pool, {} as import("@polyroot/domain").RiskPolicy);
  
  return { persistence, reconciler, supervisor, pool };
}