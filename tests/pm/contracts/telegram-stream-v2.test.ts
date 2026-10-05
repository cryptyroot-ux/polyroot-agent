import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceOf,
  formatPassDigest,
  formatMarketReport,
  formatBatchedDigest,
  formatTradeAlert,
  formatRiskGateAlert,
  DigestThrottle,
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
      mode: "MICRO_LIVE",
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
    assert.ok(text.includes("NO TRADE"));
    assert.ok(text.includes("edge +1.0%"));
    assert.ok(text.includes("At stake:"));
    assert.ok(text.includes("52.0"));
  });

  it("formatMarketReport renders unknown funds as em-dash, never $0", () => {
    const text = formatMarketReport({
      question: "Fed cuts rates in September?",
      bid: 0.6,
      ask: 0.62,
      spread: 0.02,
      pYes: 0.8,
      confidence: 0.6,
      rationale: "Strong consensus.",
      factors: [],
      decision: "TRADE",
      reason: "edge above floor",
      edgePct: 15.0,
      floorPct: 3.0,
      sizeShares: 12,
      notionalUsd: 6.6,
      bankrollUsd: null,
      exposureUsd: null,
    });
    assert.ok(text.includes("TRADE"));
    assert.ok(text.includes("Bankroll: —"));
    assert.ok(!text.includes("Bankroll $0"));
  });

  it("digest and report tag YES/NO sides so duplicate names disambiguate", () => {
    const digest = formatPassDigest({
      mode: "MICRO_LIVE",
      clock: "10:58:04",
      scanned: 4,
      evaluating: [
        { id: "yes-id", question: "Putin", side: "YES" },
        { id: "no-id", question: "Putin", side: "NO" },
      ],
      deferredCount: 1,
    });
    assert.ok(digest.includes("Putin [YES]"));
    assert.ok(digest.includes("Putin [NO]"));
    const report = formatMarketReport({
      question: "Putin",
      side: "NO",
      bid: 0.972,
      ask: 0.973,
      spread: 0.001,
      pYes: 0.028,
      confidence: 0.944,
      rationale: "Tight spread.",
      factors: [],
      decision: "NO_TRADE",
      reason: "edge below floor",
      edgePct: -1,
      floorPct: 3,
      sizeShares: 0,
      notionalUsd: 0,
      bankrollUsd: 100,
      exposureUsd: 0,
    });
    assert.ok(report.includes("Putin [NO]"));
  });

  it("ReportDedupe sends once per reason, resends on change", () => {
    const d = new ReportDedupe();
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), true);
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), false);
    assert.equal(d.shouldSend("m1", "NO_TRADE:edge"), true);
    assert.equal(d.shouldSend("m1", "TRADE:submitted"), true);
  });
});

describe("batched digest + instant alerts", () => {
  it("formatBatchedDigest shows counts, markets, and portfolio once", () => {
    const text = formatBatchedDigest({
      clock: "14:30:00",
      mode: "MICRO_LIVE",
      scanned: 12,
      gatesPassed: 2,
      trades: 0,
      evaluated: [
        {
          question: "Bitcoin >$100k 2026",
          side: "YES",
          edgePct: 1.2,
          floorPct: 1.0,
        },
        {
          question: "Fed cut Sept",
          side: "NO",
          reason: "spread 1¢, too tight",
        },
      ],
      bankrollUsd: 100,
      exposureUsd: 0,
      pnlUsd: 0,
    });
    assert.ok(text.includes("14:30:00 UTC · MICRO_LIVE"));
    assert.ok(text.includes("Scanned 12 | gates passed 2 | trades 0"));
    assert.ok(text.includes("Bitcoin >$100k 2026 [YES]"));
    assert.ok(text.includes("edge +1.2% (floor +1.0%)"));
    assert.ok(text.includes("spread 1¢, too tight"));
    assert.equal(
      text.split("Portfolio:").length - 1,
      1,
      "portfolio summary must appear exactly once",
    );
    assert.ok(text.includes("Portfolio: $100.00 | PnL $0.00 | Exposure $0.00"));
  });

  it("formatBatchedDigest says so when nothing was evaluated", () => {
    const text = formatBatchedDigest({
      clock: "14:30:00",
      mode: "MICRO_LIVE",
      scanned: 0,
      gatesPassed: 0,
      trades: 0,
      evaluated: [],
      bankrollUsd: null,
      exposureUsd: null,
      pnlUsd: null,
    });
    assert.ok(text.includes("(none this cycle)"));
    assert.ok(text.includes("Portfolio: — | PnL — | Exposure —"));
    assert.ok(!text.includes("$0"));
  });

  it("formatBatchedDigest caps the market list and counts the rest", () => {
    const text = formatBatchedDigest({
      clock: "14:30:00",
      mode: "MICRO_LIVE",
      scanned: 9,
      gatesPassed: 7,
      trades: 0,
      evaluated: Array.from({ length: 7 }, (_, i) => ({
        question: `Market ${i + 1}`,
        side: "YES" as const,
      })),
      bankrollUsd: 100,
      exposureUsd: 0,
      pnlUsd: 0,
    });
    assert.ok(text.includes("• Market 5 [YES]"));
    assert.ok(!text.includes("• Market 6"));
    assert.ok(text.includes("… and 2 more"));
  });

  it("formatTradeAlert names the market, size, price, and edge", () => {
    const text = formatTradeAlert({
      question: "Bitcoin >$100k 2026",
      side: "YES",
      sizeShares: 42,
      notionalUsd: 23.1,
      fillPrice: 0.55,
      pYes: 0.67,
      edgePct: 12,
      floorPct: 1,
      rationale: "tren naik, inflow ETF melambat",
      bankrollUsd: 100,
      exposureUsd: 23.1,
      pnlUsd: 0,
    });
    assert.ok(text.includes("🚀 TRADE · Bitcoin >$100k 2026 [YES]"));
    assert.ok(text.includes("Beli 42 shares @ $0.55 = $23.10"));
    assert.ok(text.includes("AI 67% · edge +12.0% (floor +1.0%)"));
    assert.ok(text.includes("Alasan: tren naik, inflow ETF melambat"));
    assert.ok(text.includes("Portfolio: $100.00"));
  });

  it("formatTradeAlert renders SELL as Jual, never Beli", () => {
    const text = formatTradeAlert({
      question: "Ethereum <$2k 2026",
      side: "NO",
      action: "SELL",
      sizeShares: 10,
      notionalUsd: 4.5,
      fillPrice: 0.45,
      pYes: 0.3,
      edgePct: 5,
      floorPct: 1,
      rationale: "",
      bankrollUsd: 100,
      exposureUsd: 4.5,
      pnlUsd: 1.2,
    });
    assert.ok(text.includes("Jual 10 shares"));
    assert.ok(!text.includes("Beli"));
  });

  it("formatTradeAlert never invents a probability it does not have", () => {
    const text = formatTradeAlert({
      question: "Bitcoin >$100k 2026",
      side: "YES",
      sizeShares: 42,
      notionalUsd: 23.1,
      fillPrice: 0.55,
      pYes: null,
      edgePct: 0,
      floorPct: 1,
      rationale: "",
      bankrollUsd: 100,
      exposureUsd: 23.1,
      pnlUsd: 0,
    });
    assert.ok(text.includes("AI abstained"));
    assert.ok(!text.includes("edge +"));
    assert.ok(!text.includes("Alasan:"));
  });

  it("formatRiskGateAlert reads as one clean line", () => {
    const text = formatRiskGateAlert(
      "RISK_FEE_RATE",
      "PRODUCER",
      "POLYMARKET_CLOB_CTF_V2",
    );
    assert.equal(
      text.split("\n").length,
      1,
      "gate alert must be a single line",
    );
    assert.ok(text.includes("[RISK_FEE_RATE]"));
    assert.ok(text.includes("POLYMARKET_CLOB_CTF_V2"));
  });

  it("DigestThrottle emits once per window, then flushes on schedule", () => {
    const t = new DigestThrottle(15 * 60_000);
    const start = 1_000_000;
    assert.equal(t.shouldFlush(start), false, "first pass primes, never sends");
    assert.equal(t.shouldFlush(start + 60_000), false);
    assert.equal(t.shouldFlush(start + 14 * 60_000), false);
    assert.equal(t.shouldFlush(start + 15 * 60_000), true);
    assert.equal(t.shouldFlush(start + 15 * 60_000 + 1), false);
    assert.equal(t.shouldFlush(start + 30 * 60_000), true);
  });

  it("DigestThrottle collapses a hot loop into one digest per window", () => {
    const t = new DigestThrottle(15 * 60_000);
    const start = 0;
    t.shouldFlush(start);
    let flushes = 0;
    for (let i = 1; i <= 900; i++) {
      if (t.shouldFlush(start + i * 1000)) flushes++;
    }
    assert.equal(flushes, 1, "900 one-second passes must yield one digest");
  });
});
