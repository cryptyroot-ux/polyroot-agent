import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceOf,
  formatPassDigest,
  formatMarketReport,
  ReportDedupe,
} from "@polyroot/observability";

describe("stream v2 builders", () => {
  it("confidenceOf derives certainty 2*|p-0.5|", () => {
    assert.ok(Math.abs(confidenceOf(0.67) - 0.34) < 1e-9);
    assert.equal(confidenceOf(0.5), 0);
    assert.equal(confidenceOf(1), 1);
  });

  it("formatPassDigest names evaluated markets with real counts", () => {
    const text = formatPassDigest({
      mode: "SHADOW",
      clock: "10:58:04",
      scanned: 12,
      evaluating: [
        { id: "a", question: "Will Trump leave office in 2026?" },
        { id: "b", question: "Fed cuts rates in September?" },
      ],
      deferredCount: 10,
    });
    assert.ok(text.includes("Scanned 12"));
    assert.ok(text.includes("Will Trump leave office in 2026?"));
    assert.ok(text.includes("10 more deferred"));
    assert.ok(!text.includes("mock"));
  });

  it("formatMarketReport tells decision, why, and money", () => {
    const text = formatMarketReport({
      question: "Will Trump leave office in 2026?",
      bid: 0.52,
      ask: 0.55,
      spread: 0.03,
      pYes: 0.67,
      confidence: 0.34,
      rationale: "CPI down 0.2%.",
      factors: ["inflation data"],
      decision: "NO_TRADE",
      reason: "edge +1.0% below +3.0% floor",
      edgePct: 1.0,
      floorPct: 3.0,
      sizeShares: 0,
      notionalUsd: 0,
      bankrollUsd: 100,
      exposureUsd: 0,
    });
    assert.ok(text.includes("NO_TRADE"));
    assert.ok(text.includes("Why not:"));
    assert.ok(text.includes("At stake: $0"));
    assert.ok(text.includes("52.0"));
  });

  it("ReportDedupe sends once per reason, resends on change", () => {
    const d = new ReportDedupe();
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), true);
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), false);
    assert.equal(d.shouldSend("m1", "NO_TRADE:edge"), true);
    assert.equal(d.shouldSend("m1", "TRADE:submitted"), true);
  });
});
