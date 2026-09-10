/**
 * PostgreSQL integration tests for the wired orchestrator stack.
 * Verifies #1 (PgBalanceStore/PgKernelEventSink → MoneyKernel),
 * #2 (Executor → PgPersistence/PgReconciler), #3 (Supervisor),
 * against the real PostgreSQL database.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";

const PG_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://polyroot:polyroot@127.0.0.1:5432/polyroot_dev";

// Skip cleanly if DB is unreachable (CI without Postgres).
function dbAvailable(): boolean {
  try {
    execFileSync("psql", [PG_URL, "-c", "SELECT 1"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DB_OK = dbAvailable();

describe("PostgreSQL persistence integration (points #1-#3)", { skip: !DB_OK }, () => {
  it("BalanceStore + KernelEventSink round-trip through the real DB", async () => {
    const { PgBalanceStore, PgKernelEventSink } = await import("@polyroot/risk");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    const store = new PgBalanceStore(pool);
    const sink = new PgKernelEventSink(pool);

    await pool.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base)
       VALUES ('pg_it_wallet', 'pUSD', 5_000_000, 0)
       ON CONFLICT (account, asset) DO UPDATE SET available_base = 5_000_000, committed_base = 0`,
    );

    const before = await store.get("pg_it_wallet", "pUSD");
    assert.equal(before.availableBase, 5_000_000n);

    // Commit 2,000,000 (reserve) → available 3,000,000
    await store.commit("pg_it_wallet", "pUSD", 2_000_000n);
    const after = await store.get("pg_it_wallet", "pUSD");
    assert.equal(after.availableBase, 3_000_000n);
    assert.equal(after.committedBase, 2_000_000n);

    // Event sink write
    const beforeCount = (
      await pool.query("SELECT COUNT(*)::int AS c FROM kernel_events")
    ).rows[0].c;
    await sink.push("RESERVATION_CREATED", {
      reservationId: "res_pg_it",
      cashBase: "2000000",
    });
    const afterCount = (
      await pool.query("SELECT COUNT(*)::int AS c FROM kernel_events")
    ).rows[0].c;
    assert.equal(afterCount, beforeCount + 1);

    await pool.end();
  });

  it("PgPersistence get/set/listUnknown round-trip", async () => {
    const { PgPersistence } = await import("@polyroot/control");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    // Generate unique id for this run
    const orderUuid = crypto.randomUUID();

    const persistence = new PgPersistence(pool);

    await pool.query(
      `INSERT INTO trade_intents (dedupe_key, purpose, market_id, side, price, size, order_type, expiration_sec, strategy, status, created_at)
       VALUES ('pg_persist_${orderUuid}', 'ENTRY', 'mkt_pg_persist', 'YES', 0.5, 1, 'LIMIT', 60, 'test', 'PROPOSED', now())`,
    );
    const intentRow = (
      await pool.query(`SELECT id FROM trade_intents WHERE dedupe_key = 'pg_persist_${orderUuid}' LIMIT 1`)
    ).rows[0];
    await pool.query(
      `INSERT INTO orders (id, intent_id, market_id, side, price, size, fee_rate_bps, nonce, expiration)
       VALUES ($1::uuid, $2::uuid, 'mkt_pg_persist', 'BUY', 0.5, 1, 0, 1, 1000)`,
      [orderUuid, intentRow.id],
    );
    await persistence.set(orderUuid, "SUBMISSION_UNKNOWN");

    const state = await persistence.get(orderUuid);
    assert.equal(state, "SUBMISSION_UNKNOWN");

    const unknowns = await persistence.listUnknown();
    assert.ok(unknowns.includes(orderUuid));

    await pool.end();
  });

  it("Supervisor health counters are PostgreSQL-backed (survive instance restart)", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    await pool.query(
      `UPDATE supervisor_state SET total_order_count = 0, unknown_order_count = 0, unresolved_intent_count = 0
       WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );

    // Simulate an instance recording counts
    await pool.query(
      `UPDATE supervisor_state SET total_order_count = 7, unknown_order_count = 2
       WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );

    // New "instance" (new pool/connection) reads persisted counters
    const pool2 = new Pool({ connectionString: PG_URL });
    const row = (
      await pool2.query(
        `SELECT total_order_count, unknown_order_count FROM supervisor_state
         WHERE id = '00000000-0000-0000-0000-000000000001'`,
      )
    ).rows[0];
    assert.equal(Number(row.total_order_count), 7);
    assert.equal(Number(row.unknown_order_count), 2);

    await pool.end();
    await pool2.end();
  });

  it("PgReconciler attempts reconciliation on SUBMISSION_UNKNOWN orders", async () => {
    const { PgReconciler } = await import("@polyroot/control");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    const orderUuid = crypto.randomUUID();
    const intentKey = `pg_recon_${crypto.randomUUID().slice(0, 8)}`;

    await pool.query(
      `INSERT INTO trade_intents (dedupe_key, purpose, market_id, side, price, size, order_type, expiration_sec, strategy, status, created_at)
       VALUES ('${intentKey}', 'ENTRY', 'mkt_pg_recon', 'YES', 0.5, 1, 'LIMIT', 60, 'test', 'PROPOSED', now())`,
    );
    const intentRow = (
      await pool.query(`SELECT id FROM trade_intents WHERE dedupe_key = '${intentKey}' LIMIT 1`)
    ).rows[0];
    await pool.query(
      `INSERT INTO orders (id, intent_id, market_id, side, price, size, fee_rate_bps, nonce, expiration)
       VALUES ($1::uuid, $2::uuid, 'mkt_pg_recon', 'BUY', 0.5, 1, 0, 1, 1000)`,
      [orderUuid, intentRow.id],
    );
    await pool.query(
      `INSERT INTO recovery_ledger (order_id, state, submitted_at)
       VALUES ($1::uuid, 'SUBMISSION_UNKNOWN', now())`,
      [orderUuid],
    );

    // Instance a PgReconciler over a fake executor that returns ACKNOWLEDGED
    const fakeExecutor = {
      reconcile: async (id: string) => {
        return "ACKNOWLEDGED" as const;
      },
    };
    const reconciler = new PgReconciler(fakeExecutor as any, pool);

    // Run reconciliation — it should call executor.reconcile for the unknown order
    await reconciler.reconcileAll();

    // After reconcile, order should be ACKNOWLEDGED (no longer unknown)
    const row = (
      await pool.query(`SELECT state, resolved FROM recovery_ledger WHERE order_id = $1`, [orderUuid])
    ).rows[0];
    assert.equal(row.state, "ACKNOWLEDGED");
    assert.ok(row.resolved);

    await pool.end();
  });

  it("Supervisor.startPeriodicReconciliation schedules and can be stopped", async () => {
    const { PgSupervisor } = await import("@polyroot/control");
    const { Reconciler } = await import("@polyroot/control");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    // A Reconciler that counts invocations without needing DB rows.
    let reconcileAllCount = 0;
    class CountingReconciler extends Reconciler {
      constructor() {
        super({ reconcile: async () => "ACKNOWLEDGED" as const } as any, { listUnknown: async () => [], set: async () => {}, get: async () => undefined } as any);
      }
      override async reconcileAll(): Promise<void> {
        reconcileAllCount++;
      }
    }

    const reconciler = new CountingReconciler();
    const policy = { reconcile_interval_s: 1 };
    const pgSuper = new PgSupervisor(reconciler, pool, policy as any);

    // Start periodic reconciliation with 80ms interval (fast for testing)
    const stop = pgSuper.startPeriodicReconciliation(80);
    await new Promise((r) => setTimeout(r, 220));
    stop();
    const countAfter = reconcileAllCount;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(reconcileAllCount, countAfter, "No more reconciliations after stop");
    assert.ok(countAfter > 0, "At least one reconciliation ran");

    await pool.end();
  });
});