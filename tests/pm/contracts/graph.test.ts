import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool } from "pg";
import { createPgGraphEdgeStore, GraphBuilder } from "@polyroot/data";

const pgConfig =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/polyroot_test";

describe("Market/Event Graph", () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: pgConfig });
    // Cleanup graph edges before test
    await pool.query(`TRUNCATE graph_edges CASCADE`);
  });

  after(async () => {
    await pool.end();
  });

  it("creates NATIVE_NEG_RISK edges from Polymarket event grouping", async () => {
    const store = createPgGraphEdgeStore(pool);
    const builder = new GraphBuilder(store);

    const markets = [
      {
        market_id: "mkt_A",
        event_id: "evt_1",
        condition_id: "cond_1",
        question: "Will X happen?",
        outcome: "YES",
        is_neg_risk: true,
      },
      {
        market_id: "mkt_B",
        event_id: "evt_1",
        condition_id: "cond_1",
        question: "Will X not happen?",
        outcome: "NO",
        is_neg_risk: true,
      },
    ];

    // @ts-ignore - MarketSnapshot interface mock
    await builder.buildNativeEdges(markets);

    const edges = await store.getEdgesByMarket("mkt_A");
    const negRisk = edges.find((e) => e.relation_type === "NATIVE_NEG_RISK");
    assert.ok(negRisk);
    assert.equal(negRisk.trust_level, "VERIFIED_PLATFORM");
    assert.equal(negRisk.to_market_id, "mkt_B");
  });
});
