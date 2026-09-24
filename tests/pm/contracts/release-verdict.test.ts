import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseVerdict } from "@polyroot/control";

function green(over: Record<string, any> = {}) {
  return {
    faultCovered: 46,
    faultTotal: 46,
    sdkOfflineCovered: 30,
    sdkOfflineTotal: 30,
    tracePass: 96,
    traceTotal: 96,
    ciGreen: true,
    shadowPlumbingProven: true,
    liveObservationDays: 0,
    liveFillsObserved: 0,
    keystoreWired: false,
    wrapper1271Present: false,
    ...over,
  };
}

describe("Phase 30: release verdict (PRD 10, Blueprint 15)", () => {
  it("red unit gates block everything with named reasons (NO_GO)", () => {
    const r = releaseVerdict(green({ faultCovered: 45 }));
    assert.equal(r.tier, "NO_GO");
    if (r.tier === "NO_GO") {
      assert.match(r.openItems.join(";"), /fault contracts 45\/46/);
    }
    const ci = releaseVerdict(green({ ciGreen: false }));
    assert.equal(ci.tier, "NO_GO");
  });

  it("green units without live evidence cap at GO_SHADOW, never LIVE", () => {
    const r = releaseVerdict(green());
    assert.equal(r.tier, "GO_SHADOW");
    assert.match(r.reasons.join(";"), /live-blocker/);
  });

  it("without shadow plumbing the ceiling is GO_PAPER", () => {
    const r = releaseVerdict(green({ shadowPlumbingProven: false }));
    assert.equal(r.tier, "GO_PAPER");
  });

  it("even complete live evidence never auto-emits LIVE (owner sign-off out of band)", () => {
    const r = releaseVerdict(
      green({
        liveObservationDays: 45,
        liveFillsObserved: 200,
        keystoreWired: true,
        wrapper1271Present: true,
      }),
    );
    assert.notEqual((r as any).tier, "PROMOTE_TO_LIVE");
    assert.ok(["GO_PAPER", "GO_SHADOW"].includes((r as any).tier));
  });

  it("each live gap is named individually", () => {
    const r = releaseVerdict(green({ liveObservationDays: 12 }));
    const text = r.reasons.join(";");
    assert.match(text, /12\/30 days/);
    assert.match(text, /no authenticated live fills/);
    assert.match(text, /Keystore/);
    assert.match(text, /1271/);
  });
});
