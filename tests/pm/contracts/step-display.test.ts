import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStepBlock } from "@polyroot/runtime";

const LONG_ID =
  "34722410608062854697106861099776685947172185964394483545370684749662285977831";

describe("operator step display block", () => {
  it("shows side, percents, edge math and funds on a BUY fill", () => {
    const out = formatStepBlock({
      mode: "MICRO_LIVE",
      marketId: LONG_ID,
      bid: 0.61,
      ask: 0.62,
      p: 0.71,
      rationale: "Order flow favors YES into the close.",
      decision: "BUY",
      reason: undefined,
      edge: 0.042,
      fillPrice: 0.655,
      fillStatus: "FILLED",
      size: 100,
      floorPct: 3,
      funds: { bankrollUsd: 1000, sessionPnlUsd: 2.1 },
    });
    assert.ok(out.includes("[MICRO_LIVE] 34722…77831"), "short market id");
    assert.ok(out.includes("YES 61.0% / NO 62.0%"), "percent book");
    assert.ok(out.includes("AI p(YES)=71.0%"), "percent forecast");
    assert.ok(out.includes("Order flow favors YES"), "rationale shown");
    assert.ok(
      out.includes("✓ BUY 100 @ 0.655 · FILLED · edge +4.2%"),
      "side + fill + edge",
    );
    assert.ok(
      out.includes("bankroll +$1,000.00 · session +$2.10"),
      "money state",
    );
  });

  it("shows abstain + floor comparison on NO_TRADE without funds", () => {
    const out = formatStepBlock({
      mode: "MICRO_LIVE",
      marketId: "mkt-1",
      bid: 0.6,
      ask: 0.61,
      p: null,
      rationale: null,
      decision: "NO_TRADE",
      reason: "forecast uncertain or unavailable",
      edge: -0.015,
      fillPrice: undefined,
      fillStatus: undefined,
      size: undefined,
      floorPct: 3,
      funds: undefined,
    });
    assert.ok(out.includes("AI abstained — no probability"));
    assert.ok(out.includes("⏭ NO_TRADE — forecast uncertain or unavailable"));
    assert.ok(out.includes("−1.5% vs +3.0% floor"));
    assert.ok(!out.includes("bankroll"), "no funds line when absent");
  });

  it("shows null bankroll but keeps the session line", () => {
    const out = formatStepBlock({
      mode: "PAPER",
      marketId: "m",
      bid: 0.45,
      ask: 0.55,
      p: 0.5,
      rationale: null,
      decision: "NO_TRADE",
      reason: "uncertain",
      edge: undefined,
      fillPrice: undefined,
      fillStatus: undefined,
      size: undefined,
      floorPct: undefined,
      funds: { bankrollUsd: null, sessionPnlUsd: 0 },
    });
    assert.ok(out.includes("session $0.00"));
    assert.ok(!out.includes("bankroll"));
  });

  it("falls back to the book price when the fill price is zero", () => {
    const out = formatStepBlock({
      mode: "MICRO_LIVE",
      marketId: "m",
      bid: 0.034,
      ask: 0.035,
      p: 0.035,
      rationale: null,
      decision: "SELL",
      reason: undefined,
      edge: 0.91,
      fillPrice: 0,
      fillStatus: "CANCELLED",
      size: 100,
      floorPct: 3,
      funds: undefined,
    });
    assert.ok(out.includes("✓ SELL 100 @ 0.034 · CANCELLED · edge +91.0%"));
    assert.ok(!out.includes("@ 0 "));
  });

  it("shows locked reservations separately so the bankroll always adds up", () => {
    const out = formatStepBlock({
      mode: "MICRO_LIVE",
      marketId: "m",
      bid: 0.6,
      ask: 0.61,
      p: 0.6,
      rationale: null,
      decision: "NO_TRADE",
      reason: "edge",
      edge: -0.01,
      fillPrice: undefined,
      fillStatus: undefined,
      size: undefined,
      floorPct: 3,
      funds: { bankrollUsd: 996.5, lockedUsd: 3.5, sessionPnlUsd: 0 },
    });
    assert.ok(
      out.includes("bankroll +$996.50 · locked +$3.50 · session $0.00"),
    );
  });
});
