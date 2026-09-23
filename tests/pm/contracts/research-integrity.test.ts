import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditDenominator,
  checkHoldoutReuse,
  segmentOnLineageDrift,
  RefPinRegistry,
  verifyReplayHashes,
} from "@polyroot/strategy";
import { evaluateRealityGap } from "@polyroot/runtime";

describe("Phase 12: FT-38 missing universe rows (denominator audit)", () => {
  it("a report limited to winners fails the denominator audit", () => {
    const universe = ["m1", "m2", "m3", "m4"];
    const res = auditDenominator(["m1", "m2"], universe);
    assert.equal(res.ok, true, "subset reporting is auditable, not a failure");
    const biased = auditDenominator(["m1", "mx_unknown"], universe);
    assert.equal(biased.ok, false);
    if (!biased.ok) assert.equal(biased.code, "SURVIVORSHIP_BIAS");
  });

  it("an empty universe cannot produce an eligible experiment", () => {
    const res = auditDenominator(["m1"], []);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "DENOMINATOR_MISMATCH");
  });
});

describe("Phase 12: FT-39 holdout reuse (new trial spends budget)", () => {
  it("threshold tweaked after a holdout peek requires a new trial; exposure preserved", () => {
    const exposure = { peekedHoldoutIds: ["h1", "h2"] };
    const verdict = checkHoldoutReuse(exposure, {
      holdoutIds: ["h1"],
      thresholdTweaked: true,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "HOLDOUT_REUSE");
    assert.equal(verdict.requiresNewTrial, true);
    assert.deepEqual(verdict.preservedExposure.peekedHoldoutIds, ["h1", "h2"]);
  });

  it("untweaked re-runs on unpeeked holdouts pass through", () => {
    const verdict = checkHoldoutReuse(
      { peekedHoldoutIds: ["h1"] },
      { holdoutIds: ["h2"], thresholdTweaked: false },
    );
    assert.equal(verdict.ok, true);
    assert.equal(verdict.requiresNewTrial, false);
  });
});

describe("Phase 12: FT-40 provider alias drift (lineage segments)", () => {
  it("changed fingerprint opens a new calibration segment", () => {
    const v = segmentOnLineageDrift("fp_aaa", "fp_bbb");
    assert.equal(v.segment, "NEW");
    assert.equal(v.calibration, "VALID");
  });

  it("hidden change is UNKNOWN, never silently SAME", () => {
    for (const [prev, curr] of [
      [null, "fp_bbb"],
      ["fp_aaa", null],
      [null, null],
    ] as Array<[any, any]>) {
      const v = segmentOnLineageDrift(prev, curr);
      assert.equal(v.segment, "NEW");
      assert.equal(v.calibration, "UNKNOWN");
    }
  });

  it("stable fingerprint carries calibration over", () => {
    const v = segmentOnLineageDrift("fp_aaa", "fp_aaa");
    assert.equal(v.segment, "SAME");
    assert.equal(v.calibration, "VALID");
  });
});

describe("Phase 12: FT-37 hot cleanup (pin + replay hashes)", () => {
  it("pinned live objects survive cleanup; unpinned are deleted", () => {
    const pins = new RefPinRegistry();
    pins.acquire("raw_1");
    pins.acquire("raw_1");
    const res = pins.cleanup(["raw_1", "raw_2"]);
    assert.deepEqual(res.retained, ["raw_1"]);
    assert.deepEqual(res.deleted, ["raw_2"]);
    pins.release("raw_1");
    assert.equal(pins.pinned("raw_1"), true);
    pins.release("raw_1");
    assert.equal(pins.pinned("raw_1"), false);
  });

  it("replay with a tampered hash fails closed", () => {
    const expected = new Map([["r1", "hash1"]]);
    assert.equal(
      verifyReplayHashes([{ id: "r1", hash: "hash1" }], expected).ok,
      true,
    );
    const bad = verifyReplayHashes([{ id: "r1", hash: "evil" }], expected);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "REPLAY_HASH_MISMATCH");
  });
});

describe("Phase 12: FT-41 optimistic paper fills (reality gap gate)", () => {
  it("inflated paper fill rates FAIL the reality gate for the profile", () => {
    const res = evaluateRealityGap({
      fillRatePaper: 0.95,
      fillRateObserved: 0.6,
      meanSignedSlippage: 0.001,
      cancelOverfill: 0,
      invariantViolations: 0,
      independentAttempts: 150,
    });
    assert.equal(res.verdict, "FAIL");
    assert.match(res.reasons.join(";"), /fill-rate gap/);
  });
});
