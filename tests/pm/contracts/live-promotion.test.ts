import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateLivePromotion } from "@polyroot/control";

const NOW = new Date("2026-09-23T00:00:00Z");
const FUTURE = new Date("2026-12-31T00:00:00Z");

function pack(over: Record<string, any> = {}) {
  return {
    strategy: "evidence_directional_v2",
    profile: "polymarket-papermode",
    gates: { G0: true, G1: true, G2: true, G3: true, G4: true },
    promotion: {
      fromCapUsd: 500,
      toCapUsd: 2000,
      ownerAuth: "sig_owner_abc",
      expiresAt: FUTURE,
    },
    monitoring: { systemHealth: true, venueMode: true, accountMode: true },
    rollback: {
      triggers: ["drawdown-latch", "kill-switch", "mandate-expiry"],
      steps: ["reduce-only", "flatten", "halt"],
    },
    now: NOW,
    ...over,
  };
}

describe("Phase 24 G5 LIVE promotion pack (PRD G5)", () => {
  it("promotes only with all gates + signed promotion + monitoring + rollback", () => {
    const r = evaluateLivePromotion(pack());
    assert.equal(r.decision, "PROMOTE_TO_LIVE");
  });

  it("pending gates HOLD (never promote on borrowed evidence)", () => {
    const r = evaluateLivePromotion(
      pack({ gates: { G0: true, G1: true, G2: true, G3: false, G4: false } }),
    );
    assert.equal(r.decision, "HOLD");
  });

  it("unsigned, non-increasing or expired promotions BLOCK distinctly", () => {
    const unsigned = evaluateLivePromotion(
      pack({ promotion: { ...pack().promotion, ownerAuth: "" } }),
    );
    assert.equal(unsigned.decision, "BLOCKED");
    if (unsigned.decision === "BLOCKED")
      assert.equal(unsigned.code, "PROMOTION_UNSIGNED");

    const flat = evaluateLivePromotion(
      pack({
        promotion: { ...pack().promotion, fromCapUsd: 2000, toCapUsd: 2000 },
      }),
    );
    assert.equal(flat.decision, "BLOCKED");

    const expired = evaluateLivePromotion(
      pack({
        promotion: {
          ...pack().promotion,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
        },
      }),
    );
    assert.equal(expired.decision, "BLOCKED");
  });

  it("monitoring gaps and incomplete rollback BLOCK", () => {
    const mon = evaluateLivePromotion(
      pack({ monitoring: { systemHealth: true, venueMode: false, accountMode: true } }),
    );
    assert.equal(mon.decision, "BLOCKED");
    const rb = evaluateLivePromotion(
      pack({ rollback: { triggers: ["kill-switch"], steps: ["flatten"] } }),
    );
    assert.equal(rb.decision, "BLOCKED");
    const noSteps = evaluateLivePromotion(
      pack({
        rollback: {
          triggers: ["drawdown-latch", "kill-switch", "mandate-expiry"],
          steps: [],
        },
      }),
    );
    assert.equal(noSteps.decision, "BLOCKED");
  });
});
