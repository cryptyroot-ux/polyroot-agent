/**
 * @polyroot/venue — Permit Store (PR-EXE-02, PR-OPS-02).
 *
 * Durable permit persistence with atomic single-use claim.
 * Replaces the in-memory Set with a PostgreSQL-backed store that guarantees
 * exactly-one claim via atomic UPDATE...WHERE.
 */

import { Pool, type PoolConfig } from "pg";
import { createHash } from "crypto";
import type { ExecutionPermit } from "@polyroot/domain";

/** Interface for permit persistence and atomic claim. */
export interface PermitStore {
  /** Persist a newly issued permit (state = ISSUED). */
  save(permit: ExecutionPermit): Promise<void>;
  /** Atomically claim a permit for a specific order.
   * Returns true if claim succeeded, false if permit already used/expired/invalid.
   */
  claim(permitId: string, orderId: string): Promise<boolean>;
  /** Check if a permit has been claimed (for read-only checks). */
  isClaimed(permitId: string): Promise<boolean>;
  /** Get permit by ID for reconciliation. */
  get(permitId: string): Promise<ExecutionPermit | null>;
  /** Close underlying resources. */
  close(): Promise<void>;
}

/** PostgreSQL implementation using the execution_permits table. */
export class PgPermitStore implements PermitStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  private computePermitHash(permit: ExecutionPermit): string {
    const payload = [
      permit.schema_version,
      permit.permit_id,
      permit.decision_id,
      permit.intent_id,
      permit.ledger_version,
      permit.policy_version,
      permit.policy_hash,
      permit.quote_id,
      String(permit.lease_epoch),
      permit.reservation_ids.join(","),
      String(permit.max_qty),
      String(permit.max_cash),
      permit.allowed_order_style.join(","),
      permit.venue_mode,
      permit.issued_at instanceof Date
        ? permit.issued_at.toISOString()
        : permit.issued_at,
      permit.expires_at instanceof Date
        ? permit.expires_at.toISOString()
        : permit.expires_at,
      String(permit.single_use),
      permit.used_at
        ? permit.used_at instanceof Date
          ? permit.used_at.toISOString()
          : permit.used_at
        : "null",
    ].join("|");

    return createHash("sha256").update(payload).digest("hex");
  }

  async save(permit: ExecutionPermit): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_permits (
        permit_id, decision_id, intent_id, ledger_version, policy_version,
        policy_hash, quote_id, lease_epoch, reservation_ids, max_qty, max_cash,
        allowed_order_style, venue_mode, issued_at, expires_at, single_use, used_at, schema_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (permit_id) DO NOTHING
      `,
      [
        permit.permit_id,
        permit.decision_id,
        permit.intent_id,
        permit.ledger_version,
        permit.policy_version,
        permit.policy_hash,
        permit.quote_id,
        permit.lease_epoch,
        permit.reservation_ids,
        permit.max_qty,
        permit.max_cash,
        permit.allowed_order_style,
        permit.venue_mode,
        permit.issued_at,
        permit.expires_at,
        permit.single_use,
        permit.used_at ?? null,
        permit.schema_version,
      ],
    );
  }

  async claim(permitId: string, orderId: string): Promise<boolean> {
    const now = new Date();

    // First, fetch the current permit to compute what the hash will be
    const permitResult = await this.pool.query(
      `SELECT * FROM execution_permits WHERE permit_id = $1`,
      [permitId],
    );

    if (permitResult.rowCount === 0) return false;
    const row = permitResult.rows[0];

    if (row.used_at !== null) return false;
    if (now > row.expires_at) return false;

    // Create a shadow object to compute hash (match logic in domain)
    const permitAfterClaim: ExecutionPermit = {
      ...row,
      used_at: now,
    };
    const payloadHash = this.computePermitHash(permitAfterClaim);

    const result = await this.pool.query(
      `UPDATE execution_permits
       SET used_at = $3,
           claimed_order_id = $2,
           payload_hash = $4
       WHERE permit_id = $1
         AND used_at IS NULL
         AND expires_at > $3
       RETURNING permit_id`,
      [permitId, orderId, now, payloadHash],
    );
    return result.rowCount === 1;
  }

  async isClaimed(permitId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM execution_permits WHERE permit_id = $1 AND used_at IS NOT NULL`,
      [permitId],
    );
    return result.rowCount === 1;
  }

  async get(permitId: string): Promise<ExecutionPermit | null> {
    const result = await this.pool.query(
      `SELECT * FROM execution_permits WHERE permit_id = $1`,
      [permitId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      schema_version: row.schema_version,
      permit_id: row.permit_id,
      decision_id: row.decision_id,
      intent_id: row.intent_id,
      ledger_version: row.ledger_version,
      policy_version: row.policy_version,
      policy_hash: row.policy_hash,
      quote_id: row.quote_id,
      lease_epoch: Number(row.lease_epoch),
      reservation_ids: row.reservation_ids,
      max_qty: Number(row.max_qty),
      max_cash: Number(row.max_cash),
      allowed_order_style: row.allowed_order_style,
      venue_mode: row.venue_mode,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      single_use: row.single_use,
      used_at: row.used_at,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** In-memory implementation for testing (uses atomic operations via Map). */
export class MemPermitStore implements PermitStore {
  private readonly permits = new Map<
    string,
    ExecutionPermit & { claimed: boolean }
  >();
  private readonly clock: () => Date;

  constructor(opts?: { clock?: () => Date }) {
    this.clock =
      opts && opts.clock
        ? opts.clock
        : function () {
            return new Date();
          };
  }

  async save(permit: ExecutionPermit): Promise<void> {
    const existing = this.permits.get(permit.permit_id);
    this.permits.set(permit.permit_id, {
      ...permit,
      claimed: existing?.claimed ?? false,
    });
  }

  async claim(permitId: string, orderId: string): Promise<boolean> {
    const permit = this.permits.get(permitId);
    if (!permit) return false;
    if (permit.claimed) return false;
    if (this.clock() > permit.expires_at) return false;
    permit.claimed = true;
    (permit as any).claimedOrderId = orderId;
    return true;
  }

  async isClaimed(permitId: string): Promise<boolean> {
    const permit = this.permits.get(permitId);
    return permit?.claimed ?? false;
  }

  async get(permitId: string): Promise<ExecutionPermit | null> {
    const permit = this.permits.get(permitId);
    if (!permit) return null;
    const { claimed: _claimed, ...rest } = permit;
    void _claimed;
    return rest;
  }

  async close(): Promise<void> {
    // No-op
  }
}
