import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectLiveInputs } from "@polyroot/venue";

describe("loop inputs carry question + volume24h when present", () => {
  it("copies question/volume from snapshot; omits them when absent", async () => {
    const inputs = await collectLiveInputs({
      universe: () => ["mkt-with-meta", "mkt-bare"],
      snapshot: async (id: string) => {
        if (id === "mkt-with-meta")
          return {
            bid: 0.52,
            ask: 0.55,
            question: "Will Trump leave office in 2026?",
            volume24h: 1200000,
          };
        return { bid: 0.45, ask: 0.55 };
      },
    });
    assert.equal(inputs.length, 2);
    const rich = inputs.find((i) => i.market_id === "mkt-with-meta");
    assert.equal(rich?.question, "Will Trump leave office in 2026?");
    assert.equal(rich?.volume24h, 1200000);
    const bare = inputs.find((i) => i.market_id === "mkt-bare");
    assert.ok(!("question" in (bare as object)));
    assert.ok(!("volume24h" in (bare as object)));
  });
});
