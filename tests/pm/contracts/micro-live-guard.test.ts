import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateLossGuard,
  evaluateG4Readiness,
  microLiveEntriesBlocked,
} from "@polyroot/runtime";

const CAP = 500;
const NOW = new Date("2026-09-23T00:00:00Z");

function loss(over: Partial<Parameters<typeof evaluateLossGuard>[0]> = {}) {
  return {
    realizedLossPusd: 0,
    lossCapPusd: CAP,
    reset: false,
    previous: null,
    now: NOW,
    ...over,
  };
}

const HEALTHY_GAP = {
  fillRatePaper: 0.8,
  fillRateObserved: 0.76,
  meanSignedSlippage: 0.001,
  cancelOverfill: 0,
  invariantViolations: 0,
  independentAttempts: 150,
};

function readiness(
  over: Partial<Parameters<typeof evaluateG4Readiness>[0]> = {},
) {
  return {
    observedDays: 45,
    resolvedClusters: 150,
    criteria: { minDays: 30, minResolvedClusters: 100 },
    gap: HEALTHY_GAP,
    loss: loss(),
    ...over,
  };
}

describe("Phase 11: micro-LIVE loss-cap latch (PRD G4, no auto-resume)", () => {
  it("stays running while loss is under the owner cap", () => {
    const r = evaluateLossGuard(loss({ realizedLossPusd: 120 }));
    assert.equal(r.halted, false);
    assert.equal(r.level, "NONE");
    assert.equal(r.code, "LOSS_WITHIN_CAP");
    assert.equal(microLiveEntriesBlocked(r.level), false);
  });

  it("halts entries exactly at the cap (boundary is a breach)", () => {
    const r = evaluateLossGuard(loss({ realizedLossPusd: CAP }));
    assert.equal(r.halted, true);
    assert.equal(r.level, "PAUSE_ENTRIES");
    assert.equal(r.code, "LOSS_CAP_BREACHED");
    assert.equal(microLiveEntriesBlocked(r.level), true);
  });

  it("latch persists across evaluations and restarts without explicit reset", () => {
    const first = evaluateLossGuard(loss({ realizedLossPusd: 600 }));
    assert.equal(first.halted, true);
    assert.ok(first.state.haltedAt);
    // Next evaluation — even with loss back at zero (fresh process state) —
    // stays halted because the persisted latch is carried in `previous`.
    const second = evaluateLossGuard(
      loss({ realizedLossPusd: 0, previous: first.state }),
    );
    assert.equal(second.halted, true);
    assert.equal(second.code, "LOSS_CAP_LATCHED");
  });

  it("explicit reset clears the latch only when loss is back under cap", () => {
    const breached = evaluateLossGuard(loss({ realizedLossPusd: 600 }));
    const cleared = evaluateLossGuard(
      loss({ realizedLossPusd: 10, reset: true, previous: breached.state }),
    );
    assert.equal(cleared.halted, false);
    assert.equal(cleared.code, "LOSS_WITHIN_CAP");
  });

  it("reset is refused while loss is still at/over cap", () => {
    const breached = evaluateLossGuard(loss({ realizedLossPusd: 600 }));
    const refused = evaluateLossGuard(
      loss({ realizedLossPusd: 550, reset: true, previous: breached.state }),
    );
    assert.equal(refused.halted, true);
    assert.equal(refused.code, "LOSS_CAP_LATCHED");
  });

  it("unconfigured cap is fail-closed (halted, never trading)", () => {
    for (const badCap of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = evaluateLossGuard(loss({ lossCapPusd: badCap }));
      assert.equal(r.halted, true);
      assert.equal(r.code, "LOSS_CAP_UNCONFIGURED");
    }
  });
});

describe("Phase 11: G4 readiness gate (shadow + reality-gap + loss)", () => {
  it("PROMOTE when baseline met, gap PASS, loss within cap", () => {
    const r = evaluateG4Readiness(readiness());
    assert.equal(r.decision, "PROMOTE");
    assert.equal(r.lossHalted, false);
  });

  it("HOLD while shadow baseline is still growing (not a fault)", () => {
    const r = evaluateG4Readiness(readiness({ observedDays: 10 }));
    assert.equal(r.decision, "HOLD");
    assert.equal(r.gapVerdict, "NOT_EVALUATED");
  });

  it("HOLD on inconclusive reality gap (insufficient evidence, never promote)", () => {
    const r = evaluateG4Readiness(
      readiness({
        gap: { ...HEALTHY_GAP, independentAttempts: 20 },
      }),
    );
    assert.equal(r.decision, "HOLD");
    assert.equal(r.gapVerdict, "INCONCLUSIVE");
  });

  it("BLOCKED on reality-gap FAIL", () => {
    const r = evaluateG4Readiness(
      readiness({ gap: { ...HEALTHY_GAP, cancelOverfill: 3 } }),
    );
    assert.equal(r.decision, "BLOCKED");
    assert.equal(r.gapVerdict, "FAIL");
  });

  it("BLOCKED while the loss latch is engaged", () => {
    const r = evaluateG4Readiness(
      readiness({ loss: loss({ realizedLossPusd: 9999 }) }),
    );
    assert.equal(r.decision, "BLOCKED");
    assert.equal(r.lossHalted, true);
  });
});
