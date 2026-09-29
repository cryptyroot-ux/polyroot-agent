import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import {
  parseResolvedMarkets,
  toResolvedCluster,
  recordResolvedClusters,
  fetchClosedEvents,
} from "@polyroot/venue";
import { PgCalibrationService } from "../../../src/pm/intelligence/src/calibration";
import { startResolutionSync } from "@polyroot/runtime";

const NOW = Date.parse("2026-09-01T00:00:00Z");

function gammaEvent(over: Record<string, unknown> = {}) {
  return {
    id: "ev1",
    markets: [
      {
        id: "m1",
        question: "Will X?",
        slug: "will-x",
        closed: true,
        clobTokenIds: '["tokYES","tokNO"]',
        outcomePrices: '["0.999999", "0.000001"]',
        closedTime: "2026-08-01T00:00:00Z",
        endDate: "2026-08-01T00:00:00Z",
      },
    ],
    ...over,
  };
}

describe("resolution recorder (pure)", () => {
  it("parses decided markets, winner = price side above 0.5", () => {
    const out = parseResolvedMarkets([gammaEvent()], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.winningTokenId, "tokYES");
    assert.equal(out[0]?.eventId, "ev1");
    assert.equal(out[0]?.resolvedAtMs, Date.parse("2026-08-01T00:00:00Z"));
  });

  it("skips split, missing and undecided markets (never guesses)", () => {
    const split = gammaEvent({
      markets: [
        {
          id: "m2",
          question: "Split?",
          closed: true,
          clobTokenIds: '["a","b"]',
          outcomePrices: '["0.5", "0.5"]',
        },
      ],
    });
    assert.equal(parseResolvedMarkets([split], NOW).length, 0);
    const missing = gammaEvent({
      markets: [{ id: "m3", question: "No prices?", closed: true }],
    });
    assert.equal(parseResolvedMarkets([missing], NOW).length, 0);
    const open = gammaEvent({
      markets: [
        {
          id: "m4",
          question: "Open?",
          closed: false,
          clobTokenIds: '["a","b"]',
          outcomePrices: '["0.99", "0.01"]',
        },
      ],
    });
    assert.equal(parseResolvedMarkets([open], NOW).length, 0);
    assert.deepEqual(parseResolvedMarkets("garbage", NOW), []);
  });

  it("clusters are stable, content-addressed, and distinct per market", () => {
    const [m] = parseResolvedMarkets([gammaEvent()], NOW);
    assert.ok(m);
    const c1 = toResolvedCluster(m);
    const c2 = toResolvedCluster(m);
    assert.equal(c1.clusterHash, c2.clusterHash);
    assert.equal(c1.clusterId, "market:m1");
    assert.deepEqual(c1.marketIds, ["tokYES", "tokNO"]);
    assert.equal(c1.resolutionOutcome, "tokYES");
    assert.equal(c1.isIndependent, true);
    const other = toResolvedCluster({ ...m, winningTokenId: "tokNO" });
    assert.notEqual(other.clusterHash, c1.clusterHash);
  });

  it("fetchClosedEvents drops ancient closures (trainer would starve)", async () => {
    const origFetch = globalThis.fetch;
    const ancient = gammaEvent({
      id: "ev-old",
      closedTime: "2021-12-05T00:00:00Z",
      markets: [
        {
          id: "m-old",
          question: "Old?",
          closed: true,
          clobTokenIds: '["oa","ob"]',
          outcomePrices: '["0.99", "0.01"]',
          closedTime: "2021-12-05T00:00:00Z",
        },
      ],
    });
    const fresh = gammaEvent({
      id: "ev-new",
      closedTime: new Date(Date.now() - 24 * 3600_000).toISOString(),
      markets: [
        {
          id: "m-new",
          question: "New?",
          closed: true,
          clobTokenIds: '["na","nb"]',
          outcomePrices: '["0.01", "0.99"]',
          closedTime: new Date(Date.now() - 24 * 3600_000).toISOString(),
        },
      ],
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([ancient, fresh]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as never;
    try {
      const data = await fetchClosedEvents(50, 15_000, 30);
      assert.equal(data.length, 1);
      const decided = parseResolvedMarkets(data, NOW);
      assert.equal(decided.length, 1);
      assert.equal(decided[0]?.eventId, "ev-new");
      assert.equal(decided[0]?.winningTokenId, "nb");
      const unfiltered = await fetchClosedEvents(50, 15_000, 0);
      assert.equal(unfiltered.length, 2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

const pgConfig = {
  user: "postgres",
  host: "localhost",
  database: "postgres",
  password: "postgres",
  port: 5432,
};

describe("resolution recording + calibration training (PG)", () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client(pgConfig);
    await client.connect();
    await client.query("DROP TABLE IF EXISTS calibration_models");
    await client.query("DROP TABLE IF EXISTS forecasts");
    await client.query("DROP TABLE IF EXISTS resolved_clusters");
    await client.query(`
      CREATE TABLE calibration_models (
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        category TEXT NOT NULL,
        horizon_sec INTEGER NOT NULL,
        regime TEXT,
        isotonic_map JSONB NOT NULL,
        sample_count INTEGER NOT NULL,
        last_trained TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (model_provider, model_name, category, horizon_sec, regime)
      )`);
    await client.query(`
      CREATE TABLE forecasts (
        market_id TEXT NOT NULL,
        horizon_sec INTEGER NOT NULL,
        probability_yes NUMERIC NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`
      CREATE TABLE resolved_clusters (
        cluster_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        market_ids TEXT[] NOT NULL,
        resolution_outcome TEXT NOT NULL,
        resolved_at TIMESTAMPTZ NOT NULL,
        is_independent BOOLEAN NOT NULL DEFAULT TRUE,
        cluster_hash TEXT NOT NULL,
        UNIQUE (cluster_hash)
      )`);
  });

  afterEach(async () => {
    await client.query("DROP TABLE IF EXISTS calibration_models");
    await client.query("DROP TABLE IF EXISTS forecasts");
    await client.query("DROP TABLE IF EXISTS resolved_clusters");
    await client.end();
  });

  it("record is idempotent; training learns winners from resolutions", async () => {
    const [m] = parseResolvedMarkets([gammaEvent()], NOW);
    assert.ok(m);
    const row = toResolvedCluster(m);
    const n1 = await recordResolvedClusters(client as never, [row]);
    const n2 = await recordResolvedClusters(client as never, [row]);
    assert.equal(n1, 1);
    assert.equal(n2, 0);

    // 12 forecasts on the winning token (p ~0.7), 12 on the loser (p ~0.3).
    for (let i = 0; i < 12; i++) {
      await client.query(
        `INSERT INTO forecasts (market_id, horizon_sec, probability_yes, model, created_at)
         VALUES ('tokYES', 3600, 0.65, 'm1', '2026-07-01T00:00:00Z')`,
      );
      await client.query(
        `INSERT INTO forecasts (market_id, horizon_sec, probability_yes, model, created_at)
         VALUES ('tokNO', 3600, 0.35, 'm1', '2026-07-01T00:00:00Z')`,
      );
    }
    const cal = new PgCalibrationService(client as never);
    const summary = await cal.trainFromResolvedClusters();
    assert.equal(summary.groupsTrained, 1);
    assert.equal(summary.samplesTotal, 24);
    // Learned map: winners calibrate up, losers down.
    const up = await cal.calibrate({
      p_raw: 0.7,
      model: "m1",
      category: "general",
      horizon_sec: 3600,
    });
    const down = await cal.calibrate({
      p_raw: 0.3,
      model: "m1",
      category: "general",
      horizon_sec: 3600,
    });
    assert.ok(up.p_calibrated > 0.7);
    assert.ok(down.p_calibrated < 0.3);
  });
});

describe("resolution sync scheduler", () => {
  it("tick records + trains; errors stay fail-open; stop halts", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        if (text.startsWith("INSERT INTO resolved_clusters")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("FROM forecasts")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    let trained = 0;
    const calibration = {
      trainFromResolvedClusters: async () => {
        trained += 1;
        return { groupsTrained: 0, samplesTotal: 0 };
      },
    };
    const seen: string[] = [];
    const handle = startResolutionSync({
      pool: pool as never,
      calibration: calibration as never,
      fetchClosed: async () => [gammaEvent()],
      intervalMs: 40,
      onTick: (s) => seen.push(`tick:${s.decidedMarkets}/${s.recordedNew}`),
    });
    const first = await handle.tick();
    assert.equal(first.decidedMarkets, 1);
    assert.equal(first.recordedNew, 1);
    assert.equal(trained, 1);
    handle.stop();
    const ticksBefore = seen.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, ticksBefore);
  });

  it("fetch failure yields empty summary + onError (never throws)", async () => {
    let errMsg = "";
    const handle = startResolutionSync({
      pool: { query: async () => ({ rows: [] }) } as never,
      calibration: {
        trainFromResolvedClusters: async () => ({
          groupsTrained: 0,
          samplesTotal: 0,
        }),
      } as never,
      fetchClosed: async () => {
        throw new Error("gamma down");
      },
      onError: (e) => {
        errMsg = e.message;
      },
    });
    const s = await handle.tick();
    assert.deepEqual(s, {
      decidedMarkets: 0,
      recordedNew: 0,
      calibrationGroups: 0,
      calibrationSamples: 0,
    });
    assert.ok(errMsg.includes("gamma down"));
    handle.stop();
  });
});
