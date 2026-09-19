/**
 * @polyroot/ledger — Projection Engine Tests (PM-LED-03).
 *
 * Verifies that deleting projections and rebuilding from events
 * produces identical balances (exact replay).
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PgEventStore, PgProjectionEngine } from "@polyroot/ledger";
import { PgBalanceStore } from "@polyroot/risk";
import { createPgStores } from "@polyroot/risk";

/**
 * Test requires a PostgreSQL connection.
 * Set DATABASE_URL or pass via env.
 */
const pgConfig = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polyroot_test";

function ev(type: any, payload: any, over: Record<string, unknown> = {}) {
  return {
    schema_version: "1.1",
    id: randomUUID(),
    type,
    aggregate_type: "Reservation",
    aggregate_id: randomUUID(),
    payload,
    metadata: {},
    timestamp: new Date(),
    ...over,
  };
}

describe("ProjectionEngine — rebuild from events (PM-LED-03)", () => {
  let pool: Pool;
  let eventStore: PgEventStore;
  let projectionEngine: PgProjectionEngine;
  let balanceStore: PgBalanceStore;

  before(async () => {
    pool = new Pool({ connectionString: pgConfig });
    // Ensure clean schema
    await pool.query(`TRUNCATE kernel_events, balance_entries, balance_projections, projection_checkpoints CASCADE`);

    const stores = createPgStores(pgConfig);
    eventStore = new PgEventStore(pool);
    projectionEngine = new PgProjectionEngine(pgConfig, eventStore);
    balanceStore = stores.balanceStore;
  });

  after(async () => {
    await pool.end();
  });

  it("rebuild produces identical balances to incremental process", async () => {
    const account = "0xTEST_ACCOUNT";
    const asset = "pUSD";

    const events = [
      ev("RESERVATION_CREATED", { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }),
      ev("RESERVATION_CREATED", { account, asset, cashBase: "500000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }),
      ev("RESERVATION_CONSUMED", { account, asset, cashBase: "300000" }),
      ev("RESERVATION_RELEASED", { account, asset, cashBase: "200000" }),
      ev("ORDER_FILLED", { account, asset, cashBase: "400000", feeBase: "10000", rebateBase: "5000" }),
    ];

    for (const e of events) {
      await eventStore.append(e as any);
    }

    // Incremental process (simulating live)
    await projectionEngine.process({ projectionName: "balance_projections", fromSequence: 1n });
    const balAfterIncremental = await balanceStore.get(account, asset);

    // TRUNCATE projections and REBUILD from scratch
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const balAfterRebuild = await balanceStore.get(account, asset);

    // Expect exact match
    assert.equal(balAfterRebuild.availableBase, balAfterIncremental.availableBase);
    assert.equal(balAfterRebuild.committedBase, balAfterIncremental.committedBase);
    // available = +200000 (released) + Rebate... 
    // For exact expectation, assert equality between the two methods is the key
  });

  it("rebuild is idempotent: running twice produces same result", async () => {
    const account = "0xIDEMPOTENT_ACCOUNT";
    const asset = "pUSD";

    const events = [
      ev("RESERVATION_CREATED", { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }),
    ];
    for (const e of events) {
      await eventStore.append(e as any);
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal1 = await balanceStore.get(account, asset);

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal2 = await balanceStore.get(account, asset);

    assert.equal(bal2.availableBase, bal1.availableBase);
    assert.equal(bal2.committedBase, bal1.committedBase);
  });

  it("rebuild handles CORRECTION events correctly", async () => {
    const account = "0xCORRECTION_ACCOUNT";
    const asset = "pUSD";

    const events = [
      ev("RESERVATION_CREATED", { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }),
      ev("CORRECTION", {
        correctionOfEventId: "00000000-0000-0000-0000-000000000001",
        reversalType: "RESERVATION_RELEASED",
        reversal: { account, asset, cashBase: "1000000" },
      }, { metadata: { corrected: true } }),
    ];
    for (const e of events) {
      await eventStore.append(e as any);
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal = await balanceStore.get(account, asset);
    // Correction reverses the reservation → net zero
    assert.equal(bal.availableBase, 0n);
    assert.equal(bal.committedBase, 0n);
  });

  it("rebuild handles multiple accounts and assets independently", async () => {
    const scenarios = [
      { account: "0xMULTI_1", asset: "pUSD", events: [ev("RESERVATION_CREATED", { account: "0xMULTI_1", asset: "pUSD", cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 })] },
      { account: "0xMULTI_2", asset: "pUSD", events: [ev("RESERVATION_CREATED", { account: "0xMULTI_2", asset: "pUSD", cashBase: "2000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 })] },
      { account: "0xMULTI_1", asset: "USDC", events: [ev("RESERVATION_CREATED", { account: "0xMULTI_1", asset: "USDC", cashBase: "500000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 })] },
    ];
    for (const s of scenarios) {
      for (const e of s.events) {
        await eventStore.append(e as any);
      }
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });

    const bal1 = await balanceStore.get("0xMULTI_1", "pUSD");
    assert.equal(bal1.availableBase, -1000000n);
    assert.equal(bal1.committedBase, 1000000n);

    const bal2 = await balanceStore.get("0xMULTI_2", "pUSD");
    assert.equal(bal2.availableBase, -2000000n);
    assert.equal(bal2.committedBase, 2000000n);

    const bal3 = await balanceStore.get("0xMULTI_1", "USDC");
    assert.equal(bal3.availableBase, -500000n);
    assert.equal(bal3.committedBase, 500000n);
  });

  // Property: replay identical event stream produces identical balances/PnL with no duplicate economic effect
  it("property: identical replay produces identical state (PM-LED-01)", async () => {
    const account = "0xPROP_ACCOUNT";
    const asset = "pUSD";

    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push(ev(i % 2 === 0 ? "RESERVATION_CREATED" : "RESERVATION_RELEASED", { account, asset, cashBase: (100000 * (i + 1)).toString(), intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }));
    }
    for (const e of events) {
      await eventStore.append(e as any);
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal1 = await balanceStore.get(account, asset);

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal2 = await balanceStore.get(account, asset);

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal3 = await balanceStore.get(account, asset);

    assert.equal(bal2.availableBase, bal1.availableBase);
    assert.equal(bal2.committedBase, bal1.committedBase);
    assert.equal(bal3.availableBase, bal1.availableBase);
    assert.equal(bal3.committedBase, bal1.committedBase);
  });

  it("append rejects events lacking schema_version (PM-LED-01 canonical schema)", async () => {
    const bad = { type: "RESERVATION_CREATED", aggregate_type: "Reservation", aggregate_id: randomUUID(), payload: {}, metadata: {} };
    await assert.rejects(() => eventStore.append(bad as any), /invalid LedgerEvent/i);
  });
});