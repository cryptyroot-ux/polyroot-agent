/**
 * @polyroot/ledger — Projection Engine Tests (PM-LED-03).
 *
 * Verifies that deleting projections and rebuilding from events
 * produces identical balances (exact replay).
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool } from "pg";
import { PgEventStore } from "@polyroot/ledger";
import { PgProjectionEngine } from "@polyroot/ledger";
import { PgBalanceStore } from "@polyroot/risk";
import { createPgStores } from "@polyroot/risk";

/**
 * Test requires a PostgreSQL connection.
 * Set DATABASE_URL or pass via env.
 */
const pgConfig = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polyroot_test";

describe("ProjectionEngine — rebuild from events (PM-LED-03)", () => {
  let pool: Pool;
  let eventStore: PgEventStore;
  let projectionEngine: PgProjectionEngine;
  let balanceStore: PgBalanceStore;

  before(async () => {
    pool = new Pool({ connectionString: pgConfig });
    // Ensure clean schema
    await pool.query(`TRUNCATE kernel_events, balance_entries, balance_projections, projection_checkpoints CASCADE`);
    await pool.query(`DELETE FROM kernel_events`);
    await pool.query(`DELETE FROM balance_entries`);
    await pool.query(`DELETE FROM balance_projections`);
    await pool.query(`DELETE FROM projection_checkpoints`);

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

    // Insert test events simulating a real session
    const events = [
      {
        type: "RESERVATION_CREATED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 },
        metadata: {},
      },
      {
        type: "RESERVATION_CREATED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "500000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 },
        metadata: {},
      },
      {
        type: "RESERVATION_CONSUMED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "300000" },
        metadata: {},
      },
      {
        type: "RESERVATION_RELEASED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "200000" },
        metadata: {},
      },
      {
        type: "ORDER_FILLED",
        aggregate_type: "orders",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "400000", feeBase: "10000", rebateBase: "5000" },
        metadata: {},
      },
    ];

    // Insert events via event store
    for (const evt of events) {
      await eventStore.append({
        ...evt,
        timestamp: new Date(),
      } as any);
    }

    // Run incremental process (simulating live projection)
    await projectionEngine.process({
      projectionName: "balance_projections",
      fromSequence: 1n,
    });

    // Get balances after incremental process
    const balAfterIncremental = await balanceStore.get(account, asset);
    console.log("After incremental:", balAfterIncremental);

    // Now TRUNCATE projections and REBUILD from scratch
    await projectionEngine.rebuild({
      projectionName: "balance_projections",
      fromSequence: 1n,
    });

    // Get balances after rebuild
    const balAfterRebuild = await balanceStore.get(account, asset);
    console.log("After rebuild:", balAfterRebuild);

    // Verify exact match
    assert.equal(balAfterRebuild.availableBase, balAfterIncremental.availableBase);
    assert.equal(balAfterRebuild.committedBase, balAfterIncremental.committedBase);
  });

  it("rebuild is idempotent: running twice produces same result", async () => {
    const account = "0xIDEMPOTENT_ACCOUNT";
    const asset = "pUSD";

    const events = [
      {
        type: "RESERVATION_CREATED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 },
        metadata: {},
      },
    ];

    for (const evt of events) {
      await eventStore.append({ ...evt, timestamp: new Date() } as any);
    }

    // First rebuild
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal1 = await balanceStore.get(account, asset);

    // Second rebuild (should be idempotent)
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal2 = await balanceStore.get(account, asset);

    assert.equal(bal2.availableBase, bal1.availableBase);
    assert.equal(bal2.committedBase, bal1.committedBase);
  });

  it("rebuild handles CORRECTION events correctly", async () => {
    const account = "0xCORRECTION_ACCOUNT";
    const asset = "pUSD";

    const events = [
      {
        type: "RESERVATION_CREATED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 },
        metadata: {},
      },
      // Correction reverses the reservation
      {
        type: "CORRECTION",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: {
          correctionOfEventId: "00000000-0000-0000-0000-000000000000",
          reversalType: "RESERVATION_RELEASED",
          reversal: { account, asset, cashBase: "1000000" },
        },
        metadata: { corrected: true },
      },
    ];

    for (const evt of events) {
      await eventStore.append({ ...evt, timestamp: new Date() } as any);
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });

    const bal = await balanceStore.get(account, asset);
    // After correction, net should be zero
    assert.equal(bal.availableBase, 0n);
    assert.equal(bal.committedBase, 0n);
  });

  it("rebuild handles multiple accounts and assets independently", async () => {
    const scenarios = [
      { account: "0xMULTI_1", asset: "pUSD", events: [{ type: "RESERVATION_CREATED", aggregate_type: "execution_permits", aggregate_id: randomUUID(), payload: { account: "0xMULTI_1", asset: "pUSD", cashBase: "1000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }, metadata: {} }] },
      { account: "0xMULTI_2", asset: "pUSD", events: [{ type: "RESERVATION_CREATED", aggregate_type: "execution_permits", aggregate_id: randomUUID(), payload: { account: "0xMULTI_2", asset: "pUSD", cashBase: "2000000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }, metadata: {} }] },
      { account: "0xMULTI_1", asset: "USDC", events: [{ type: "RESERVATION_CREATED", aggregate_type: "execution_permits", aggregate_id: randomUUID(), payload: { account: "0xMULTI_1", asset: "USDC", cashBase: "500000", intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 }, metadata: {} }] },
    ];

    for (const s of scenarios) {
      for (const evt of s.events) {
        await eventStore.append({ ...evt, timestamp: new Date() } as any);
      }
    }

    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });

    // Check each account/asset pair
    const bal1 = await balanceStore.get("0xMULTI_1", "pUSD");
    assert.equal(bal1.availableBase, 0n); // reserved
    assert.equal(bal1.committedBase, 1000000n);

    const bal2 = await balanceStore.get("0xMULTI_2", "pUSD");
    assert.equal(bal2.availableBase, 0n);
    assert.equal(bal2.committedBase, 2000000n);

    const bal3 = await balanceStore.get("0xMULTI_1", "USDC");
    assert.equal(bal3.availableBase, 0n);
    assert.equal(bal3.committedBase, 500000n);
  });

  // Property: replay identical event stream produces identical balances/PnL with no duplicate economic effect
  it("property: identical replay produces identical state (PM-LED-01)", async () => {
    const account = "0xPROP_ACCOUNT";
    const asset = "pUSD";

    // Create a deterministic sequence of events
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        type: i % 2 === 0 ? "RESERVATION_CREATED" : "RESERVATION_RELEASED",
        aggregate_type: "execution_permits",
        aggregate_id: randomUUID(),
        payload: { account, asset, cashBase: (100000 * (i + 1)).toString(), intentId: randomUUID(), reservationId: randomUUID(), permitId: randomUUID(), leaseEpoch: 1 },
        metadata: {},
      });
    }

    for (const evt of events) {
      await eventStore.append({ ...evt, timestamp: new Date() } as any);
    }

    // First replay
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal1 = await balanceStore.get(account, asset);

    // Second replay (identical stream)
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal2 = await balanceStore.get(account, asset);

    // Third replay
    await projectionEngine.rebuild({ projectionName: "balance_projections", fromSequence: 1n });
    const bal3 = await balanceStore.get(account, asset);

    assert.equal(bal2.availableBase, bal1.availableBase);
    assert.equal(bal2.committedBase, bal1.committedBase);
    assert.equal(bal3.availableBase, bal1.availableBase);
    assert.equal(bal3.committedBase, bal1.committedBase);
  });
});

function randomUUID(): string {
  // Simple UUID v4 generator for tests
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}