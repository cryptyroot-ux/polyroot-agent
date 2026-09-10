import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilityAllows, VENUE_CAPABILITIES } from "@polyroot/venue";

describe("PR-EXE-02 / T-PR-EXE-02: VenueAdapter capability contract", () => {
  it("exposes the required capability set (market data, signing, submit, cancel, lookup, balances, heartbeat, settlement, venue-mode)", () => {
    for (const cap of ["market_data", "order_submit", "order_cancel", "order_lookup", "balances", "heartbeat", "settlement", "venue_mode", "fills"]) {
      assert.ok(VENUE_CAPABILITIES.has(cap), `missing capability ${cap}`);
    }
  });

  it("fails closed when a required capability is unsupported", () => {
    const res = capabilityAllows("order_submit", { venues: ["polymarket"], requires: ["order_submit"], supports: new Map([["order_submit", true]]) });
    assert.equal(res.ok, true);
    const blocked = capabilityAllows("order_submit", { venues: ["polymarket"], requires: ["order_submit"], supports: new Map([["order_submit", false]]) });
    assert.equal(blocked.ok, false);
  });

  it("an unregistered capability is refused (fail closed)", () => {
    const res = capabilityAllows("bridge_withdraw", { venues: ["polymarket"], requires: ["bridge_withdraw"], supports: new Map() });
    assert.equal(res.ok, false);
  });

  it("a second venue without its venue gate is refused for LIVE routing (PR-GOV-02)", () => {
    const res = capabilityAllows("order_submit", {
      venues: ["other-venue"],
      requires: ["order_submit", "venue_gate"],
      supports: new Map([["order_submit", true], ["venue_gate", false]]),
    });
    assert.equal(res.ok, false);
  });
});