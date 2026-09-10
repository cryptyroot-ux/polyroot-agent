/**
 * @polyroot/risk-pg — PostgreSQL implementations for MoneyKernel ports.
 * Connects MoneyKernel to the PostgreSQL schema (migration 0005).
 */

import { Pool, type PoolConfig } from "pg";
import type { BalanceStore, KernelEventSink, BalanceEntry } from "./money-kernel.js";

/**
 * PostgreSQL BalanceStore implementation.
 * Uses the `balance_commit` atomic function from migration 0005.
 */
export class PgBalanceStore implements BalanceStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async get(account: string, asset: string): Promise<BalanceEntry> {
    const result = await this.pool.query(
      `SELECT account, asset, available_base, committed_base
       FROM balance_entries
       WHERE account = $1 AND asset = $2`,
      [account, asset],
    );

    if (result.rows.length === 0) {
      // Return zero balance if not found (consistent with SQL function behavior)
      return {
        account,
        asset,
        availableBase: 0n,
        committedBase: 0n,
      };
    }

    const row = result.rows[0];
    return {
      account: row.account,
      asset: row.asset,
      availableBase: BigInt(row.available_base),
      committedBase: BigInt(row.committed_base),
    };
  }

  async commit(account: string, asset: string, deltaBase: bigint): Promise<void> {
    // The SQL function returns TRUE on success, FALSE on failure (insufficient balance)
    const result = await this.pool.query(
      `SELECT balance_commit($1, $2, $3)`,
      [account, asset, deltaBase.toString()],
    );

    const success = result.rows[0]?.balance_commit;
    if (!success) {
      // Determine the specific failure reason for better error messages
      const current = await this.get(account, asset);
      const delta = deltaBase;
      if (delta > 0n) {
        throw new Error(`INSUFFICIENT_AVAILABLE: account=${account} asset=${asset} available=${current.availableBase} needed=${delta}`);
      } else {
        throw new Error(`INSUFFICIENT_COMMITTED: account=${account} asset=${asset} committed=${current.committedBase} release=${-delta}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * PostgreSQL KernelEventSink implementation.
 * Uses the `kernel_event_append` atomic function from migration 0005.
 */
export class PgKernelEventSink implements KernelEventSink {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async push(topic: string, payload: unknown): Promise<void> {
    const metadata = { timestamp: new Date().toISOString() };
    await this.pool.query(
      `SELECT kernel_event_append($1, $2, $3, $4, $5)`,
      [
        topic,
        "Unknown", // aggregate_type - caller should provide better context if needed
        "00000000-0000-0000-0000-000000000000", // placeholder aggregate_id
        JSON.stringify(payload),
        JSON.stringify(metadata),
      ],
    );
  }

  /**
   * Push with explicit aggregate context for better traceability.
   */
  async pushWithContext(
    topic: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      `SELECT kernel_event_append($1, $2, $3, $4, $5)`,
      [
        topic,
        aggregateType,
        aggregateId,
        JSON.stringify(payload),
        JSON.stringify({ timestamp: new Date().toISOString(), ...metadata }),
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Factory to create both stores from a single connection pool.
 */
export function createPgStores(config: PoolConfig | string): {
  balanceStore: PgBalanceStore;
  eventSink: PgKernelEventSink;
  pool: Pool;
} {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  return {
    balanceStore: new PgBalanceStore(pool),
    eventSink: new PgKernelEventSink(pool),
    pool,
  };
}