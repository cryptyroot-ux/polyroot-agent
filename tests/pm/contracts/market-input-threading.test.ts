import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectLiveInputs } from "@polyroot/venue";
import { resolveDisplayQuestion } from "@polyroot/runtime";

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

describe("resolveDisplayQuestion prefers discovery text over echoed ids", () => {
  it("discovery text wins; echoed token id is rejected; empties yield undefined", () => {
    const id =
      "87073899845581463485186346288398658568334162612963837182986759797304993556208";
    assert.equal(
      resolveDisplayQuestion(id, id, "Putin out as President of Russia?"),
      "Putin out as President of Russia?",
    );
    assert.equal(
      resolveDisplayQuestion(id, "A real book question?", undefined),
      "A real book question?",
    );
    assert.equal(resolveDisplayQuestion(id, id, undefined), undefined);
    assert.equal(resolveDisplayQuestion(id, "", ""), undefined);
  });
});
