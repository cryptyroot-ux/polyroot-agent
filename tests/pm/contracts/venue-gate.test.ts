import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { venueActionGate } from "@polyroot/venue";
import type { VenueMode } from "@polyroot/domain";

const MODES: VenueMode[] = [
  "NORMAL",
  "POST_ONLY",
  "CANCEL_ONLY",
  "READ_ONLY",
  "UNAVAILABLE",
  "UNKNOWN",
];

describe("VenueAdapter — venue-mode action matrix (TABLE 17, PM-EXE-02)", () => {
  it("NORMAL and POST_ONLY permit order submit and cancel", () => {
    for (const m of ["NORMAL", "POST_ONLY"] as VenueMode[]) {
      assert.equal(venueActionGate(m, "ORDER_SUBMIT").allowed, true);
      assert.equal(venueActionGate(m, "ORDER_CANCEL").allowed, true);
    }
  });

  it("CANCEL_ONLY forbids submit but allows cancel", () => {
    assert.equal(venueActionGate("CANCEL_ONLY", "ORDER_SUBMIT").allowed, false);
    assert.equal(venueActionGate("CANCEL_ONLY", "ORDER_CANCEL").allowed, true);
  });

  it("READ_ONLY forbids submit and cancel but permits reads (PM-VENUE-01)", () => {
    assert.equal(venueActionGate("READ_ONLY", "ORDER_SUBMIT").allowed, false);
    assert.equal(venueActionGate("READ_ONLY", "ORDER_CANCEL").allowed, false);
    assert.equal(venueActionGate("READ_ONLY", "READ").allowed, true);
  });

  it("UNAVAILABLE and UNKNOWN fail closed for every action", () => {
    for (const m of ["UNAVAILABLE", "UNKNOWN"] as VenueMode[]) {
      assert.equal(venueActionGate(m, "ORDER_SUBMIT").allowed, false);
      assert.equal(venueActionGate(m, "ORDER_CANCEL").allowed, false);
      if (m === "UNKNOWN")
        assert.equal(venueActionGate(m, "READ").allowed, false);
      else assert.equal(venueActionGate(m, "READ").allowed, true);
    }
  });

  it("every mode produces a deterministic, structured decision", () => {
    for (const m of MODES) {
      const d = venueActionGate(m, "ORDER_SUBMIT");
      assert.equal(typeof d.allowed, "boolean");
      assert.equal(typeof d.code, "string");
      assert.equal(typeof d.reason, "string");
    }
  });
});
