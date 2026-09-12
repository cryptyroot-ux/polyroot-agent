/**
 * @polyroot/risk-pg — PostgreSQL implementations for MoneyKernel ports.
 * Connects MoneyKernel to the PostgreSQL schema (migration 0005).
 */

import { Pool, type PoolConfig } from "pg";
import type { BalanceStore, KernelEventSink, BalanceEntry } from "./money-kernel.js";

/**
 * PostgreSQL BalanceStore implementation.
 * Uses the `balance_commit` atomic function from migration 0005.
 * 
 * Semantic alignment:
 * - reserveFunds: moves available -> committed (positive delta in SQL)
 * - releaseFunds: moves committed -> available (negative delta in SQL)
 * - consumeFunds: moves committed -> final (negative delta in SQL)
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

  /** Reserve funds: move from available to committed (positive delta). */
  async reserveFunds(account: string, asset: string, amountBase: bigint): Promise<void> {
    const result = await this.pool.query(
      `SELECT balance_commit($1, $2, $3)`,
      [account, asset, amountBase.toString()],
    );

    const success = result.rows[0]?.balance_commit;
    if (!success) {
      const current = await this.get(account, asset);
      throw new Error(`INSUFFICIENT_AVAILABLE: account=${account} asset=${asset} available=${current.availableBase} needed=${amountBase}`);
    }
  }

  /** Release funds: move from committed back to available (negative delta). */
  async releaseFunds(account: string, asset: string, amountBase: bigint): Promise<void> {
    const result = await this.pool.query(
      `SELECT balance_commit($1, $2, $3)`,
      [account, asset, (-amountBase).toString()],
    );

    const success = result.rows[0]?.balance_commit;
    if (!success) {
      const current = await this.get(account, asset);
      throw new Error(`INSUFFICIENT_COMMITTED: account=${account} asset=${asset} committed=${current.committedBase} release=${amountBase}`);
    }
  }

  /** Consume funds: move from committed to final settlement (negative delta). */
  async consumeFunds(account: string, asset: string, amountBase: bigint): Promise<void> {
    // Same SQL operation as release: decrease committed
    const result = await this.pool.query(
      `SELECT balance_commit($1, $2, $3)`,
      [account, asset, (-amountBase).toString()],
    );

    const success = result.rows[0]?.balance_commit;
    if (!success) {
      const current = await this.get(account, asset);
      throw new Error(`INSUFFICIENT_COMMITTED_FOR_CONSUME: account=${account} asset=${asset} committed=${current.committedBase} consume=${amountBase}`);
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
    // Use a default aggregate type/id for generic events; callers should use pushWithContext for traceability
    await this.pool.query(
      `SELECT kernel_event_append($1, $2, $3, $4, $5)`,
      [
        topic,
        "GENERIC",
        "00000000-0000-0000-0000-000000000000",
        JSON.stringify(payload),
        JSON.stringify(metadata),
      ],
    );
  }

  /**
   * Push with explicit aggregate context for better traceability.
   * Use this for financial events that need to be correlated.
   */
  async pushWithContext(
    topic: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    // Parse aggregateId as UUID if possible, otherwise use a deterministic UUID from the string
    let uuidAggregateId: string;
    try {
      // Check if it's already a valid UUID
      uuidAggregateId = aggregateId;
      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aggregateId)) {
        // Generate deterministic UUID from string (using a simple hash)
        const hash = await this.stringToDeterministicUUID(aggregateId);
        uuidAggregateId = hash;
      }
    } catch {
      const hash = await this.stringToDeterministicUUID(aggregateId);
      uuidAggregateId = hash;
    }

    await this.pool.query(
      `SELECT kernel_event_append($1, $2, $3, $4, $5)`,
      [
        topic,
        aggregateType,
        uuidAggregateId,
        JSON.stringify(payload),
        JSON.stringify({ timestamp: new Date().toISOString(), ...metadata }),
      ],
    );
  }

  /** Generate deterministic UUID from string for aggregate_id. */
  private async stringToDeterministicUUID(str: string): Promise<string> {
    // Use a simple hash to generate deterministic UUID
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update(str).digest("hex");
    // Format as UUID v4 (using hash bytes)
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${(parseInt(hash.slice(16,17), 16) % 4 + 8).toString(16)}${hash.slice(17,18)}-${hash.slice(18,30)}`;
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
