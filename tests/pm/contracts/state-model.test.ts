import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGate } from "@polyroot/control";

describe("PRD P3.2 operational state model", () => {
  it("Only LIVE can send financial orders; PAPER/SHADOW cannot", () => {
    assert.equal(computeGate("PAPER", "ACTIVE", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("SHADOW", "ACTIVE", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "NORMAL"), "ALLOW");
  });

  it("Health is orthogonal to mode: DEGRADED blocks entries only, not cancels", () => {
    assert.equal(computeGate("LIVE", "DEGRADED", "NORMAL"), "ENTRY_BLOCKED");
  });

  it("Hard-blocking health states stop all financial activity and cannot self-bypass", () => {
    assert.equal(computeGate("LIVE", "RECOVERING", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "ACCESS_BLOCKED", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "EMERGENCY_HALT", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "STOPPED", "NORMAL"), "FINANCIAL_BLOCKED");
  });

  it("Venue mode gates actions independently of health (mode is not health)", () => {
    assert.equal(computeGate("LIVE", "ACTIVE", "POST_ONLY"), "ENTRY_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "CANCEL_ONLY"), "ENTRY_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "UNKNOWN"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "UNAVAILABLE"), "FINANCIAL_BLOCKED");
  });
});