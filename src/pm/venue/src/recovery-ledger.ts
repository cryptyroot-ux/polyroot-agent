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

/** Interface for durable recovery ledger. */
export interface RecoveryLedger {
  /** Record a new order as SUBMITTING before venue call. */
  addSubmittedUnknown(orderId: string, venueOrderId?: string, permitId?: string): Promise<void>;
  /** Record that a cancel was requested (state = CANCEL_UNKNOWN). */
  recordCancelRequested(orderId: string): Promise<void>;
  /** Resolve an order with definitive venue-sourced result. */
  resolve(orderId: string, fromVenue: boolean, result?: OrderResult): Promise<void>;
  /** Check if an order needs reconciliation on restart. */
  needsReconcile(orderId: string): Promise<boolean>;
  /** Get all orders needing reconciliation. */
  getUnresolved(): Promise<InFlightOrder[]>;
  /** Get order state for reconciliation. */
  get(orderId: string): Promise<InFlightOrder | null>;
  /** Update order state during reconciliation. */
  updateState(orderId: string, state: OrderLifecycleState, venueOrderId?: string): Promise<void>;
}

/** PostgreSQL implementation using recovery_ledger table (migration 0005). */
export class PgRecoveryLedger implements RecoveryLedger {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async addSubmittedUnknown(orderId: string, venueOrderId?: string, permitId?: string): Promise<void> {
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

  async recordCancelRequested(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE recovery_ledger SET state = 'CANCEL_UNKNOWN', updated_at = now()
       WHERE order_id = $1 AND resolved = false`,
      [orderId],
    );
  }

  async resolve(orderId: string, fromVenue: boolean, result?: OrderResult): Promise<void> {
    if (!fromVenue) return;
    let resolvedState: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" = "DEFINITIVE_REJECT";
    if (result) {
      if (
        result.order_status === "LIVE" ||
        result.order_status === "PARTIAL" ||
        result.order_status === "MATCHED" ||
        (result.submit_status === "ACKNOWLEDGED")
      ) {
        resolvedState = "ACKNOWLEDGED";
      }
    }
    await this.pool.query(
      `UPDATE recovery_ledger
       SET state = $1, resolved = true, resolved_state = $2, resolved_at = now(), updated_at = now()
       WHERE order_id = $3`,
      [resolvedState === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "DEFINITIVE_REJECT", resolvedState, orderId],
    );
  }

  async needsReconcile(orderId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT resolved FROM recovery_ledger WHERE order_id = $1`,
      [orderId],
    );
    return result.rowCount !== null && result.rowCount > 0 && !result.rows[0].resolved;
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

  async updateState(orderId: string, state: OrderLifecycleState, venueOrderId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE recovery_ledger SET state = $1, venue_order_id = COALESCE($2, venue_order_id), updated_at = now()
       WHERE order_id = $3`,
      [state, venueOrderId ?? null, orderId],
    );
  }

  private mapRow(row: any): InFlightOrder {
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
export class MemRecoveryLedger implements RecoveryLedger {
  private readonly orders = new Map<string, InFlightOrder>();

  /** Factory that returns a fully-specified InFlightOrder for exactOptionalPropertyTypes compliance. */
  private createOrder(
    orderId: string,
    state: OrderLifecycleState,
    extra: Partial<InFlightOrder> = {},
  ): InFlightOrder {
    const now = new Date();
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


  async addSubmittedUnknown(orderId: string, _venueOrderId?: string, _permitId?: string): Promise<void> {
    this.orders.set(orderId, this.createOrder(orderId, "SUBMITTING", {
      reconcileCount: 0,
      resolved: false,
    }));
  }

  async recordCancelRequested(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && !o.resolved) {
      o.state = "CANCEL_UNKNOWN";
      o.updatedAt = new Date();
    }
  }

  async resolve(orderId: string, fromVenue: boolean, result?: OrderResult): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && fromVenue) {
      let resolvedState: "ACKNOWLEDGED" | "DEFINITIVE_REJECT" = "DEFINITIVE_REJECT";
      if (result) {
        if (
          result.order_status === "LIVE" ||
          result.order_status === "PARTIAL" ||
          result.order_status === "MATCHED" ||
          (result.submit_status === "ACKNOWLEDGED")
        ) {
          resolvedState = "ACKNOWLEDGED";
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

  async needsReconcile(orderId: string): Promise<boolean> {
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

  async updateState(orderId: string, state: OrderLifecycleState, venueOrderId?: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) {
      o.state = state;
      if (venueOrderId) o.venueOrderId = venueOrderId;
      o.updatedAt = new Date();
    }
  }
}
