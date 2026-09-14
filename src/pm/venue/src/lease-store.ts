/**
 * @polyroot/venue — Lease Store (PR-OPS-02).
 *
 * Durable per-wallet lease epoch fencing to prevent split-brain on network
 * partition or duplicate worker startup.
 */

import { Pool, type PoolConfig } from "pg";

/** Interface for durable lease management. */
export interface LeaseStore {
  /**
   * Acquire lease executor authority for a wallet.
   * Returns true if successful (we are the current lease holder).
   */
  acquireExecutorLease(
    walletId: string,
    holder: string,
    leaseEpoch: number,
    ttlSeconds: number
  ): Promise<boolean>;

  /**
   * Release lease executor authority for a wallet.
   * Only succeeds if we are the current holder.
   */
  releaseExecutorLease(walletId: string, holder: string): Promise<boolean>;

  /** Close underlying resources. */
  close(): Promise<void>;
}

/** PostgreSQL implementation using the executor_leases table and database functions. */
export class PgLeaseStore implements LeaseStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool
      ? config
      : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async acquireExecutorLease(
    walletId: string,
    holder: string,
    leaseEpoch: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT acquire_executor_lease($1, $2, $3, $4)`,
      [walletId, holder, leaseEpoch, ttlSeconds]
    );
    return result.rows[0]?.acquire_executor_lease ?? false;
  }

  async releaseExecutorLease(
    walletId: string,
    holder: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT release_executor_lease($1, $2)`,
      [walletId, holder]
    );
    return result.rows[0]?.release_executor_lease ?? false;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** In-memory implementation for testing. */
export class MemLeaseStore implements LeaseStore {
  private readonly leases: Map<string, { leaseEpoch: number; holder: string; expiresAt: Date }>;
  private readonly clock: () => Date;

  constructor(opts?: { clock?: () => Date }) {
    this.leases = new Map();
    this.clock = opts && opts.clock ? opts.clock : () => new Date();
  }

  async acquireExecutorLease(
    walletId: string,
    holder: string,
    leaseEpoch: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const now = this.clock();
    const existing = this.leases.get(walletId);
    // Check if we should acquire the lease (higher epoch or expired)
    const shouldAcquire = !existing ||
      leaseEpoch > existing.leaseEpoch ||
      existing.expiresAt < now;
    if (shouldAcquire) {
      this.leases.set(walletId, {
        leaseEpoch,
        holder,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      return true;
    }
    return false;
  }

  async releaseExecutorLease(
    walletId: string,
    holder: string
  ): Promise<boolean> {
    const lease = this.leases.get(walletId);
    if (lease && lease.holder === holder) {
      this.leases.delete(walletId);
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    // No-op
  }
}