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

export type ReservationStatus =
  "ACTIVE" | "PARTIALLY_CONSUMED" | "CONSUMED" | "RELEASED" | "EXPIRED";

export interface Reservation {
  id: string;
  intentId: string;
  decisionId: string;
  account: string;
  asset: string;
  amount: bigint; // in base units (shares * 1e6)
  consumedAmount: bigint; // cumulative consumed (base units)
  releasedAmount: bigint; // cumulative released (base units)
  currency: string;
  status: ReservationStatus;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  releasedAt?: Date;
  expiredAt?: Date;
  permitId: string;
}

export interface ReservationManagerDeps {
  balanceStore: BalanceStore;
  permitStore: {
    get(permitId: string): Promise<{
      permit_id: string;
      reservation_ids: string[];
      used_at?: Date | null | undefined;
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
  }): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; code: string; reason: string }
  > {
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
   * Consume a reservation atomically, supporting PARTIAL fills.
   *
   * All balance + reservation updates run inside ONE database transaction on a
   * single client (P0-2), so there is no window where the reservation status
   * and the balance disagree.
   *
   * Accounting invariant (P0-3):
   *   0 <= consumed_amount <= amount
   *   consumed_amount + released_amount <= amount
   *   status = CONSUMED when consumed == amount, else PARTIALLY_CONSUMED.
   */
  async consume(
    reservationId: string,
    filledAmount: bigint,
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    if (!this.deps.pool) return { ok: true }; // in-memory mode
    if (filledAmount <= 0n) {
      return {
        ok: false,
        code: "INVALID_AMOUNT",
        reason: "filled amount must be positive",
      };
    }
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the reservation row for the duration of the accounting update.
      const r = await client.query(
        `SELECT account, asset, amount, status, consumed_amount, expires_at
         FROM reservations WHERE id=$1 FOR UPDATE`,
        [reservationId],
      );
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "RESERVATION_NOT_FOUND",
          reason: "reservation not found",
        };
      }
      const row = r.rows[0] as {
        account: string;
        asset: string;
        amount: string;
        status: string;
        consumed_amount: string;
        expires_at: Date | string | null;
      };
      // Fail-closed on expiry: a consumed fill is a FINAL economic posting.
      // An expired reservation (its permit is expired by the same deadline)
      // must never settle — release() remains available for cleanup so funds
      // cannot get stuck, but consume() is blocked with a typed code.
      if (row.expires_at) {
        const expiresAt =
          row.expires_at instanceof Date
            ? row.expires_at
            : new Date(row.expires_at);
        if (!Number.isNaN(expiresAt.getTime()) && new Date() > expiresAt) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            code: "PERMIT_EXPIRED",
            reason: "reservation expired (permit expired)",
          };
        }
      }
      if (row.status !== "ACTIVE" && row.status !== "PARTIALLY_CONSUMED") {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "RESERVATION_NOT_ACTIVE",
          reason: `reservation is ${row.status}`,
        };
      }
      const reserved = BigInt(row.amount);
      const alreadyConsumed = BigInt(row.consumed_amount ?? "0");
      const newConsumed = alreadyConsumed + filledAmount;
      if (newConsumed > reserved) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "OVER_CONSUME",
          reason: `consume ${newConsumed} exceeds reserved ${reserved}`,
        };
      }
      const fullyConsumed = newConsumed === reserved;
      const newStatus = fullyConsumed ? "CONSUMED" : "PARTIALLY_CONSUMED";

      // Balance + reservation update in the SAME transaction.
      await client.query(
        `UPDATE balance_entries
         SET committed_base = committed_base - $3, updated_at = now()
         WHERE account=$1 AND asset=$2 AND committed_base >= $3`,
        [row.account, row.asset, filledAmount.toString()],
      );
      await client.query(
        `UPDATE reservations
         SET consumed_amount=$2,
             consumed_at = CASE WHEN $3 THEN now() ELSE consumed_at END,
             status=$4
         WHERE id=$1`,
        [reservationId, newConsumed.toString(), fullyConsumed, newStatus],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        ok: false,
        code: "CONSUME_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Release remaining/rescind reservation funds atomically.
   * Runs the balance move and the reservation status update in ONE transaction.
   */
  async release(
    reservationId: string,
    reason: "CANCELLED" | "EXPIRED" | "REJECTED",
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    if (!this.deps.pool) return { ok: true };
    const terminalStatus = reason === "EXPIRED" ? "EXPIRED" : "RELEASED";
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `SELECT account, asset, amount, consumed_amount, released_amount, status
         FROM reservations WHERE id=$1 FOR UPDATE`,
        [reservationId],
      );
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "RESERVATION_NOT_FOUND",
          reason: "reservation not found",
        };
      }
      const row = r.rows[0] as {
        account: string;
        asset: string;
        amount: string;
        consumed_amount: string;
        released_amount: string;
        status: string;
      };
      if (row.status !== "ACTIVE" && row.status !== "PARTIALLY_CONSUMED") {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "RESERVATION_NOT_ACTIVE",
          reason: `reservation is ${row.status}`,
        };
      }
      const reserved = BigInt(row.amount);
      const consumed = BigInt(row.consumed_amount ?? "0");
      const released = BigInt(row.released_amount ?? "0");
      // Release only the remaining (unconsumed, unreleased) portion.
      const remaining = reserved - consumed - released;
      if (remaining < 0n) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "ACCOUNTING_INVARIANT_VIOLATED",
          reason: "negative remaining",
        };
      }
      const newReleased = released + remaining;

      if (remaining > 0n) {
        await client.query(
          `UPDATE balance_entries
           SET available_base = available_base + $3, committed_base = committed_base - $3, updated_at = now()
           WHERE account=$1 AND asset=$2 AND committed_base >= $3`,
          [row.account, row.asset, remaining.toString()],
        );
      }
      await client.query(
        `UPDATE reservations
         SET released_amount=$2,
             released_at = CASE WHEN $3 = 'EXPIRED' THEN released_at ELSE now() END,
             expired_at  = CASE WHEN $3 = 'EXPIRED' THEN now() ELSE expired_at END,
             status=$3
         WHERE id=$1`,
        [reservationId, newReleased.toString(), terminalStatus],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        ok: false,
        code: "RELEASE_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      client.release();
    }
  }

  /** Expire an overdue reservation → terminal EXPIRED state (not RELEASED). */
  async expire(
    reservationId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; reason: string }> {
    return this.release(reservationId, "EXPIRED");
  }

  /**
   * Expire every overdue ACTIVE/PARTIALLY_CONSUMED reservation.
   * Idempotent: already-terminal rows are never selected, and each per-id
   * expire() is itself atomic. Returns the count actually expired.
   */
  async expireOverdue(
    now: Date = new Date(),
  ): Promise<{ ok: true; expired: number }> {
    if (!this.deps.pool) return { ok: true, expired: 0 };
    const r = await this.deps.pool.query(
      `SELECT id FROM reservations
       WHERE status IN ('ACTIVE', 'PARTIALLY_CONSUMED') AND expires_at <= $1`,
      [now],
    );
    let expired = 0;
    for (const row of r.rows as Array<{ id: string }>) {
      const res = await this.expire(row.id);
      if (res.ok) expired += 1;
    }
    return { ok: true, expired };
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
    consumed_amount?: string | number;
    released_amount?: string | number;
    currency?: string;
    status: string;
    created_at: Date;
    expires_at: Date;
    consumed_at?: Date | null;
    released_at?: Date | null;
    expired_at?: Date | null;
    permit_id: string;
  }): Reservation {
    const result: Reservation = {
      id: row.id,
      intentId: row.intent_id,
      decisionId: row.decision_id ?? row.risk_decision_id ?? "",
      account: row.account,
      asset: row.asset,
      amount: BigInt(row.amount ?? 0),
      consumedAmount: BigInt(row.consumed_amount ?? 0),
      releasedAmount: BigInt(row.released_amount ?? 0),
      currency: row.currency ?? "pUSD",
      status: row.status as ReservationStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      permitId: row.permit_id,
    };
    if (row.consumed_at) result.consumedAt = row.consumed_at;
    if (row.released_at) result.releasedAt = row.released_at;
    if (row.expired_at) result.expiredAt = row.expired_at;
    return result;
  }
}

/**
 * Start a periodic reservation-expiry scheduler.
 * Runs `expireOverdue()` every `intervalMs`, guarded against overlapping
 * executions. Returns a stop function. The timer is unref'd so it never
 * holds the process open. Expiry failures are logged, never thrown.
 */
export function startReservationExpiryJob(
  deps: {
    reservations: Pick<ReservationManager, "expireOverdue">;
    now?: () => Date;
  },
  intervalMs = 30_000,
): () => void {
  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      await deps.reservations.expireOverdue(deps.now?.() ?? new Date());
    } catch (err) {
      console.error(
        `[reservations] periodic expiry failed: ${(err as Error).message}`,
      );
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Check if a reservation is still valid for trading.
 */ export function isReservationValid(
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
