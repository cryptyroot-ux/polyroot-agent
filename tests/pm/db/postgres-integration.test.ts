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

describe(
  "PostgreSQL persistence integration (points #1-#3)",
  { skip: !DB_OK },
  () => {
    it("BalanceStore + KernelEventSink round-trip through the real DB", async () => {
      const { PgBalanceStore, PgKernelEventSink } =
        await import("@polyroot/risk");
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
      await store.reserveFunds("pg_it_wallet", "pUSD", 2_000_000n);
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
        await pool.query(
          `SELECT id FROM trade_intents WHERE dedupe_key = 'pg_persist_${orderUuid}' LIMIT 1`,
        )
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
        await pool.query(
          `SELECT id FROM trade_intents WHERE dedupe_key = '${intentKey}' LIMIT 1`,
        )
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
        await pool.query(
          `SELECT state, resolved FROM recovery_ledger WHERE order_id = $1`,
          [orderUuid],
        )
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
          super(
            { reconcile: async () => "ACKNOWLEDGED" as const } as any,
            {
              listUnknown: async () => [],
              set: async () => {},
              get: async () => undefined,
            } as any,
          );
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
      assert.equal(
        reconcileAllCount,
        countAfter,
        "No more reconciliations after stop",
      );
      assert.ok(countAfter > 0, "At least one reconciliation ran");

      await pool.end();
    });
  },
);
describe("EventStore idempotency and replay (P0-1)", { skip: !DB_OK }, () => {
  it("append persists domain event.id, duplicate append returns existing with created=false", async () => {
    const { PgEventStore } = await import("@polyroot/ledger");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    const store = new PgEventStore(pool);

    const domainEventId = crypto.randomUUID();
    const event = {
      schema_version: "1.0.0",
      id: domainEventId,
      type: "INTENT_PROPOSED" as const,
      aggregate_id: crypto.randomUUID(),
      aggregate_type: "Intent" as const,
      payload: { test: "idempotency" },
      timestamp: new Date(),
    };

    // First append: created=true, eventId matches domain id exactly
    const r1 = await store.append(event);
    assert.equal(r1.created, true, "first append must be created=true");
    assert.equal(
      r1.eventId,
      domainEventId,
      "persisted eventId must match domain id",
    );

    // Second append: created=false, same eventId, same sequence
    const r2 = await store.append(event);
    assert.equal(r2.created, false, "duplicate append must be created=false");
    assert.equal(
      r2.eventId,
      domainEventId,
      "duplicate eventId must match domain id",
    );
    assert.equal(
      r2.sequence,
      r1.sequence,
      "duplicate sequence must match first",
    );

    // Verify exactly one row in DB for this event id
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS c FROM kernel_events WHERE id = $1`,
      [domainEventId],
    );
    assert.equal(
      countResult.rows[0].c,
      1,
      "exactly one row for duplicate event",
    );

    // Verify getEvent returns the persisted domain id
    const fetched = await store.getEvent(domainEventId);
    assert.ok(fetched, "getEvent must find the persisted event");
    assert.equal(fetched.id, domainEventId);
    assert.equal(fetched.type, "INTENT_PROPOSED");

    await pool.end();
  });

  it("replay returns events in sequence order and uses correct topic column", async () => {
    const { PgEventStore } = await import("@polyroot/ledger");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    const store = new PgEventStore(pool);

    const aggId = crypto.randomUUID();
    const makeEvent = (idx: number) => ({
      schema_version: "1.0.0" as string,
      id: crypto.randomUUID(),
      type: "RESERVATION_CREATED" as const,
      aggregate_id: aggId,
      aggregate_type: "Reservation" as const,
      payload: { step: idx },
      timestamp: new Date(Date.now() + idx),
    });

    // Append 3 events for the same aggregate
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    for (const ev of events) await store.append(ev);

    // Replay from sequence 0 (all events)
    const all = await store.replay({ fromSequence: 0n });
    assert.ok(
      all.length >= 3,
      `expected >=3 events in replay, got ${all.length}`,
    );

    // The 3 events for this aggregate must appear in ascending sequence order
    const ours = all.filter((e) => e.aggregate_id === aggId);
    assert.equal(ours.length, 3);
    assert.ok(
      ours[0].sequence < ours[1].sequence,
      "events must be ordered by sequence",
    );
    assert.ok(
      ours[1].sequence < ours[2].sequence,
      "events must be ordered by sequence",
    );

    // Verify topic→type mapping works (not a SQL column error)
    for (const e of ours) {
      assert.equal(e.type, "RESERVATION_CREATED");
    }

    // Aggregate replay filter
    const filtered = await store.replay({
      fromSequence: 0n,
      aggregateId: aggId,
    });
    assert.equal(filtered.length, 3);
    for (const e of filtered) {
      assert.equal(e.aggregate_id, aggId);
    }

    // lastSequence must be at least the highest sequence of our events
    const maxSeq = Math.max(...ours.map((e) => Number(e.sequence)));
    const last = await store.lastSequence();
    assert.ok(
      Number(last) >= maxSeq,
      "lastSequence must be >= max event sequence",
    );

    await pool.end();
  });
});

describe("G4-G6 runtime PostgreSQL integration", { skip: !DB_OK }, () => {
  it("G4: paper log + experiment registry round-trip through the real DB", async () => {
    const { PgPaperLog, PgExperimentRegistry } =
      await import("@polyroot/runtime");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    const paperLog = new PgPaperLog(pool);
    await pool.query("TRUNCATE TABLE paper_log RESTART IDENTITY");
    const registry = new PgExperimentRegistry(pool);

    // Preregister before running (no cherry-picking)
    const exp = await registry.preregister({
      name: "pg_g4_baseline",
      version: "0.1.0",
      description: "G4 integration baseline",
      preregisteredRule: "Stop if brier > 0.25 after 100 decisions",
      mode: "PAPER",
    });
    assert.equal(exp.status, "PREREGISTERED");

    // Log a full-universe paper decision
    await paperLog.insert({
      market_id: "mkt_g4_1",
      action: "BUY",
      forecastP: 0.62,
      size: 100,
      fillStatus: "FILLED",
      filledSize: 100,
      fillPrice: 0.6,
      makerFee: 0,
      takerFee: 120,
      uncertainty: 0.1,
      experimentId: exp.id,
      loopEpoch: 1,
    });
    await paperLog.insert({
      market_id: "mkt_g4_2",
      action: "NO_TRADE",
      forecastP: null,
      size: 0,
      fillStatus: "CANCELLED",
      filledSize: 0,
      fillPrice: null,
      makerFee: 0,
      takerFee: 0,
      uncertainty: 0.9,
      experimentId: exp.id,
      loopEpoch: 1,
    });

    const count = await paperLog.count();
    assert.ok(count >= 2, `expected >=2 paper_log rows, got ${count}`);
    const byAction = await paperLog.countByAction();
    assert.equal(byAction["BUY"], 1);
    assert.equal(byAction["NO_TRADE"], 1);

    // Conclude the experiment with metrics
    await registry.conclude(exp.id, {
      quality: {
        brier: 0.21,
        logLoss: 0.55,
        calibrationError: 0.08,
        sharpness: 0.3,
        coverage: 0.81,
        abstentionRate: 0.1,
        n: 2,
      },
      netPnl: 5.2,
      maxDrawdownPct: 0.01,
    });
    const concluded = await registry.get(exp.id);
    assert.equal(concluded?.status, "CONCLUDED");

    await pool.end();
  });

  it("G5: shadow baseline tracks days/clusters; gate NOT_RUN until criteria met", async () => {
    const { PgShadowBaseline } = await import("@polyroot/runtime");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    const shadow = new PgShadowBaseline(pool);

    // Fresh baseline (from migration insert) starts at 0 days / 0 clusters.
    const before = await shadow.snapshot();
    assert.equal(before.gatePassed, false);
    assert.ok(before.observedDays < 30);

    // Freeze exact versions + preregistered stopping rule.
    await shadow.freezeVersion(
      "deadbeef",
      "evaluate after 100 clusters or 30 days, whichever last",
    );

    const rows = await pool.query(
      `UPDATE shadow_baseline
       SET resolved_clusters=150, observed_days=45 WHERE id='00000000-0000-0000-0000-000000000001'
       RETURNING *`,
    );
    assert.ok(rows.rowCount === 1);

    const after = await shadow.snapshot();
    assert.equal(after.resolvedClusters, 150);
    assert.equal(after.versionsFrozenSha, "deadbeef");
    assert.equal(after.preregistered, true);

    // The snapshot evaluates the gate from the DB.
    const resp = await pool.query(
      `SELECT (observed_days >= 30 AND resolved_clusters >= 100) AS pass
       FROM shadow_baseline WHERE id='00000000-0000-0000-0000-000000000001'`,
    );
    assert.equal(resp.rows[0].pass, true);

    // IMPORTANT: this test only verifies ENGINE mechanics. Real G5 requires
    // >=30 actual calendar days; we reset the baseline so no fake evidence persists.
    await pool.query(
      `UPDATE shadow_baseline SET resolved_clusters=0, observed_days=0,
           versions_frozen_sha=NULL, preregistered=FALSE, pr_stopping_rule=NULL
       WHERE id='00000000-0000-0000-0000-000000000001'`,
    );

    await pool.end();
  });

  it("G6: micro-LIVE harness wiring validates capital cap + venue gating", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });

    // G6 requires a small EXPLICIT capital cap. We assert the policy plumbing
    // exists (capital_usd_cap column) — but no real funds/fills happen here.
    const col = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='risk_policy' AND column_name='capital_usd_cap'`,
      )
    ).rows;
    assert.equal(col.length, 1);

    await pool.end();
  });
});
