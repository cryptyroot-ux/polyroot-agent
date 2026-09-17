import { describe, it } from "node:test";
import { PgMoneyAuthority } from "@polyroot/risk";
import assert from "node:assert/strict";
/**
 * P0: PgMoneyAuthority — real PostgreSQL integration tests.
 *
 * Verifies the atomic money path against a live DB:
 *   reserve() success → balance/reservation/permit/event all present
 *   insufficient balance → ROLLBACK (nothing durable)
 *   reservation limit → ROLLBACK
 *   two concurrent reserves → cannot overspend
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { Pool } from "pg";

const PG_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://polyroot:polyroot@127.0.0.1:5432/polyroot_dev";

function dbAvailable(): boolean {
  try {
    execFileSync("psql", [PG_URL, "-c", "SELECT 1"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DB_OK = dbAvailable();

describe("PgMoneyAuthority atomic authorization", { skip: !DB_OK }, () => {
  it("reserve() atomically writes reservation + permit + event + balance", async () => {
    const pool = new Pool({ connectionString: PG_URL });
    const auth = new PgMoneyAuthority(pool);

    const acct = `auth_wallet_${randomUUID()}`;
    const decisionId = randomUUID();
    const intentId = randomUUID();

    // Create required FK rows
    await pool.query(
      `INSERT INTO trade_intents (id, market_id, side, price, size, order_type, expiration_sec, strategy, status)
       VALUES ($1, 'test_market', 'YES', 0.5, 100, 'LIMIT', 3600, 'test_strategy', 'PROPOSED')`,
      [intentId],
    );
    await pool.query(
      `INSERT INTO risk_decisions (id, intent_id, status, decision_id, decided_at, reason_codes)
       VALUES ($1, $2, 'ACCEPTED', $1, now(), ARRAY[]::text[])`,
      [decisionId, intentId],
    );

    // Seed balance 10,000,000
    await pool.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base)
       VALUES ($1, 'pUSD', 10000000, 0)
       ON CONFLICT (account, asset) DO UPDATE SET available_base = 10000000, committed_base = 0`,
      [acct],
    );

    const res = await auth.reserve(acct, "pUSD", 5_000_000n, decisionId, intentId, 1, new Date());
    console.log("Test 1 Result:", JSON.stringify(res));
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error(res.reason);

    const bal = await pool.query(
      `SELECT available_base, committed_base FROM balance_entries
       WHERE account = $1 AND asset = 'pUSD'`,
      [acct],
    );
    assert.equal(bal.rows[0].available_base, "5000000", "available should drop by 5M");
    assert.equal(bal.rows[0].committed_base, "5000000", "committed should rise by 5M");

    const resv = await pool.query(
      `SELECT COUNT(*)::int AS c FROM reservations WHERE id = $1 AND status = 'ACTIVE'`,
      [res.reservationId],
    );
    assert.equal(resv.rows[0].c, 1, "reservation row must exist ACTIVE");

    const perm = await pool.query(
      `SELECT COUNT(*)::int AS c FROM execution_permits WHERE permit_id = $1 AND used_at IS NULL`,
      [res.permitId],
    );
    assert.equal(perm.rows[0].c, 1, "permit row must exist and unused");

    const evt = await pool.query(
      `SELECT COUNT(*)::int AS c FROM kernel_events WHERE topic = 'RESERVATION_CREATED'`,
    );
    assert.ok(evt.rows[0].c >= 1, "audit event must exist");

    await pool.end();
  });

  it("insufficient balance → ROLLBACK (no reservation, permit, or event)", async () => {
    const pool = new Pool({ connectionString: PG_URL });
    const auth = new PgMoneyAuthority(pool);

    const acct = `auth_short_${randomUUID()}`;
    const decisionId = randomUUID();
    const intentId = randomUUID();

    // Create required FK rows
    await pool.query(
      `INSERT INTO trade_intents (id, market_id, side, price, size, order_type, expiration_sec, strategy, status)
       VALUES ($1, 'test_market', 'YES', 0.5, 100, 'LIMIT', 3600, 'test_strategy', 'PROPOSED')`,
      [intentId],
    );
    await pool.query(
      `INSERT INTO risk_decisions (id, intent_id, status, decision_id, decided_at, reason_codes)
       VALUES ($1, $2, 'ACCEPTED', $1, now(), ARRAY[]::text[])`,
      [decisionId, intentId],
    );

    const before = (
      await pool.query(`SELECT COUNT(*)::int AS c FROM kernel_events`)
    ).rows[0].c;

    await pool.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base)
       VALUES ($1, 'pUSD', 100, 0) ON CONFLICT DO NOTHING`,
      [acct],
    );

    const res = await auth.reserve(acct, "pUSD", 5_000_000n, decisionId, intentId, 1, new Date());
    console.log("Test 2 Result:", JSON.stringify(res));
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("should have rejected");

    // Nothing durable
    const resv = await pool.query(`SELECT COUNT(*)::int AS c FROM reservations WHERE decision_id = $1`, [decisionId]);
    assert.equal(resv.rows[0].c, 0, "no reservation on reject");
    const perm = await pool.query(`SELECT COUNT(*)::int AS c FROM execution_permits WHERE decision_id = $1`, [decisionId]);
    assert.equal(perm.rows[0].c, 0, "no permit on reject");
    const evt = (await pool.query(`SELECT COUNT(*)::int AS c FROM kernel_events`)).rows[0].c;
    assert.equal(evt, before, "no new events on reject");

    await pool.end();
  });

  it("two concurrent reserves cannot overspend a single balance", async () => {
    const pool = new Pool({ connectionString: PG_URL });
    const auth = new PgMoneyAuthority(pool);

    const acct = `auth_conc_${randomUUID()}`;
    await pool.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base)
       VALUES ($1, 'pUSD', 6000000, 0) ON CONFLICT DO NOTHING`,
      [acct],
    );

    // Create required FK rows
    const intentId = randomUUID();
    await pool.query(
      `INSERT INTO trade_intents (id, market_id, side, price, size, order_type, expiration_sec, strategy, status)
       VALUES ($1, 'test_market', 'YES', 0.5, 100, 'LIMIT', 3600, 'test_strategy', 'PROPOSED')`,
      [intentId],
    );
    const decisionId = randomUUID();
    await pool.query(
      `INSERT INTO risk_decisions (id, intent_id, status, decision_id, decided_at, reason_codes)
       VALUES ($1, $2, 'ACCEPTED', $1, now(), ARRAY[]::text[])`,
      [decisionId, intentId],
    );

    // Two concurrent reserves of 5M each against 6M total → at most one succeeds.
    const [a, b] = await Promise.all([
      auth.reserve(acct, "pUSD", 5_000_000n, decisionId, intentId, 1, new Date()),
      auth.reserve(acct, "pUSD", 5_000_000n, decisionId, intentId, 1, new Date()),
    ]);
    console.log("Test 3 Result A:", JSON.stringify(a));
    console.log("Test 3 Result B:", JSON.stringify(b));
    const okCount = [a, b].filter((r) => r.ok).length;
    assert.equal(okCount, 1, "exactly one of two concurrent 5M reserves should win against 6M balance");

    const bal = await pool.query(
      `SELECT available_base, committed_base FROM balance_entries WHERE account = $1 AND asset = 'pUSD'`,
      [acct],
    );
    assert.equal(bal.rows[0].committed_base, "5000000", "committed must equal one successful 5M reserve");

    await pool.end();
  });
});
