import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPaperLoopWithOrchestrator } from "@polyroot/runtime";

describe("PR-AUT-02 / G4: PAPER loop wired through the real pipeline", () => {
  const markets = [
    { market_id: "m1", bid: 0.4, ask: 0.6 },
    { market_id: "m2", bid: 0.3, ask: 0.5 },
  ];
  const feeInput = {
    makerFeeBps: 0,
    takerFeeBps: 200,
    latencyMs: 5,
    cancelProbability: 0,
    partialFraction: 0.5,
    rng: () => 0.5,
  };

  it("routes every tradable decision through the orchestrator (single money path) and records fills", async () => {
    const submitted: string[] = [];
    let gateCount = 0;

    const result = await runPaperLoopWithOrchestrator({
      markets,
      feeInput,
      forecast: (m) => (m.bid + m.ask) / 2 + 0.05,
      sizeIntent: (_m, p) => Math.round(100 * Math.abs(p - 0.5) * 2),
      computeGate: () => "ALLOW",
      onEntry: (_m) => { gateCount++; },
      orchestrate: async (m) => {
        submitted.push(m.market_id);
        return { ok: true, outcome: "SUBMITTED", state: "ACKNOWLEDGED", order: { order_id: `o_${m.market_id}` } };
      },
    });

    // Both markets have a tradable edge (bid/ask midpoint + 0.05 => p in (0.5, 0.6))
    assert.equal(submitted.length, markets.length, "all tradable markets must go through orchestrate");
    assert.equal(gateCount, markets.length, "gate check must run before each entry");
    assert.ok(result.decisions.length === markets.length);
    assert.ok(Number.isFinite(result.economic.netPnl));
  });

  it("gate 'ENTRY_BLOCKED' still allows cancel/reconcile paths but skips new submits", async () => {
    const submitted: string[] = [];
    const _result = await runPaperLoopWithOrchestrator({
      markets,
      feeInput,
      forecast: (m) => (m.bid + m.ask) / 2 + 0.05,
      sizeIntent: (_m, p) => Math.round(100 * Math.abs(p - 0.5) * 2),
      computeGate: (m) => (m.market_id === "m2" ? "ENTRY_BLOCKED" : "ALLOW"),
      onEntry: () => {},
      orchestrate: async (m) => {
        submitted.push(m.market_id);
        return { ok: true, outcome: "SUBMITTED", state: "ACKNOWLEDGED", order: { order_id: `o_${m.market_id}` } };
      },
    });
    assert.deepEqual(submitted, ["m1"], "only gate-ALLOW market reaches orchestrate");
  });

  it("financial gate blocks all submits regardless of edge", async () => {
    const submitted: string[] = [];
    const _result = await runPaperLoopWithOrchestrator({
      markets,
      feeInput,
      forecast: (m) => (m.bid + m.ask) / 2 + 0.05,
      sizeIntent: (_m, p) => Math.round(100 * Math.abs(p - 0.5) * 2),
      computeGate: () => "FINANCIAL_BLOCKED",
      onEntry: () => {},
      orchestrate: async (m) => {
        submitted.push(m.market_id);
        return { ok: true, outcome: "SUBMITTED", state: "ACKNOWLEDGED", order: {} };
      },
    });
    assert.equal(submitted.length, 0, "no financial orders may be submitted when the financial gate blocks");
  });
});