/**
 * @polyroot/risk — PostgreSQL implementations for BalanceStore, KernelEventSink, and MoneyAuthority.
 *
 * Canonical financial operations with explicit SQL semantics:
 *   reserveFunds:  available -= amount,  committed += amount
 *   releaseFunds:  available += amount,  committed -= amount
 *   consumeFunds:  available unchanged,  committed -= amount
 *
 * MoneyAuthority wraps the full reservation+permit lifecycle in a single
 * PostgreSQL transaction — all-or-nothing on commit, rollback on any failure.
 */

import { Pool, type PoolConfig, type PoolClient } from "pg";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { BalanceStore, KernelEventSink, BalanceEntry } from "./money-kernel.js";
import type { MoneyAuthority } from "./money-kernel.js";

export interface PgBalanceStoreConfig extends PoolConfig {
  pool?: Pool;
}

export class PgBalanceStore implements BalanceStore {
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

  async reserveFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET available_base = available_base - $3, committed_base = committed_base + $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND available_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_AVAILABLE: account=${account} asset=${asset} needed=${amount}`);
    }
  }

  async releaseFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET available_base = available_base + $3, committed_base = committed_base - $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_COMMITTED: account=${account} asset=${asset} committed=... needed=${amount}`);
    }
  }

  async consumeFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET committed_base = committed_base - $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(`INSUFFICIENT_COMMITTED_FOR_CONSUME: account=${account} asset=${asset} needed=${amount}`);
    }
  }

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
    const metadata = JSON.stringify({ payloadHash: createHash("sha256").update(payloadStr).digest("hex") });
    await this.pool.query(
      `INSERT INTO kernel_events (topic, aggregate_type, aggregate_id, payload, metadata, created_at)
       VALUES ($1, 'system', '00000000-0000-0000-0000-000000000000'::uuid, $2::jsonb, $3::jsonb, now())`,
      [topic, payloadStr, metadata],
    );
  }

  async getPool(): Promise<Pool> {
    return this.pool;
  }
}

/**
 * PgMoneyAuthority — Atomic financial authorization via PostgreSQL transaction.
 *
 * All financial side-effects (balance, reservation, permit, event) happen
 * inside a single REPEATABLE READ transaction.  If ANY step fails the entire
 * operation is ROLLBACKed.  No intermediate partial state survives.
 */
export class PgMoneyAuthority implements MoneyAuthority {
  private readonly pool: Pool;
  private readonly maxOpenReservations: number;

  constructor(config: PoolConfig | string | Pool | PgBalanceStoreConfig) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (config && typeof config === "object" && "pool" in config && config.pool) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
    }
    this.maxOpenReservations = 16;
  }

  async reserve(
    account: string,
    asset: string,
    cashNeededBase: bigint,
    decisionId: string,
    intentId: string,
    leaseEpoch: number,
    now: Date,
  ): Promise<import("./money-kernel.js").MoneyAuthorityResult> {
    const reservationId = randomUUID();
    const permitId = randomUUID();
    const expiresAt = new Date(now.getTime() + 60_000);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");

      // 1. Lock balance row and check availability
      const bal = await client.query(
        `SELECT available_base FROM balance_entries WHERE account = $1 AND asset = $2 FOR UPDATE`,
        [account, asset],
      );
      if (bal.rowCount === 0 || BigInt(bal.rows[0].available_base) < cashNeededBase) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "INSUFFICIENT_AVAILABLE_BALANCE", code: "INSUFFICIENT_AVAILABLE_BALANCE" };
      }

      // 2. Check open-reservation limit
      const openCount = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM reservations WHERE account = $1 AND asset = $2 AND status = 'OPEN'`,
        [account, asset],
      );
      if ((openCount.rows[0]?.cnt ?? 0) >= this.maxOpenReservations) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "RESERVATION_LIMIT_EXCEEDED", code: "RESERVATION_LIMIT_EXCEEDED" };
      }

      // 3. Reserve funds
      await client.query(
        `UPDATE balance_entries SET available_base = available_base - $3, committed_base = committed_base + $3, updated_at = now()
         WHERE account = $1 AND asset = $2 AND available_base >= $3`,
        [account, asset, cashNeededBase.toString()],
      );

      // 4. Insert reservation row
      await client.query(
        `INSERT INTO reservations (id, risk_decision_id, intent_id, account, asset, amount, currency, status, created_at, expires_at, consumed_at, permit_id, payload_hash, decision_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'pUSD', 'ACTIVE', now(), $7, NULL, NULL, NULL, $8)`,
        [reservationId, decisionId, intentId, account, asset, cashNeededBase.toString(), expiresAt.toISOString(), decisionId],
      );

      // 5. Fetch risk_decision for required execution_permits fields
      const rd = await client.query(
        `SELECT ledger_version, policy_version, allowed_order_style, venue_mode, schema_version
         FROM risk_decisions WHERE id = $1`,
        [decisionId],
      );
      if (rd.rowCount === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "RISK_DECISION_NOT_FOUND", code: "RISK_DECISION_NOT_FOUND" };
      }
      const riskDecision = rd.rows[0];

      // 5. Insert execution permit row
      await client.query(
        `INSERT INTO execution_permits (permit_id, decision_id, intent_id, ledger_version, policy_version, policy_hash, quote_id, lease_epoch, reservation_ids, max_qty, max_cash, allowed_order_style, venue_mode, issued_at, expires_at, single_use, used_at, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, true, NULL, $15)`,
        [
          permitId,
          decisionId,
          intentId,
          riskDecision.ledger_version ?? "1.0.0",
          riskDecision.policy_version ?? "1.0.0",
          "", // policy_hash - not in risk_decisions
          "", // quote_id - not in risk_decisions
          leaseEpoch,
          [reservationId],
          cashNeededBase.toString(),
          cashNeededBase.toString(),
          riskDecision.allowed_order_style ?? [],
          riskDecision.venue_mode ?? "default",
          expiresAt.toISOString(),
          riskDecision.schema_version ?? "1.0.0",
        ],
      );

      // 6. Insert kernel event (audit trail) — schema has NO payload_hash col,
      //    store hash inside metadata JSONB instead.
      const eventPayload = JSON.stringify({ reservationId, permitId, intentId, account, asset, cashBase: cashNeededBase.toString(), leaseEpoch });
      const payloadHash = createHash("sha256").update(eventPayload).digest("hex");
      await client.query(
        `SELECT kernel_event_append($1, $2, $3, $4, $5)`,
        [
          "RESERVATION_CREATED",
          "execution_permits",
          permitId,
          eventPayload,
          JSON.stringify({ payloadHash, leaseEpoch }),
        ],
      );

      // 7. Commit — all-or-nothing
      await client.query("COMMIT");
      return { ok: true, reservationId, permitId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        code: "MONEY_AUTHORITY_FAILED",
      };
    } finally {
      client.release();
    }
  }
}

export function createPgMoneyAuthority(config: PgBalanceStoreConfig): PgMoneyAuthority {
  return new PgMoneyAuthority(config);
}

/**
 * Create all PostgreSQL-backed store ports from a single connection string/pool.
 * Compatibility factory kept for existing wiring (orchestrator-pg.ts).
 */
export function createPgStores(config: PoolConfig | string | PgBalanceStoreConfig): {
  balanceStore: PgBalanceStore;
  eventSink: PgKernelEventSink;
  pool: Pool;
} {
  const pool =
    config && typeof config === "object" && "pool" in config && config.pool
      ? config.pool
      : new Pool(typeof config === "string" ? { connectionString: config } : config);
  return {
    balanceStore: new PgBalanceStore(pool),
    eventSink: new PgKernelEventSink(pool),
    pool,
  };
}
