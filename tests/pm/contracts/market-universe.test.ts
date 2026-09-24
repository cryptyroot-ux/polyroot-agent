import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectLiveInputs, readMarketUniverse } from "@polyroot/venue";
import { buildLoopInputs } from "@polyroot/runtime";

describe("explicit market universe", () => {
  it("refuses an empty universe", () => {
    assert.throws(() => readMarketUniverse({}), /MARKET_UNIVERSE_MISSING/);
    assert.throws(
      () => readMarketUniverse({ POLYROOT_MARKET_IDS: "  , " }),
      /MARKET_UNIVERSE_MISSING/,
    );
  });

  it("refuses non-asset ids and dedupes valid ones", () => {
    assert.throws(
      () => readMarketUniverse({ POLYROOT_MARKET_IDS: "123,mkt_abc,0xdef" }),
      /MARKET_UNIVERSE_INVALID.*mkt_abc/,
    );
    assert.deepEqual(
      readMarketUniverse({ POLYROOT_MARKET_IDS: "123, 0xabc,123" }),
      ["123", "0xabc"],
    );
  });

  it("PAPER loops keep the mock fixture; live loops refuse without a source", async () => {
    const paper = await buildLoopInputs({ mode: "PAPER" }, {});
    assert.deepEqual(paper, [
      { market_id: "mock_market_1", bid: 0.45, ask: 0.55 },
    ]);
    await assert.rejects(
      buildLoopInputs({ mode: "SHADOW" }, {}),
      /LIVE_LOOP_UNWIRED/,
    );
    const live = await buildLoopInputs(
      { mode: "MICRO_LIVE" },
      {
        marketSource: {
          universe: () => ["777"],
          snapshot: async () => ({ bid: 0.3, ask: 0.7 }),
        },
      },
    );
    assert.deepEqual(live, [{ market_id: "777", bid: 0.3, ask: 0.7 }]);
  });

  it("collects live inputs and skips priceless markets", async () => {
    const inputs = await collectLiveInputs({
      universe: () => ["111", "222", "333"],
      snapshot: async (id: string) => {
        if (id === "111") return { bid: 0.4, ask: 0.6 };
        if (id === "222") return null;
        return { bid: Number.NaN, ask: 0.5 };
      },
    });
    assert.deepEqual(inputs, [{ market_id: "111", bid: 0.4, ask: 0.6 }]);
  });
});
