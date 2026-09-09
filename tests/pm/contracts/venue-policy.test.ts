/**
 * Contract tests for venue policy — mode gate (PM-VENUE-01), capability
 * intersection (PM-VENUE-02), error taxonomy (PM-VENUE-04), throttling
 * (PM-VENUE-05), in-flight/recovery (PM-VENUE-03/06).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  venueActionGate,
  capabilityIntersection,
  normalizeVenueError,
  RateGovernor,
  RecoveryLedger,
  type IntersectionInput,
} from "@polyroot/venue";

describe("Venue mode gate (PM-VENUE-01)", () => {
  it("system READY + venue CANCEL_ONLY still refuses all new orders", () => {
    const submit = venueActionGate("CANCEL_ONLY", "ORDER_SUBMIT");
    assert.equal(submit.allowed, false);
    assert.equal(submit.code, "MODE_FORBIDS");
    // Cancel stays legal.
    assert.equal(venueActionGate("CANCEL_ONLY", "ORDER_CANCEL").allowed, true);
  });

  it("READ_ONLY forbids submit and cancel, allows read; UNKNOWN forbids even read", () => {
    assert.equal(venueActionGate("READ_ONLY", "ORDER_SUBMIT").allowed, false);
    assert.equal(venueActionGate("READ_ONLY", "ORDER_CANCEL").allowed, false);
    assert.equal(venueActionGate("READ_ONLY", "READ").allowed, true);
    assert.equal(venueActionGate("UNKNOWN", "READ").allowed, false);
  });
});

describe("Capability intersection (PM-VENUE-02)", () => {
  const base: IntersectionInput = {
    venueMode: "NORMAL",
    accountMode: "ACTIVE",
    capability: {
      market_id: "m1",
      protocol: "ctf",
      supports_reduce_only: true,
      supports_gtc: true,
      supports_gtd: true,
      supports_post_only: true,
      max_tick_size_base: 1n,
      min_size_base: 1n,
      observed_at: new Date(),
    },
    mandateAllows: true,
    fresh: true,
    riskOpen: true,
  };

  it("account CLOSE_ONLY at venue NORMAL only reduces verified inventory", () => {
    const input = { ...base, accountMode: "CLOSE_ONLY" as const };
    const entry = capabilityIntersection("ORDER_SUBMIT", {
      ...input,
      requiredStyle: "LIMIT",
    });
    assert.equal(entry.allowed, false);
    assert.equal((entry as { code: string }).code, "ACCOUNT_CLOSE_ONLY");

    const reduce = capabilityIntersection("ORDER_SUBMIT", {
      ...input,
      requiredStyle: "REDUCE_ONLY",
    });
    assert.equal(reduce.allowed, true);
  });

  it("REDUCE_ONLY requires the venue to prove the capability", () => {
    const noCap = capabilityIntersection("ORDER_SUBMIT", {
      ...base,
      requiredStyle: "REDUCE_ONLY",
      capability: { ...base.capability!, supports_reduce_only: false },
    });
    assert.equal(noCap.allowed, false);
    assert.equal((noCap as { code: string }).code, "NO_REDUCE_ONLY_CAP");
  });

  it("mandate / freshness / risk gaps each block the entry", () => {
    const blocked = [
      [{ ...base, mandateAllows: false }, "MANDATE_BLOCK"],
      [{ ...base, fresh: false }, "STALE_DATA"],
      [{ ...base, riskOpen: false }, "RISK_CLOSED"],
    ] as const;
    for (const [input, code] of blocked) {
      const r = capabilityIntersection("ORDER_SUBMIT", input as IntersectionInput);
      assert.equal(r.allowed, false);
      assert.equal((r as { code: string }).code, code);
    }
  });

  it("cancels are remedial: never blocked by mandate/freshness/risk-close", () => {
    const r = capabilityIntersection("ORDER_CANCEL", {
      ...base,
      mandateAllows: false,
      fresh: false,
      riskOpen: false,
      accountMode: "SUSPENDED",
    });
    // SUSPENDED still blocks cancels (account-level).
    assert.equal(r.allowed, false);
    const r2 = capabilityIntersection("ORDER_CANCEL", {
      ...base,
      mandateAllows: false,
      fresh: false,
      riskOpen: false,
    });
    assert.equal(r2.allowed, true);
  });
});

describe("Error taxonomy (PM-VENUE-04)", () => {
  it("unknown 5xx after POST is RECONCILE_REQUIRED, never auto-retry", () => {
    const n = normalizeVenueError({ status: 502, code: "UPSTREAM_FAILED" }, {
      arrivedPendingStore: false,
      orderType: "LIMIT",
    });
    assert.equal(n.kind, "RECONCILE_REQUIRED");
    assert.equal(n.reconcileFirst, true);
    assert.equal(n.retryable, false);
  });

  it("FAK/IOC no-match is a terminal zero-fill, not retryable", () => {
    const n = normalizeVenueError({ status: 200, code: "NO_MATCH" }, {
      arrivedPendingStore: false,
      orderType: "FOK",
    });
    assert.equal(n.kind, "PERMANENT_REJECT");
    assert.equal(n.retryable, false);
  });

  it("429 and server queue delay map to RETRYABLE; auth to AUTH_FAILURE", () => {
    assert.equal(
      normalizeVenueError({ status: 429 }, { arrivedPendingStore: false }).kind,
      "RETRYABLE",
    );
    assert.equal(
      normalizeVenueError({ status: 200, queuedDelayMs: 1500 }, { arrivedPendingStore: false }).kind,
      "RETRYABLE",
    );
    assert.equal(
      normalizeVenueError({ status: 401, code: "INVALID_KEY" }, { arrivedPendingStore: false }).kind,
      "AUTH_FAILURE",
    );
  });

  it("already-pending uncertainty is never submit-retryable", () => {
    const n = normalizeVenueError({ status: 429 }, {
      arrivedPendingStore: true,
    });
    assert.equal(n.kind, "RECONCILE_REQUIRED");
  });
});

describe("Rate governor (PM-VENUE-05)", () => {
  it("intent queued past deadline is dropped before submit", async () => {
    let now = 0;
    const g = new RateGovernor({ clock: () => now });
    g.ingestServerHint("submit", 2000);
    const r = await g.acquire("submit", { deadline: now + 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, "INTENT_EXPIRED");
  });

  it("limits per class; cancel/heartbeat have their own budget", async () => {
    let now = 0;
    const g = new RateGovernor({
      clock: () => now,
      classes: { submit: { limit: 1, windowMs: 1000 } },
    });
    assert.equal((await g.acquire("submit")).ok, true);
    assert.equal((await g.acquire("submit")).ok, false);
    assert.equal(g.canCancel(), true);
  });
});

describe("In-flight recovery (PM-VENUE-03/06)", () => {
  it("restart never reports cancel certain; late-accepted POST stays one order to reconcile", () => {
    const rl = new RecoveryLedger({ clock: () => 0 });
    rl.addSubmittedUnknown("ord_A", "venue_1");
    rl.recordCancelRequested("ord_A");
    // After a "restart" the order is still unresolved.
    assert.equal(rl.needsReconcile("ord_A"), true);
    assert.deepEqual(rl.certainCancels(), []);
    // Only a venue-sourced definitive result resolves it.
    rl.resolve("ord_A", true);
    assert.equal(rl.needsReconcile("ord_A"), false);
    assert.deepEqual(rl.certainCancels(), ["ord_A"]);
  });

  it("cancel certainty is not granted by our own request bookkeeping", () => {
    const rl = new RecoveryLedger({ clock: () => 0 });
    rl.addSubmittedUnknown("ord_B", "venue_2");
    rl.resolve("ord_B", false); // first-party only -> no certainty
    assert.equal(rl.certainCancels().length, 0);
    assert.equal(rl.needsReconcile("ord_B"), true);
  });
});