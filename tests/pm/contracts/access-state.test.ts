import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accessAllows,
  computeAccessGate,
} from "@polyroot/control";

describe("PR-GOV-06 / T-PR-GOV-06: access & compliance state", () => {
  it("BLOCKED and CLOSE_ONLY are first-class states; entry is denied in both", () => {
    assert.equal(accessAllows("ACCESS_BLOCKED", "ORDER_SUBMIT").ok, false);
    assert.equal(accessAllows("CLOSE_ONLY", "ORDER_SUBMIT").ok, false);
    // In CLOSE_ONLY only platform-permitted risk reduction/cancel may proceed.
    assert.equal(accessAllows("CLOSE_ONLY", "ORDER_CANCEL").ok, true);
    assert.equal(accessAllows("CLOSE_ONLY", "REDUCE_ONLY").ok, true);
  });

  it("ACCESS_BLOCKED allows no financial action (only read)", () => {
    assert.equal(accessAllows("ACCESS_BLOCKED", "ORDER_CANCEL").ok, false);
    assert.equal(accessAllows("ACCESS_BLOCKED", "READ").ok, true);
  });

  it("computeAccessGate fails closed on unknown/undefined state", () => {
    assert.equal(computeAccessGate("UNKNOWN"), "FINANCIAL_BLOCKED");
    assert.equal(computeAccessGate("GEO_BLOCKED"), "FINANCIAL_BLOCKED");
  });

  it("NORMAL/HEALTHY access allows routine trading (no location bypass)", () => {
    assert.equal(computeAccessGate("NORMAL"), "ALLOW");
    assert.equal(accessAllows("NORMAL", "ORDER_SUBMIT").ok, true);
  });
});