/**
 * @polyroot/risk — PostgreSQL BalanceStore implementations.
 *
 * Canonical financial operations with explicit SQL semantics:
 *   reserveFunds:  available -= amount,  committed += amount
 *   releaseFunds:  available += amount,  committed -= amount
 *   consumeFunds:  available unchanged,  committed -= amount
 */

import { Pool, type PoolConfig, type PoolClient } from "pg";
import type { BalanceStore, KernelEventSink, BalanceEntry } from "./money-kernel.js";
import { createHash } from "crypto";

export interface PgBalanceStoreConfig extends PoolConfig {
  pool?: Pool;
}

export class PgBalanceStore implements BalanceStore {
  private readonly pool: Pool;
  constructor(config: PoolConfig | string | Pool | PgBalanceStoreConfig) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (config && typeof config === 'object' && 'pool' in config && config.pool) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
    }
  }

  async get(account: string, asset: string): Promise<BalanceEntry> {
    const result = await this.pool.query(
      `SELECT account, asset, available_base, committed_base FROM balance_entries WHERE account = $1 AND asset = $2`,
      [account, asset],
    );
    if (result.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO balance_entries (account, asset, available_base, committed_base) VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING`,
        [account, asset],
      );
      return { account, asset, availableBase: 0n, committedBase: 0n };
    }
    const row = result.rows[0];
    return { account, asset, availableBase: BigInt(row.available_base), committedBase: BigInt(row.committed_base) };
  }

  /** Reserve: available -= amount, committed += amount */
  async reserveFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries
       SET available_base = available_base - $3,
           committed_base = committed_base + $3,
           updated_at = now()
       WHERE account = $1 AND asset = $2 AND available_base >= $3
       RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_AVAILABLE: account=${account} asset=${asset} needed=${amount}`);
    }
  }

  /** Release: available += amount, committed -= amount */
  async releaseFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries
       SET available_base = available_base + $3,
           committed_base = committed_base - $3,
           updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3
       RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_COMMITTED: account=${account} asset=${asset} committed=... needed=${amount}`);
    }
  }

  /** Consume: available unchanged, committed -= amount (final economic posting). */
  async consumeFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries
       SET committed_base = committed_base - $3,
           updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3
       RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_COMMITTED_FOR_CONSUME: account=${account} asset=${asset} needed=${amount}`);
    }
  }

  /** Count open reservations for this account/asset (Milestone B3). */
  async getOpenCount(account: string, asset: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM reservations WHERE account = $1 AND asset = $2 AND status = 'OPEN'`,
      [account, asset],
    );
    return result.rows[0]?.cnt ?? 0;
  }

  async getPool(): Promise<Pool> {
    return this.pool;
  }
}

export class PgKernelEventSink implements KernelEventSink {
  private readonly pool: Pool;
  constructor(config: PoolConfig | string | Pool | PgBalanceStoreConfig) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (config && typeof config === "object" && "pool" in config && config.pool) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
    }
  }

  async push(topic: string, payload: unknown): Promise<void> {
    const payloadStr = JSON.stringify(payload);
    const payloadHash = createHash("sha256").update(payloadStr).digest("hex");
    await this.pool.query(
      `INSERT INTO kernel_events (topic, payload, payload_hash)
       VALUES ($1, $2, $3)`,
      [topic, payloadStr, payloadHash],
    );
  }

  async getPool(): Promise<Pool> {
    return this.pool;
  }
}
