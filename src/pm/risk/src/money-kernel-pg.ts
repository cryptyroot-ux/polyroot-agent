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
import { toBaseUnits } from "./reservation-manager.js";
import type {
  BalanceStore,
  KernelEventSink,
  BalanceEntry,
} from "./money-kernel.js";
import type { MoneyAuthority } from "./money-kernel.js";

export interface PgBalanceStoreConfig extends PoolConfig {
  pool?: Pool;
}

export class PgBalanceStore implements BalanceStore {
  private readonly pool: Pool;
  constructor(config: PoolConfig | string | Pool | PgBalanceStoreConfig) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (
      config &&
      typeof config === "object" &&
      "pool" in config &&
      config.pool
    ) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(
        typeof config === "string" ? { connectionString: config } : config,
      );
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
    return {
      account,
      asset,
      availableBase: toBaseUnits(row.available_base),
      committedBase: toBaseUnits(row.committed_base),
    };
  }

  async reserveFunds(
    account: string,
    asset: string,
    amount: bigint,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET available_base = available_base - $3, committed_base = committed_base + $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND available_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(
        `INSUFFICIENT_AVAILABLE: account=${account} asset=${asset} needed=${amount}`,
      );
    }
  }

  async releaseFunds(
    account: string,
    asset: string,
    amount: bigint,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET available_base = available_base + $3, committed_base = committed_base - $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(
        `INSUFFICIENT_COMMITTED: account=${account} asset=${asset} committed=... needed=${amount}`,
      );
    }
  }

  async consumeFunds(
    account: string,
    asset: string,
    amount: bigint,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE balance_entries SET committed_base = committed_base - $3, updated_at = now()
       WHERE account = $1 AND asset = $2 AND committed_base >= $3 RETURNING account`,
      [account, asset, amount.toString()],
    );
    if (result.rowCount === 0) {
      throw new Error(
        `INSUFFICIENT_COMMITTED_FOR_CONSUME: account=${account} asset=${asset} needed=${amount}`,
      );
    }
  }

  async getOpenCount(account: string, asset: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM reservations WHERE account = $1 AND asset = $2 AND status = 'ACTIVE'`,
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
    } else if (
      config &&
      typeof config === "object" &&
      "pool" in config &&
      config.pool
    ) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(
        typeof config === "string" ? { connectionString: config } : config,
      );
    }
  }

  async push(topic: string, payload: unknown): Promise<void> {
    const payloadStr = JSON.stringify(payload);
    const metadata = JSON.stringify({
      payloadHash: createHash("sha256").update(payloadStr).digest("hex"),
    });
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

  constructor(
    config: PoolConfig | string | Pool | PgBalanceStoreConfig | { pool?: Pool },
  ) {
    if (config instanceof Pool) {
      this.pool = config;
    } else if (
      config &&
      typeof config === "object" &&
      "pool" in config &&
      config.pool
    ) {
      this.pool = config.pool;
    } else {
      this.pool = new Pool(
        typeof config === "string"
          ? { connectionString: config }
          : (config as PoolConfig),
      );
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
    /** Share quantity in base units (e.g. 100 shares => 100_000_000 base). */
    amountSharesBase?: bigint,
    /** Authoritative policy hash for the permit. */
    policyHash?: string,
    /** Authoritative quote id for the permit. */
    quoteId?: string,
    /** Risk decision columns for atomic risk_decisions insertion. */
    riskDecisionCols?: {
      schema_version: string;
      policy_version: string;
      ledger_version: string;
      allowed_order_style: string[];
      venue_mode: string;
    },
    /** Parent trade_intents row (inserted idempotently, same tx). */
    intentRef?: {
      marketId: string;
      outcomeSide: "YES" | "NO";
      priceBase: bigint;
      sizeBase: bigint;
      orderType: "LIMIT" | "POST_ONLY" | "FOK" | "IOC";
      expirationSec: number;
      strategy: string;
    },
  ): Promise<import("./money-kernel.js").MoneyAuthorityResult> {
    const reservationId = randomUUID();
    const permitId = randomUUID();
    const expiresAt = new Date(now.getTime() + 60_000);

    // 0. Fail-closed on missing authority provenance. The permit MUST carry an
    //    authoritative policy hash and quote id — empty values are never
    //    coerced to "" because that would fabricate authorization provenance.
    if (!policyHash || policyHash.length === 0) {
      return {
        ok: false,
        reason: "authoritative policy hash required",
        code: "POLICY_HASH_REQUIRED",
      };
    }
    if (!quoteId || quoteId.length === 0) {
      return {
        ok: false,
        reason: "authoritative quote id required",
        code: "QUOTE_ID_REQUIRED",
      };
    }
    // 0b. Fail-closed on invalid lease epoch. A non-positive or non-integer
    //     epoch can never match the authoritative executor lease, so refuse
    //     before touching the database (no partial state, no connection held).
    if (!Number.isInteger(leaseEpoch) || leaseEpoch <= 0) {
      return {
        ok: false,
        reason:
          "permit lease epoch does not match current executor lease epoch",
        code: "LEASE_EPOCH_MISMATCH",
      };
    }

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");

      // 0. Duplicate-intent guard: exactly one reservation per (intent_id, asset).
      //    Re-appending the same economic intent is a deterministic idempotent
      //    no-op, not a second authorization.
      const dup = await client.query(
        `SELECT id FROM reservations WHERE intent_id = $1::uuid AND account = $2 AND asset = $3 AND status = 'ACTIVE' LIMIT 1`,
        [intentId, account, asset],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "duplicate economic intent",
          code: "DUPLICATE_INTENT",
        };
      }

      // 1. Lock balance row and check availability.
      //    A missing balance row is a DISTINCT fail-closed condition from
      //    insufficient funds: it means the account/asset was never funded
      //    (or was deleted), not merely underfunded. Callers must be able to
      //    distinguish onboarding/funding bugs from spend limits.
      const bal = await client.query(
        `SELECT available_base FROM balance_entries WHERE account = $1 AND asset = $2 FOR UPDATE`,
        [account, asset],
      );
      if (bal.rowCount === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "balance row missing",
          code: "BALANCE_ROW_MISSING",
        };
      }
      if (toBaseUnits(bal.rows[0].available_base) < cashNeededBase) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "INSUFFICIENT_AVAILABLE_BALANCE",
          code: "INSUFFICIENT_AVAILABLE_BALANCE",
        };
      }

      // 2. Check open-reservation limit
      const openCount = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM reservations WHERE account = $1 AND asset = $2 AND status = 'ACTIVE'`,
        [account, asset],
      );
      if ((openCount.rows[0]?.cnt ?? 0) >= this.maxOpenReservations) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "RESERVATION_LIMIT_EXCEEDED",
          code: "RESERVATION_LIMIT_EXCEEDED",
        };
      }

      // 3. Reserve funds
      await client.query(
        `UPDATE balance_entries SET available_base = available_base - $3, committed_base = committed_base + $3, updated_at = now()
         WHERE account = $1 AND asset = $2 AND available_base >= $3`,
        [account, asset, cashNeededBase.toString()],
      );

      // 3b. Parent trade_intents row (FK target of risk_decisions). Nothing
      // else creates it, so create it here atomically — idempotent on retry
      // (same intent id → DO NOTHING) and on duplicate-intent replays.
      if (intentRef) {
        const price = Number(intentRef.priceBase) / 1_000_000;
        const size = Number(intentRef.sizeBase) / 1_000_000;
        await client.query(
          `INSERT INTO trade_intents (id, market_id, side, price, size, order_type, expiration_sec, strategy, status)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'PROPOSED')
           ON CONFLICT (id) DO NOTHING`,
          [
            intentId,
            intentRef.marketId,
            intentRef.outcomeSide,
            price.toFixed(4),
            size,
            intentRef.orderType,
            Math.max(1, Math.floor(intentRef.expirationSec)),
            intentRef.strategy,
          ],
        );
      }

      // 4. Insert risk_decisions row atomically (P0: RISK DECISION IDENTITY)
      //    Must exist before reservation and execution_permits reference it.
      const riskDecisionSchemaVersion =
        riskDecisionCols?.schema_version ?? "1.1";
      const riskDecisionPolicyVersion =
        riskDecisionCols?.policy_version ?? "v0-bootstrap";
      const riskDecisionLedgerVersion =
        riskDecisionCols?.ledger_version ?? "0003";
      const riskDecisionAllowedOrderStyle =
        riskDecisionCols?.allowed_order_style ?? ["LIMIT", "POST_ONLY"];
      const riskDecisionVenueMode = riskDecisionCols?.venue_mode ?? "NORMAL";

      const maxQtyBase = (amountSharesBase ?? cashNeededBase).toString();
      const maxCashBase = cashNeededBase.toString();

      await client.query(
        `INSERT INTO risk_decisions (
          id, intent_id, status, decision_id, reservation_ids,
          max_qty, max_cash, allowed_order_style, venue_mode,
          ledger_version, policy_version, quote_version, lease_version,
          reason_codes, schema_version, decided_at
        ) VALUES (
          $1, $2, 'ACCEPTED', $1, $3,
          $4, $5, $6, $7,
          $8, $9, $10, $11,
          '{}', $12, now()
        )`,
        [
          decisionId,
          intentId,
          [reservationId],
          maxQtyBase,
          maxCashBase,
          riskDecisionAllowedOrderStyle,
          riskDecisionVenueMode,
          riskDecisionLedgerVersion,
          riskDecisionPolicyVersion,
          riskDecisionPolicyVersion, // quote_version
          riskDecisionPolicyVersion, // lease_version
          riskDecisionSchemaVersion,
        ],
      );

      // 5. Insert reservation row (canonical Reservation↔Permit binding)
      await client.query(
        `INSERT INTO reservations (id, risk_decision_id, intent_id, account, asset, amount, currency, status, created_at, expires_at, consumed_at, permit_id, payload_hash, decision_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'pUSD', 'ACTIVE', now(), $7, NULL, $8, NULL, $9)`,
        [
          reservationId,
          decisionId,
          intentId,
          account,
          asset,
          cashNeededBase.toString(),
          expiresAt.toISOString(),
          permitId,
          decisionId,
        ],
      );

      // 6. Fetch risk_decision for required execution_permits fields
      const rd = await client.query(
        `SELECT ledger_version, policy_version, allowed_order_style, venue_mode, schema_version
         FROM risk_decisions WHERE id = $1`,
        [decisionId],
      );
      if (rd.rowCount === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          reason: "RISK_DECISION_NOT_FOUND",
          code: "RISK_DECISION_NOT_FOUND",
        };
      }
      const riskDecision = rd.rows[0];

      // 7. Insert execution permit row
      await client.query(
        `INSERT INTO execution_permits (permit_id, decision_id, intent_id, ledger_version, policy_version, policy_hash, quote_id, lease_epoch, reservation_ids, max_qty, max_cash, allowed_order_style, venue_mode, issued_at, expires_at, single_use, used_at, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, true, NULL, $15)`,
        [
          permitId,
          decisionId,
          intentId,
          riskDecision.ledger_version ?? "1.0.0",
          riskDecision.policy_version ?? "1.0.0",
          policyHash ?? "",
          quoteId ?? "",
          leaseEpoch,
          [reservationId],
          (amountSharesBase ?? cashNeededBase).toString(),
          cashNeededBase.toString(),
          riskDecision.allowed_order_style ?? [],
          riskDecision.venue_mode ?? "default",
          expiresAt.toISOString(),
          riskDecision.schema_version ?? "1.0.0",
        ],
      );

      // 8. Insert kernel event (audit trail)
      const eventPayload = JSON.stringify({
        reservationId,
        permitId,
        intentId,
        account,
        asset,
        cashBase: cashNeededBase.toString(),
        leaseEpoch,
      });
      const payloadHash = createHash("sha256")
        .update(eventPayload)
        .digest("hex");
      await client.query(`SELECT kernel_event_append($1, $2, $3, $4, $5)`, [
        "RESERVATION_CREATED",
        "execution_permits",
        permitId,
        eventPayload,
        JSON.stringify({ payloadHash, leaseEpoch }),
      ]);

      // 9. Commit — all-or-nothing
      await client.query("COMMIT");
      return { ok: true, reservationId, permitId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      const pgError = err as { code?: string | number };
      const code =
        typeof pgError.code === "string" || typeof pgError.code === "number"
          ? String(pgError.code)
          : "";
      // PostgreSQL serialization/deadlock conflicts are TRANSIENT — a bounded
      // retry with an authoritative re-read is safe (the duplicate-intent guard
      // and balance lock prevent double-allocation). Surface a typed code so the
      // caller can retry deterministically instead of treating it as a fatal
      // money failure.
      if (code === "23505") {
        return {
          ok: false,
          reason: "duplicate economic intent (unique violation)",
          code: "DUPLICATE_INTENT",
        };
      }
      if (
        code === "40001" ||
        code === "40P01" ||
        /serializ|deadlock/i.test(msg)
      ) {
        return {
          ok: false,
          reason: "transient serialization conflict",
          code: "SERIALIZATION_CONFLICT",
        };
      }
      return {
        ok: false,
        reason: msg,
        code: "MONEY_AUTHORITY_FAILED",
      };
    } finally {
      client.release();
    }
  }
}

export function createPgMoneyAuthority(
  config: PgBalanceStoreConfig,
): PgMoneyAuthority {
  return new PgMoneyAuthority(config);
}

/**
 * Create all PostgreSQL-backed store ports from a single connection string/pool.
 * Compatibility factory kept for existing wiring (orchestrator-pg.ts).
 */
export function createPgStores(
  config: PoolConfig | string | PgBalanceStoreConfig,
): {
  balanceStore: PgBalanceStore;
  eventSink: PgKernelEventSink;
  authority: PgMoneyAuthority;
  pool: Pool;
} {
  const pool =
    config && typeof config === "object" && "pool" in config && config.pool
      ? config.pool
      : new Pool(
          typeof config === "string" ? { connectionString: config } : config,
        );
  return {
    balanceStore: new PgBalanceStore(pool),
    eventSink: new PgKernelEventSink(pool),
    authority: new PgMoneyAuthority(pool),
    pool,
  };
}
