import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { PgCatalystBus } from "@polyroot/intelligence";
import type { CatalystEvent } from "@polyroot/domain";

const pgConfig = {
  user: "postgres",
  host: "localhost",
  database: "polyroot_test",
  password: "postgres",
  port: 5432,
};

describe("CatalystBus Persistence & Watermark (PgCatalystBus)", () => {
  let testClient: Client;

  beforeEach(async () => {
    testClient = new Client(pgConfig);
    await testClient.connect();
    await testClient.query("DROP TABLE IF EXISTS catalyst_watermarks");
    await testClient.query("DROP TABLE IF EXISTS catalyst_outbox");
    await testClient.query(`
      CREATE TABLE catalyst_outbox (
        event_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        event_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (dedupe_key)
      )
    `);
    await testClient.query(`
      CREATE TABLE catalyst_watermarks (
        consumer TEXT PRIMARY KEY,
        last_event_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.query("DROP TABLE IF EXISTS catalyst_watermarks");
      await testClient.query("DROP TABLE IF EXISTS catalyst_outbox");
      await testClient.end();
    }
  });

  it("persists events across restarts; watermark prevents re-execution", async () => {
    const catalystEvent: CatalystEvent = {
      event_id: "evt_persist",
      category: "MARKET",
      subject: "PRICE_SPIKE",
      payload_version: 1,
      event_at: new Date(),
      received_at: new Date(),
      dedupe_key: "dedupe_1",
      payload: { value: 100 },
    };

    const bus1 = new PgCatalystBus(testClient as any);
    await bus1.enqueue(catalystEvent);

    // Simulate restart - new instance
    const bus2 = new PgCatalystBus(testClient as any);
    const replayed = await bus2.replay("consumer_1", "evt_persist");
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].event_id, "evt_persist");

    // Advance watermark
    await bus2.advanceWatermark("consumer_1", "evt_persist");

    // Replay after watermark advancement should not return it
    const replayedAfter = await bus2.replay("consumer_1", "evt_persist");
    assert.equal(replayedAfter.length, 0);
  });
});
