import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateRealityGap } from "@polyroot/runtime";

const HEALTHY = {
  fillRatePaper: 0.8,
  fillRateObserved: 0.75,
  meanSignedSlippage: 0.002,
  cancelOverfill: 0,
  invariantViolations: 0,
  independentAttempts: 120,
};

describe("Phase 10: execution reality gap gate (Blueprint §13.2, PRD G3/G4)", () => {
  it("PASS when evidence is sufficient and all tolerances are met", () => {
    const res = evaluateRealityGap(HEALTHY);
    assert.equal(res.verdict, "PASS");
    assert.ok(res.reasons.length > 0);
  });

  it("INCONCLUSIVE (never PASS) when independent attempts are below minimum", () => {
    const res = evaluateRealityGap({ ...HEALTHY, independentAttempts: 99 });
    assert.equal(res.verdict, "INCONCLUSIVE");
    assert.match(res.reasons.join(" "), /insufficient evidence/);
  });

  it("FAIL on cancel overfill above zero (zero-tolerance invariant)", () => {
    const res = evaluateRealityGap({ ...HEALTHY, cancelOverfill: 1 });
    assert.equal(res.verdict, "FAIL");
    assert.match(res.reasons.join(" "), /cancel overfill/);
  });

  it("FAIL on any invariant violation (zero-tolerance invariant)", () => {
    const res = evaluateRealityGap({ ...HEALTHY, invariantViolations: 2 });
    assert.equal(res.verdict, "FAIL");
    assert.match(res.reasons.join(" "), /invariant violations/);
  });

  it("FAIL when fill-rate gap exceeds 10pp", () => {
    const res = evaluateRealityGap({
      ...HEALTHY,
      fillRatePaper: 0.9,
      fillRateObserved: 0.7,
    });
    assert.equal(res.verdict, "FAIL");
    assert.match(res.reasons.join(" "), /fill-rate gap/);
  });

  it("FAIL when slippage bias exceeds 0.005 pUSD/share (signed either way)", () => {
    for (const slippage of [0.006, -0.006]) {
      const res = evaluateRealityGap({
        ...HEALTHY,
        meanSignedSlippage: slippage,
      });
      assert.equal(res.verdict, "FAIL");
    }
  });

  it("INCONCLUSIVE on non-finite or out-of-range measurements (never a fake verdict)", () => {
    const bad = evaluateRealityGap({ ...HEALTHY, meanSignedSlippage: Number.NaN });
    assert.equal(bad.verdict, "INCONCLUSIVE");
    const outOfRange = evaluateRealityGap({
      ...HEALTHY,
      fillRateObserved: 1.5,
    });
    assert.equal(outOfRange.verdict, "INCONCLUSIVE");
  });

  it("boundary values pass exactly at tolerance (gap 10pp, bias 0.005, 100 attempts)", () => {
    const res = evaluateRealityGap({
      fillRatePaper: 0.8,
      fillRateObserved: 0.7,
      meanSignedSlippage: 0.005,
      cancelOverfill: 0,
      invariantViolations: 0,
      independentAttempts: 100,
    });
    assert.equal(res.verdict, "PASS");
  });
});
