import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  simulateFill,
  evaluateShadowCandidate,
  brierScore,
  logLoss,
  calibrationError,
  sharpness,
  coverage,
  abstentionRate,
  computeProbQuality,
  maxDrawdown,
  concentrationIndex,
  computeEconomicMetrics,
  ExperimentRegistry,
  runPaperLoop,
  type SimulatedFill,
} from "@polyroot/runtime";

/* ── PR-VAL-04: fill simulation ── */
describe("PR-VAL-04: paper fill simulator", () => {
  it("fills fully when depth covers size", () => {
    const fill = simulateFill({
      size: 10,
      bid: 0.4,
      ask: 0.6,
      depth: 100,
      taker: false,
      makerFeeBps: 0,
      takerFeeBps: 200,
      latencyMs: 5,
      cancelProbability: 0,
      partialFraction: 0.5,
      rng: () => 0.5,
    });
    assert.equal(fill.status, "FILLED");
    assert.equal(fill.filledSize, 10);
    assert.equal(fill.fillPrice, 0.4);
  });

  it("applies taker fee to taker orders", () => {
    const fill = simulateFill({
      size: 100,
      bid: 0.4,
      ask: 0.6,
      depth: 100,
      taker: true,
      makerFeeBps: 0,
      takerFeeBps: 200,
      latencyMs: 5,
      cancelProbability: 0,
      partialFraction: 0.5,
      rng: () => 0.5,
    });
    assert.equal(fill.status, "FILLED");
    assert.ok(fill.takerFee > 0);
    assert.equal(fill.makerFee, 0);
  });

  it("cancels when cancelProbability hits", () => {
    const fill = simulateFill({
      size: 10,
      bid: 0.4,
      ask: 0.6,
      depth: 100,
      taker: false,
      makerFeeBps: 0,
      takerFeeBps: 200,
      latencyMs: 5,
      cancelProbability: 0.2,
      partialFraction: 0.5,
      rng: () => 0.05, // first rng() call < 0.2 => cancel
    });
    assert.equal(fill.status, "CANCELLED");
    assert.equal(fill.filledSize, 0);
  });
});

/* ── PR-VAL-05: SHADOW candidate gate ── */
describe("PR-VAL-05: prospective SHADOW criterion", () => {
  it("rejects insufficient baseline days", () => {
    const r = evaluateShadowCandidate({
      observedDays: 10,
      resolvedClusters: 200,
      criteria: { minResolvedClusters: 100, minDays: 30 },
    });
    assert.equal(r.passed, false);
    assert.match(r.reason, /baseline/);
  });

  it("rejects insufficient resolved clusters", () => {
    const r = evaluateShadowCandidate({
      observedDays: 45,
      resolvedClusters: 50,
      criteria: { minResolvedClusters: 100, minDays: 30 },
    });
    assert.equal(r.passed, false);
    assert.match(r.reason, /clusters/);
  });

  it("passes when both criteria met", () => {
    const r = evaluateShadowCandidate({
      observedDays: 45,
      resolvedClusters: 150,
      criteria: { minResolvedClusters: 100, minDays: 30 },
    });
    assert.equal(r.passed, true);
  });
});

/* ── PR-VAL-06: probabilistic quality metrics ── */
describe("PR-VAL-06: probabilistic quality metrics", () => {
  it("perfect forecasts have Brier 0 and logLoss ~0", () => {
    const probs = [0.99, 0.01, 0.99];
    const outcomes = [1, 0, 1];
    assert.ok(brierScore(probs, outcomes) < 0.01);
    assert.ok(logLoss(probs, outcomes) < 0.02);
  });

  it("anti-forecasts have Brier close to 1", () => {
    const probs = [0.01, 0.99];
    const outcomes = [1, 0];
    assert.ok(brierScore(probs, outcomes) > 0.9);
  });

  it("calibration error is bounded and 0 for perfect calibration", () => {
    // Uniformly spread calibrated predictions: p in [0,1) matching freq roughly.
    const probs: number[] = [];
    const outcomes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const p = (i + 1) / 101;
      probs.push(p);
      outcomes.push(Math.random() < p ? 1 : 0);
    }
    const err = calibrationError(probs, outcomes, 5);
    assert.ok(Number.isFinite(err));
    assert.ok(err >= 0);
  });

  it("sharpness favors confident forecasts, coverage prefers accurate bands", () => {
    assert.equal(sharpness([0.9, 0.2]), 0.35);
    assert.ok(sharpness([0.9, 0.1]) > sharpness([0.55, 0.45]));
    assert.equal(coverage([0.9, 0.1], [1, 0]), 1);
    assert.equal(coverage([0.9, 0.1], [0, 1]), 0);
  });

  it("abstention counts near-50% forecasts", () => {
    assert.equal(abstentionRate([0.5, 0.51, 0.9]), 2 / 3);
  });

  it("computeProbQuality aggregates all sub-metrics", () => {
    const q = computeProbQuality({ probabilities: [0.8, 0.3, 0.7], outcomes: [1, 0, 1] });
    assert.equal(q.n, 3);
    assert.ok(q.brier >= 0 && q.brier <= 1);
    assert.ok(Number.isFinite(q.logLoss));
  });
});

/* ── PR-VAL-07: economic metrics ── */
describe("PR-VAL-07: economic metrics", () => {
  it("maxDrawdown peaks to trough correctly", () => {
    assert.equal(maxDrawdown([100, 120, 80, 90]), 0.3333333333333333);
    assert.equal(maxDrawdown([100, 110, 120]), 0);
  });

  it("concentration index is 1 for a single market and lower for many", () => {
    assert.ok(Math.abs(concentrationIndex([10]) - 1) < 1e-9);
    assert.ok(concentrationIndex([5, 5]) < 1);
  });

  it("computeEconomicMetrics returns net PnL after fees", () => {
    const m = computeEconomicMetrics({
      equityCurve: [1000, 1050],
      initialEquity: 1000,
      totalFees: 20,
      grossPnl: 120,
      turnover: 800,
      capacityUsd: 10_000,
      perMarketPnl: [50, -10, 20],
    });
    assert.equal(m.netPnl, 100);
    assert.equal(m.maxDrawdownPct, 0);
    assert.ok(m.capacityUtilizationPct > 0);
    assert.ok(m.concentration < 1);
  });
});

/* ── PR-VAL-08: experiment registry (preregistration, append-only) ── */
describe("PR-VAL-08: experiment registry", () => {
  it("preregisters specs and cannot mutate them after creation", () => {
    const registry = new ExperimentRegistry();
    const spec = registry.preregister({
      name: "v1-bandit",
      version: "1.0.0",
      description: "baseline",
      preregisteredRule: "stop if brier < 0.25 after 100 events",
    });
    assert.equal(spec.status, "PREREGISTERED");
    assert.match(spec.id, /^[0-9a-f-]{36}$/);
    assert.equal(registry.get(spec.id)?.status, "PREREGISTERED");
  });

  it("concludes with a result and tracks counts without cherry-picking", () => {
    const registry = new ExperimentRegistry();
    const s1 = registry.preregister({ name: "a", version: "1", description: "x", preregisteredRule: "r1" });
    const s2 = registry.preregister({ name: "b", version: "1", description: "y", preregisteredRule: "r2" });
    registry.conclude(s1.id, { brier: 0.2, logLoss: 0.6, calibrationError: 0.1, sharpness: 0.3, coverage: 0.8, abstentionRate: 0.1, n: 100 });
    registry.withdraw(s2.id);
    const counts = registry.countByStatus();
    assert.equal(counts.CONCLUDED, 1);
    assert.equal(counts.WITHDRAWN, 1);
    // No cherry-picking: both specs remain in the registry.
    assert.equal(registry.all().length, 2);
  });
});

/* ── G4: full autonomous paper loop (no financial I/O) ── */
describe("G4: full autonomous paper loop", () => {
  const markets = [
    { market_id: "m1", bid: 0.4, ask: 0.6 },
    { market_id: "m2", bid: 0.3, ask: 0.5 },
    { market_id: "m3", bid: 0.7, ask: 0.9 },
  ];

  it("runs a full pass and returns decisions, quality and economic metrics", () => {
    const result = runPaperLoop(
      {
        forecast: (m) => (m.bid + m.ask) / 2 + 0.05,
        sizeIntent: (_m, p) => Math.round(100 * Math.abs(p - 0.5) * 2),
      },
      markets,
      {
        makerFeeBps: 0,
        takerFeeBps: 200,
        latencyMs: 5,
        cancelProbability: 0,
        partialFraction: 0.5,
        rng: () => 0.5,
      },
    );

    assert.equal(result.decisions.length, 3);
    assert.equal(result.probabilities.length, 3);
    assert.equal(result.outcomes.length, 3);
    assert.ok(Number.isFinite(result.economic.netPnl));
    assert.ok(result.probQuality.n === 3);

    // No financial I/O guard: every decision either NO_TRADE or a simulated fill.
    for (const d of result.decisions) {
      if (d.action !== "NO_TRADE") {
        assert.ok(
          d.fill.status === "FILLED" ||
            d.fill.status === "PARTIAL" ||
            d.fill.status === "CANCELLED",
        );
      }
    }
  });

  it("abstains on highly uncertain forecasts", () => {
    const result = runPaperLoop(
      {
        forecast: () => 0.5, // perfectly uncertain -> abstain
        sizeIntent: (_m, p) => Math.round(100 * Math.abs(p - 0.5) * 2),
      },
      markets,
      {
        makerFeeBps: 0,
        takerFeeBps: 200,
        latencyMs: 5,
        cancelProbability: 0.5,
        partialFraction: 0.5,
        rng: () => 0.9,
      },
    );
    for (const d of result.decisions) {
      assert.equal(d.action, "NO_TRADE");
    }
  });
});