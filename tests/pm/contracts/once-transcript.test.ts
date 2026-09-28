import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatOnceTranscript } from "@polyroot/runtime";

const INPUT = { market_id: "mock_market_1", bid: 0.45, ask: 0.55 };

describe("polyroot run --once transcript", () => {
  it("renders book + abstain + NO_TRADE verdict when p is null", async () => {
    const out = formatOnceTranscript(INPUT, {
      market_id: "mock_market_1",
      decision: "NO_TRADE",
      reason: "forecast uncertain or unavailable",
      p: null,
      size: undefined,
      edge: undefined,
      fill: undefined,
    });
    assert.ok(out.includes("book  YES 0.45 / NO 0.55 · spread 0.1"));
    assert.ok(out.includes("AI forecast  abstained"));
    assert.ok(out.includes("⏭ NO_TRADE — forecast uncertain or unavailable"));
  });

  it("renders p, BUY line with signed edge when a trade fires", async () => {
    const out = formatOnceTranscript(
      { market_id: "m", bid: 0.61, ask: 0.62 },
      {
        market_id: "m",
        decision: "BUY",
        reason: undefined,
        p: 0.71,
        size: 100,
        edge: 0.042,
        fill: { fillPrice: 0.655 },
      },
    );
    assert.ok(out.includes("AI forecast  p(YES) = 0.71"));
    assert.ok(out.includes("✓ BUY 100 @ 0.655 · edge +4.2%"));
  });

  it("shows negative edge with minus sign and falls back to ask price", async () => {
    const out = formatOnceTranscript(
      { market_id: "m", bid: 0.6, ask: 0.62 },
      {
        market_id: "m",
        decision: "SELL",
        reason: "x",
        p: 0.4,
        size: 50,
        edge: -0.016,
        fill: undefined,
      },
    );
    assert.ok(out.includes("edge -1.6%"));
    assert.ok(out.includes("SELL 50 @ 0.6"));
  });
});
