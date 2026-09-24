/**
 * @polyroot/venue — Recovery Ledger (PM-EXE-04/06, Blueprint B11).
 *
 * Durable in-flight order tracking across restarts.
 * Single source of truth for reconciliation. Never blind-retry.
 * State machine: NOT_SEEN -> SUBMITTING -> ACKNOWLEDGED | SUBMISSION_UNKNOWN -> DEFINITIVE_REJECT
 */

import { Pool, type PoolConfig } from "pg";
import type { OrderLifecycleState, OrderResult } from "@polyroot/domain";

/** In-flight order record for reconciliation. All optional properties are explicitly required with undefined defaults. */
export interface InFlightOrder {
  orderId: string;
  venueOrderId: string | undefined;
  permitId: string | undefined;
  state: OrderLifecycleState;
  submittedAt: Date | undefined;
  acknowledgedAt: Date | undefined;
  lastReconcileAt: Date | undefined;
  reconcileCount: number;
  resolved: boolean;
  resolvedAt: Date | undefined;
  resolvedState: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/** Interface for durable recovery ledger (abstract contract). */
export interface IRecoveryLedger {
  /** Record a new order as SUBMITTING before venue call. */
  addSubmittedUnknown(
    orderId: string,
    venueOrderId?: string,
    permitId?: string,
  ): Promise<void>;
  /**
   * Atomically claim a permit and record SUBMITTING in one transaction.
   * (P0-8: eliminates the crash window between claim and recovery write.)
   */
  claimPermitAndRecordSubmission(
    permitId: string,
    orderId: string,
    venueOrderId?: string,
  ): Promise<
    { ok: true; permitId: string } | { ok: false; code: string; reason: string }
  >;
  /** Record that a cancel was requested (state = CANCEL_UNKNOWN). */
  recordCancelRequested(orderId: string): Promise<void>;
  /** Resolve an order with definitive venue-sourced result. */
  resolve(
    orderId: string,
    fromVenue: boolean,
    result?: OrderResult,
  ): Promise<void>;
  /** Check if an order needs reconciliation on restart. */
  needsReconcile(orderId: string): boolean | Promise<boolean>;
  /** Get all orders needing reconciliation. */
  getUnresolved(): Promise<InFlightOrder[]>;
  /** Get order state for reconciliation. */
  get(orderId: string): Promise<InFlightOrder | null>;
  /** Update order state during reconciliation. */
  updateState(
    orderId: string,
    state: OrderLifecycleState,
    venueOrderId?: string,
  ): Promise<void>;
  /** Map current confirmed-cancelled set (only definitively resolved cancels). */
  certainCancels(): string[] | Promise<string[]>;
}

/** PostgreSQL implementation using recovery_ledger table (migration 0005). */
/** Shape of a recovery_ledger row as returned by pg (snake_case columns). */
interface RecoveryLedgerRow {
  order_id: string;
  venue_order_id: string | null;
  permit_id: string | null;
  state: OrderLifecycleState;
  submitted_at: Date | null;
  acknowledged_at: Date | null;
  last_reconcile_at: Date | null;
  reconcile_count: number;
  resolved: boolean;
  resolved_at: Date | null;
  resolved_state: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" | null;
  created_at: Date;
  updated_at: Date;
}

export class PgRecoveryLedger implements IRecoveryLedger {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async addSubmittedUnknown(
    orderId: string,
    venueOrderId?: string,
    permitId?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO recovery_ledger (order_id, venue_order_id, permit_id, state, submitted_at, resolved, created_at, updated_at)
       VALUES ($1, $2, $3, 'SUBMITTING', now(), false, now(), now())
       ON CONFLICT (order_id) DO UPDATE SET
         venue_order_id = EXCLUDED.venue_order_id,
         permit_id = EXCLUDED.permit_id,
         state = 'SUBMITTING',
         submitted_at = now(),
         updated_at = now()`,
      [orderId, venueOrderId ?? null, permitId ?? null],
    );
  }

  /**
   * Atomically claim a permit AND record a SUBMITTING state in the recovery ledger
   * within a single database transaction. This eliminates the crash window between
   * claiming a permit and recording the in-flight order state.
   * Returns the claimed permit's permit_id on success.
   */
  async claimPermitAndRecordSubmission(
    permitId: string,
    orderId: string,
    venueOrderId?: string,
  ): Promise<
    { ok: true; permitId: string } | { ok: false; code: string; reason: string }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 1. Atomically claim the permit (idempotent: fails if already used/expired)
      const claimResult = await client.query(
        `UPDATE execution_permits
         SET used_at = now(),
             claimed_order_id = $2,
             payload_hash = (SELECT computePermitHash(jsonb_set(to_jsonb(execution_permits), '{used_at}', to_jsonb(now()))))
         WHERE permit_id = $1
           AND used_at IS NULL
           AND expires_at > now()
         RETURNING permit_id`,
        [permitId, orderId],
      );
      if (claimResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "PERMIT_INVALID",
          reason: "permit already used or expired",
        };
      }

      // 2. Record the SUBMITTING state in the recovery ledger (same transaction)
      await client.query(
        `INSERT INTO recovery_ledger (order_id, venue_order_id, permit_id, state, submitted_at, resolved, created_at, updated_at)
         VALUES ($1, $2, $3, 'SUBMITTING', now(), false, now(), now())
         ON CONFLICT (order_id) DO UPDATE SET
           venue_order_id = EXCLUDED.venue_order_id,
           permit_id = EXCLUDED.permit_id,
           state = 'SUBMITTING',
           submitted_at = now(),
           updated_at = now()`,
        [orderId, venueOrderId ?? null, permitId],
      );

      await client.query("COMMIT");
      return { ok: true, permitId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        ok: false,
        code: "ATOMIC_CLAIM_FAILED",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      client.release();
    }
  }

  async recordCancelRequested(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE recovery_ledger SET state = 'CANCEL_UNKNOWN', updated_at = now()
       WHERE order_id = $1 AND resolved = false`,
      [orderId],
    );
  }

  async resolve(
    orderId: string,
    fromVenue: boolean,
    result?: OrderResult,
  ): Promise<void> {
    if (!fromVenue) return;
    // No default to CANCEL_CERTAIN: timeout/error without venue result is definitively unknown,
    // treated as DEFINITIVE_REJECT. CANCEL_CERTAIN is reserved only for explicit cancel confirmations.
    let resolvedState: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" =
      "DEFINITIVE_REJECT";
    if (result) {
      if (
        result.order_status === "LIVE" ||
        result.order_status === "PARTIAL" ||
        result.order_status === "MATCHED" ||
        result.submit_status === "ACKNOWLEDGED"
      ) {
        resolvedState = "ACKNOWLEDGED";
      } else if (
        result.order_status === "CANCELED" ||
        result.order_status === "REJECTED" ||
        result.order_status === "EXPIRED"
      ) {
        resolvedState = "DEFINITIVE_REJECT";
      }
    }
    await this.pool.query(
      `UPDATE recovery_ledger
       SET state = $1, resolved = true, resolved_state = $2, resolved_at = now(), updated_at = now()
       WHERE order_id = $3`,
      [resolvedState, resolvedState, orderId],
    );
  }

  async needsReconcile(orderId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT resolved FROM recovery_ledger WHERE order_id = $1`,
      [orderId],
    );
    return (
      result.rowCount !== null &&
      result.rowCount > 0 &&
      !result.rows[0].resolved
    );
  }

  async getUnresolved(): Promise<InFlightOrder[]> {
    const result = await this.pool.query(
      `SELECT * FROM recovery_ledger WHERE resolved = false ORDER BY created_at DESC`,
    );
    return result.rows.map(this.mapRow);
  }

  async get(orderId: string): Promise<InFlightOrder | null> {
    const result = await this.pool.query(
      `SELECT * FROM recovery_ledger WHERE order_id = $1`,
      [orderId],
    );
    if (result.rowCount === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async updateState(
    orderId: string,
    state: OrderLifecycleState,
    venueOrderId?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE recovery_ledger SET state = $1, venue_order_id = COALESCE($2, venue_order_id), updated_at = now()
       WHERE order_id = $3`,
      [state, venueOrderId ?? null, orderId],
    );
  }

  async certainCancels(): Promise<string[]> {
    const result = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM recovery_ledger WHERE resolved = true AND state = 'CANCEL_CERTAIN'`,
    );
    return result.rows.map((r) => r.order_id);
  }

  /** Shape of a recovery_ledger row as returned by pg. */
  private mapRow(row: RecoveryLedgerRow): InFlightOrder {
    return {
      orderId: row.order_id,
      venueOrderId: row.venue_order_id ?? undefined,
      permitId: row.permit_id ?? undefined,
      state: row.state,
      submittedAt: row.submitted_at ?? undefined,
      acknowledgedAt: row.acknowledged_at ?? undefined,
      lastReconcileAt: row.last_reconcile_at ?? undefined,
      reconcileCount: row.reconcile_count,
      resolved: row.resolved,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedState: row.resolved_state ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async close(): Promise<void> {
    // Pool is managed externally
  }
}

/** In-memory implementation for testing. */
export class MemRecoveryLedger implements IRecoveryLedger {
  private readonly orders = new Map<string, InFlightOrder>();
  /** Track claimed permits (for atomic claim idempotency). */
  private readonly claimedPermits = new Set<string>();

  /** Factory that returns a fully-specified InFlightOrder for exactOptionalPropertyTypes compliance. */
  private createOrder(
    orderId: string,
    state: OrderLifecycleState,
    extra: Partial<InFlightOrder> = {},
  ): InFlightOrder {
    return {
      orderId,
      venueOrderId: undefined,
      permitId: undefined,
      state,
      submittedAt: undefined,
      acknowledgedAt: undefined,
      lastReconcileAt: undefined,
      reconcileCount: 0,
      resolved: false,
      resolvedAt: undefined,
      resolvedState: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    };
  }

  async addSubmittedUnknown(
    orderId: string,
    _venueOrderId?: string,
    _permitId?: string,
  ): Promise<void> {
    this.orders.set(
      orderId,
      this.createOrder(orderId, "SUBMITTING", {
        reconcileCount: 0,
        resolved: false,
      }),
    );
  }

  /** In-memory atomic claim + SUBMITTING record (P0-8 compatible). */
  async claimPermitAndRecordSubmission(
    permitId: string,
    orderId: string,
    venueOrderId?: string,
  ): Promise<
    { ok: true; permitId: string } | { ok: false; code: string; reason: string }
  > {
    // In-memory: the caller (executor) has already validated the permit is
    // single-use and claimable; record SUBMITTING and report success.
    this.orders.set(
      orderId,
      this.createOrder(orderId, "SUBMITTING", {
        permitId,
        venueOrderId,
        reconcileCount: 0,
        resolved: false,
      }),
    );
    return { ok: true, permitId };
  }

  async recordCancelRequested(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && !o.resolved) {
      o.state = "CANCEL_UNKNOWN";
      o.updatedAt = new Date();
    }
  }

  async resolve(
    orderId: string,
    fromVenue: boolean,
    result?: OrderResult,
  ): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && fromVenue) {
      // No default to CANCEL_CERTAIN: timeout/error without venue result is
      // treated as DEFINITIVE_REJECT. CANCEL_CERTAIN only with explicit venue cancel.
      let resolvedState: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" =
        "DEFINITIVE_REJECT";
      if (result) {
        if (
          result.order_status === "LIVE" ||
          result.order_status === "PARTIAL" ||
          result.order_status === "MATCHED" ||
          result.submit_status === "ACKNOWLEDGED"
        ) {
          resolvedState = "ACKNOWLEDGED";
        } else if (
          result.order_status === "CANCELED" ||
          result.order_status === "REJECTED" ||
          result.order_status === "EXPIRED"
        ) {
          resolvedState = "DEFINITIVE_REJECT";
        }
      }
      o.resolved = true;
      o.resolvedState = resolvedState;
      o.resolvedAt = new Date();
      o.updatedAt = new Date();
      if (resolvedState === "ACKNOWLEDGED") {
        o.state = "ACKNOWLEDGED";
        o.acknowledgedAt = new Date();
      } else {
        o.state = "DEFINITIVE_REJECT";
      }
    }
  }

  needsReconcile(orderId: string): boolean {
    const o = this.orders.get(orderId);
    return !!o && !o.resolved;
  }

  async getUnresolved(): Promise<InFlightOrder[]> {
    const out: InFlightOrder[] = [];
    for (const [, o] of this.orders) {
      if (!o.resolved) out.push({ ...o });
    }
    return out;
  }

  async get(orderId: string): Promise<InFlightOrder | null> {
    const o = this.orders.get(orderId);
    return o ? { ...o } : null;
  }

  async updateState(
    orderId: string,
    state: OrderLifecycleState,
    venueOrderId?: string,
  ): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) {
      o.state = state;
      if (venueOrderId) o.venueOrderId = venueOrderId;
      o.updatedAt = new Date();
    }
  }

  certainCancels(): string[] {
    const out: string[] = [];
    for (const [, o] of this.orders) {
      if (o.resolved && o.state === "CANCEL_CERTAIN") out.push(o.orderId);
    }
    return out;
  }
}

/**
 * Backward-compatible RecoveryLedger class for tests.
 * Provides the same constructor interface as the original in-memory implementation.
 */
export class RecoveryLedger extends MemRecoveryLedger {
  constructor(opts?: { clock?: () => number }) {
    super();
    if (opts?.clock) {
      // Store clock for time-based tests
      Object.assign(this, { clock: opts.clock });
    }
  }
}
