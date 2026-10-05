import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLoopInputs } from "@polyroot/runtime";

describe("explicit market universe", () => {
  it("MICRO_LIVE loops require a wired marketSource", async () => {
    // MICRO_LIVE without a marketSource throws LIVE_LOOP_UNWIRED
    await assert.rejects(
      buildLoopInputs({ mode: "MICRO_LIVE" }, {}),
      /LIVE_LOOP_UNWIRED/,
    );
  });

  it("MICRO_LIVE loops apply when marketSource is wired", async () => {
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
    const inputs = await buildLoopInputs(
      { mode: "MICRO_LIVE" },
      {
        marketSource: {
          universe: () => ["111", "222", "333"],
          snapshot: async (id: string) => {
            if (id === "111") return { bid: 0.4, ask: 0.6 };
            if (id === "222") return null;
            return { bid: Number.NaN, ask: 0.5 };
          },
        },
      },
    );
    assert.deepEqual(inputs, [{ market_id: "111", bid: 0.4, ask: 0.6 }]);
  });
});
