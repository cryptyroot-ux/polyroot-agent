import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from 'pg';
import { PgSourceRegistry } from "@polyroot/intelligence";

const pgConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'polyroot_test',
  password: 'postgres',
  port: 5432,
};

describe('SourceRegistry Persistence (PgSourceRegistry)', () => {
  let testClient: Client;
  let registry: PgSourceRegistry;

  beforeEach(async () => {
    testClient = new Client(pgConfig);
    await testClient.connect();
    await testClient.query('DROP TABLE IF EXISTS source_records');
    await testClient.query(`
      CREATE TABLE source_records (
        source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url TEXT NOT NULL,
        epistemic_class TEXT NOT NULL CHECK (epistemic_class IN ('PRIMARY','SECONDARY','AGGREGATOR','UNKNOWN')),
        domain TEXT NOT NULL,
        source_class TEXT NOT NULL CHECK (source_class IN ('FUNDAMENTAL','MARKET','PARTICIPANT','STRUCTURAL','ALTERNATIVE','CROSS_MARKET')),
        reliability_score NUMERIC(5,4) NOT NULL CHECK (reliability_score >= 0 AND reliability_score <= 1),
        reliability_sample_count INTEGER NOT NULL DEFAULT 0,
        reliability_window TEXT NOT NULL DEFAULT '90d',
        correction_history JSONB NOT NULL DEFAULT '[]',
        syndication_parent TEXT,
        latency_sec NUMERIC(10,3),
        specialization TEXT,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (url)
      )
    `);
    
    registry = new PgSourceRegistry(testClient as any); 
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.query('DROP TABLE IF EXISTS source_records');
      await testClient.end();
    }
  });

  it("persists sources across restarts", async () => {
    const sourceRecord = {
      source_id: '00000000-0000-0000-0000-000000000000',
      url: "https://new.example.com",
      epistemic_class: "PRIMARY" as const,
      domain: "example.com",
      source_class: "FUNDAMENTAL" as const,
      reliability: {
        score: 0.95,
        sample_count: 42,
        window: "90d"
      },
      correction_history: [],
      syndication_parent: null,
      registered_at: new Date()
    };

    await registry.register(sourceRecord);

    const reg2 = new PgSourceRegistry(testClient as any);
    const families = await reg2.independentFamilies(["https://new.example.com"]);
    assert.strictEqual(families.size, 1);
  });
});