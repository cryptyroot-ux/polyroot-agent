import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, resolveEdgeFloor } from "@polyroot/runtime";

describe("market regime classifier", () => {
  it("flags dust, tight consensus, contested and normal books", () => {
    assert.equal(classifyRegime(0.009, 0.011), "DUST");
    assert.equal(classifyRegime(0.989, 0.991), "DUST");
    assert.equal(classifyRegime(0.6, 0.61), "TIGHT_CONSENSUS");
    assert.equal(classifyRegime(0.45, 0.55), "CONTESTED");
    assert.equal(classifyRegime(0.6, 0.7), "NORMAL");
  });
});

describe("spread-adaptive edge floor", () => {
  it("adds half the spread, capped at +5pp", () => {
    assert.equal(resolveEdgeFloor(0.03, 0.02), 0.04);
    assert.equal(resolveEdgeFloor(0.03, 0), 0.03);
    assert.equal(resolveEdgeFloor(0.03, 0.5), 0.08);
    assert.equal(resolveEdgeFloor(NaN, 0.02), 0.04);
  });
});
