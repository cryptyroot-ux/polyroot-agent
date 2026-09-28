import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { topOpportunities, formatInsight } from "@polyroot/runtime";

function poolWith(snapRows: Record<string, unknown>[]) {
  return {
    query: async (text: string) => {
      if (/market_snapshots/.test(text)) return { rows: snapRows };
      return { rows: [] };
    },
  };
}

describe("polyroot insight", () => {
  it("scores a high-edge liquid market as BUY and ranks it first", async () => {
    const pool = poolWith([
      {
        market_id: "mkt-hot",
        question: "Will it rain tomorrow?",
        yes_price: 0.5,
        no_price: 0.5,
        spread: 0.01,
        volume_24h: 2000000,
        probability_yes: 0.65,
        confidence: 0.8,
      },
      {
        market_id: "mkt-cold",
        question: "Distant event?",
        yes_price: 0.5,
        no_price: 0.5,
        spread: 0.09,
        volume_24h: 10,
        probability_yes: 0.51,
        confidence: 0.4,
      },
    ]);
    const rows = await topOpportunities(pool, 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.marketId, "mkt-hot");
    assert.equal(rows[0]?.label, "BUY");
    assert.equal(rows[0]?.icon, "🟢");
    assert.equal(rows[0]?.risk, "Low");
    assert.equal(rows[1]?.label, "AVOID");
    const text = formatInsight(rows, false);
    assert.ok(text.includes("BUY"));
    assert.ok(text.includes("🟢"));
    assert.ok(text.includes("Legend"));
    const parsed = JSON.parse(formatInsight(rows, true)) as {
      markets: unknown[];
    };
    assert.equal(parsed.markets.length, 2);
  });

  it("marks markets without a forecast as AVOID (no fabricated edge)", async () => {
    const pool = poolWith([
      {
        market_id: "mkt-nofc",
        question: null,
        yes_price: 0.6,
        no_price: 0.4,
        spread: 0.02,
        volume_24h: 50000,
        probability_yes: null,
        confidence: null,
      },
    ]);
    const rows = await topOpportunities(pool, 10);
    assert.equal(rows[0]?.label, "AVOID");
    assert.equal(rows[0]?.edgePct, null);
    assert.equal(rows[0]?.question, "mkt-nofc");
  });

  it("reports gracefully when no snapshots exist", async () => {
    const rows = await topOpportunities(poolWith([]), 10);
    assert.deepEqual(rows, []);
    const text = formatInsight(rows, false);
    assert.ok(text.includes("No market snapshots yet"));
    assert.ok(text.includes("polyroot run --once"));
  });
});
