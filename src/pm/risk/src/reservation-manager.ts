/**
 * @polyroot/risk — Reservation Manager (PM-RISK-03, TABLE 14).
 *
 * Manages the lifecycle of reservations from creation to consumption/release.
 * This is the authoritative state machine for reservation lifecycle.
 *
 * State machine:
 *   ACTIVE → CONSUMED | RELEASED | EXPIRED
 *
 * All state transitions are persisted to the database for durability and
 * enforced atomically (no partial transitions).
 */

import { randomUUID } from "crypto";
import type { Pool } from "pg";
import type { BalanceStore } from "./money-kernel.js";

export type ReservationStatus = "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED";

export interface Reservation {
  id: string;
  intentId: string;
  decisionId: string;
  account: string;
  asset: string;
  amount: bigint; // in base units (shares * 1e6)
  currency: string;
  status: ReservationStatus;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  releasedAt?: Date;
  permitId: string;
}

export interface ReservationManagerDeps {
  balanceStore: BalanceStore;
  permitStore: {
    get(permitId: string): Promise<{
      permit_id: string;
      reservation_ids: string[];
      used_at: Date | null;
      expires_at: Date;
      single_use: boolean;
    } | null>;
    claim(permitId: string, orderId: string): Promise<boolean>;
  };
  pool?: Pool;
}

export class ReservationManager {
  private readonly deps: ReservationManagerDeps;

  constructor(deps: ReservationManagerDeps) {
    this.deps = deps;
  }

  /** Create a reservation atomically (INSERT-only). Returns the reservation id. */
  async createFromPermit(args: {
    permit_id: string;
    intent_id: string;
    decision_id: string;
    account: string;
    asset: string;
    amount: bigint; // reserved cash (base units)
    max_qty: number; // shares
    expires_at: Date;
    currency?: string;
  }): Promise<{ ok: true; reservationId: string } | { ok: false; code: string; reason: string }> {
    const reservationId = randomUUID();
    if (!this.deps.pool) {
      // In-memory mode (tests): just return a synthetic id.
      return { ok: true, reservationId };
    }
    try {
      await this.deps.pool.query(
        `INSERT INTO reservations (
           id, risk_decision_id, intent_id, account, asset, amount, currency,
           status, created_at, expires_at, consumed_at, permit_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', now(), $8, NULL, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          reservationId,
          args.decision_id,
          args.intent_id,
          args.account,
          args.asset,
          args.amount.toString(),
          args.currency ?? "pUSD",
          args.expires_at,
          args.permit_id,
        ],
      );
      return { ok: true, reservationId };
    } catch (err) {
      return {
        ok: false,
        code: "RESERVATION_CREATE_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Consume a reservation atomically:
   *   UPDATE reservations SET status='CONSUMED', consumed_at=now()
   *   WHERE id=$1 AND status='ACTIVE'
   * then decrement committed balance.
   */
  async consume(reservationId: string, filledAmount: bigint): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    if (!this.deps.pool) return { ok: true }; // in-memory mode
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `UPDATE reservations
         SET status='CONSUMED', consumed_at=now()
         WHERE id=$1 AND status='ACTIVE'
         RETURNING account, asset`,
        [reservationId],
      );
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false, code: "RESERVATION_NOT_ACTIVE", reason: "reservation not active" };
      }
      const { account, asset } = r.rows[0] as { account: string; asset: string };
      await this.deps.balanceStore.consumeFunds(account, asset, filledAmount);
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false, code: "CONSUME_FAILED", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      client.release();
    }
  }

  /** Release/rescind reservation funds atomically. */
  async release(
    reservationId: string,
    _reason: "CANCELLED" | "EXPIRED" | "REJECTED",
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    if (!this.deps.pool) return { ok: true };
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `UPDATE reservations
         SET status='RELEASED', released_at=now()
         WHERE id=$1 AND status='ACTIVE'
         RETURNING account, asset, amount`,
        [reservationId],
      );
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false, code: "RESERVATION_NOT_ACTIVE", reason: "reservation not active" };
      }
      const { account, asset, amount } = r.rows[0] as { account: string; asset: string; amount: string };
      await this.deps.balanceStore.releaseFunds(account, asset, BigInt(amount));
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false, code: "RELEASE_FAILED", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      client.release();
    }
  }

  /** Expire overdue reservations atomically. */
  async expire(reservationId: string): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    return this.release(reservationId, "EXPIRED");
  }

  async getActive(account: string, asset: string): Promise<Reservation[]> {
    if (!this.deps.pool) return [];
    const r = await this.deps.pool.query(
      `SELECT * FROM reservations WHERE account=$1 AND asset=$2 AND status='ACTIVE'`,
      [account, asset],
    );
    return r.rows.map((row) => this.mapRow(row));
  }

  async get(reservationId: string): Promise<Reservation | null> {
    if (!this.deps.pool) return null;
    const r = await this.deps.pool.query(
      `SELECT * FROM reservations WHERE id=$1`,
      [reservationId],
    );
    if (r.rowCount === 0) return null;
    return this.mapRow(r.rows[0]);
  }

  private mapRow(row: {
    id: string;
    intent_id: string;
    risk_decision_id?: string;
    decision_id?: string;
    account: string;
    asset: string;
    amount: string | number;
    currency?: string;
    status: string;
    created_at: Date;
    expires_at: Date;
    consumed_at?: Date | null;
    released_at?: Date | null;
    permit_id: string;
  }): Reservation {
    const result: Reservation = {
      id: row.id,
      intentId: row.intent_id,
      decisionId: row.decision_id ?? row.risk_decision_id ?? "",
      account: row.account,
      asset: row.asset,
      amount: BigInt(row.amount ?? 0),
      currency: row.currency ?? "pUSD",
      status: row.status as ReservationStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      permitId: row.permit_id,
    };
    if (row.consumed_at) result.consumedAt = row.consumed_at;
    if (row.released_at) result.releasedAt = row.released_at;
    return result;
  }
}

/**
 * Check if a reservation is still valid for trading.
 */
export function isReservationValid(
  reservation: {
    status: string;
    expires_at: Date;
    used_at: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (reservation.status !== "ACTIVE") return false;
  if (reservation.used_at !== null) return false;
  if (now > reservation.expires_at) return false;
  return true;
}