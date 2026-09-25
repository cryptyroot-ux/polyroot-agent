/**
 * @polyroot/venue — Durable seen-orders store (restart idempotency).
 *
 * The executor's `seen` interface is synchronous (hot path), so PgSeenStore
 * keeps a sync in-memory mirror and persists write-through to the
 * `seen_orders` table (migration 0021). At startup, `hydrate()` loads
 * persisted states plus unresolved recovery-ledger rows BEFORE the pipeline
 * accepts new intents, so a restart can never re-submit a known order.
 */

import type { OrderLifecycleState } from "@polyroot/domain";

interface QueryablePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** DB-backed idempotency log with a sync mirror for the executor hot path. */
export class PgSeenStore {
  private readonly mirror = new Map<string, OrderLifecycleState>();
  private readonly pending = new Map<string, OrderLifecycleState>();

  constructor(private readonly pool: QueryablePool) {}

  /** Load persisted states + unresolved recovery rows before accepting intents. */
  async hydrate(
    unresolved: Array<{
      orderId: string;
      state: OrderLifecycleState;
    }>,
  ): Promise<void> {
    const res = await this.pool.query(
      `SELECT order_id, state FROM seen_orders`,
    );
    for (const row of res.rows) {
      this.mirror.set(
        String(row["order_id"]),
        String(row["state"]) as OrderLifecycleState,
      );
    }
    for (const u of unresolved) this.mirror.set(u.orderId, u.state);
  }

  has(orderId: string): boolean {
    return this.mirror.has(orderId);
  }

  get(orderId: string): OrderLifecycleState | undefined {
    return this.mirror.get(orderId);
  }

  /** Sync for the executor hot path; call flush() to persist. */
  set(orderId: string, state: OrderLifecycleState): void {
    this.mirror.set(orderId, state);
    this.pending.set(orderId, state);
  }

  /** Persist all pending states (upsert). Idempotent. */
  async flush(): Promise<void> {
    for (const [orderId, state] of this.pending) {
      await this.pool.query(
        `INSERT INTO seen_orders (order_id, state, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (order_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [orderId, state],
      );
      this.pending.delete(orderId);
    }
  }
}
