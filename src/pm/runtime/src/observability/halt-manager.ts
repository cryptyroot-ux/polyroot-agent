/**
 * @polyroot/runtime — Emergency kill switch for `polyroot halt`.
 *
 * Fail-closed ordering:
 *   1. Engage the loss latch in `live_guard_state` FIRST. If this write
 *      fails, nothing else happens (no kills, no cancels, no exit) and the
 *      error propagates — the operator sees a failure instead of a lie.
 *   2. Best-effort remote cancel of locally-tracked open orders.
 *   3. Stop local agent processes.
 *   4. Exit the process (default `process.exit(1)` so supervisors restart).
 *
 * All side effects beyond the latch write are injected, so unit tests run
 * with zero database, network, or process side effects.
 */

import type { QueryablePool } from "../mode-watcher.js";
import { PgLiveGuardStore } from "../live-guard-store.js";

export interface HaltRequest {
  /** Operator-visible reason recorded in the result (not persisted). */
  reason: string;
  /** Attempt remote cancel of open venue orders before stopping. */
  cancelOrders: boolean;
}

export interface HaltDeps {
  pool: QueryablePool;
  /** Cancel one venue order by id; resolves true when confirmed canceled. */
  cancelVenueOrder?: ((venueOrderId: string) => Promise<boolean>) | undefined;
  /** Stop local agent processes (pkill, supervisor signal, ...). */
  killLocalAgents?: (() => Promise<void>) | undefined;
  /** Terminate this process. Defaults to process.exit. */
  exit?: ((code: number) => never) | undefined;
  /** Observe the final counts before exit (CLI prints them here). */
  report?: ((result: HaltResult) => void) | undefined;
}

export interface HaltResult {
  halted: boolean;
  /** Orders found open in the local ledger. */
  openOrders: number;
  /** Remote cancels confirmed. */
  canceledOrders: number;
  reason: string;
}

const TERMINAL_ORDER_STATUSES = [
  "FILLED",
  "CANCELED",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
  "REJECTED",
];

function defaultExit(code: number): never {
  process.exit(code);
}

/**
 * Engage the halt latch, optionally cancel open orders, stop local agents,
 * then exit. Throws on latch-write failure WITHOUT any other side effect.
 */
export async function requestHalt(
  deps: HaltDeps,
  req: HaltRequest,
): Promise<HaltResult> {
  const store = new PgLiveGuardStore(deps.pool);
  const prev = await store.load();
  await store.save({
    halted: true,
    haltedAt: new Date().toISOString(),
    realizedLossPusd: prev?.realizedLossPusd ?? 0,
  });

  let openOrders = 0;
  let canceledOrders = 0;
  if (req.cancelOrders) {
    const res = await deps.pool.query(
      `SELECT venue_order_id FROM orders
        WHERE venue_order_id IS NOT NULL
          AND status NOT IN (${TERMINAL_ORDER_STATUSES.map((_, i) => `$${i + 1}`).join(", ")})`,
      TERMINAL_ORDER_STATUSES,
    );
    const ids: string[] = [];
    for (const row of res.rows) {
      const id = row["venue_order_id"];
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    openOrders = ids.length;
    if (deps.cancelVenueOrder !== undefined) {
      for (const id of ids) {
        try {
          if (await deps.cancelVenueOrder(id)) canceledOrders += 1;
        } catch {
          // Best-effort: one failed cancel must not block the rest or exit.
        }
      }
    }
  }

  if (deps.killLocalAgents !== undefined) {
    await deps.killLocalAgents();
  }

  const result: HaltResult = {
    halted: true,
    openOrders,
    canceledOrders,
    reason: req.reason,
  };
  deps.report?.(result);
  const exit = deps.exit ?? defaultExit;
  exit(1);
  return result;
}
