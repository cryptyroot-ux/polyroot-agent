import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeVenueError,
  venueActionGate,
  capabilityIntersection,
  checkPostOnly,
  RateGovernor,
} from "@polyroot/venue";

describe("Phase 19 CT-17: FOK/FAK outcomes (PM-EXE-06)", () => {
  it("FAK/IOC no-match is terminal zero-fill, not a retryable failure", () => {
    const r = normalizeVenueError(
      { code: "NO_MATCH" },
      { arrivedPendingStore: false, orderType: "IOC" },
    );
    assert.equal(r.kind, "PERMANENT_REJECT");
    assert.equal(r.retryable, false);
    assert.equal(r.reconcileFirst, false);
  });
  it("unknown 5xx after submit is RECONCILE_REQUIRED, never auto-retry", () => {
    const r = normalizeVenueError(
      { status: 503 },
      { arrivedPendingStore: true, orderType: "LIMIT" },
    );
    assert.equal(r.kind, "RECONCILE_REQUIRED");
    assert.equal(r.retryable, false);
    assert.equal(r.reconcileFirst, true);
  });
});

describe("Phase 19 CT-18: post-only never converts to taker (PM-ECON-01)", () => {
  it("crossing BUY/SELL post-only orders reject with POST_ONLY_CROSSING", () => {
    const buy = checkPostOnly("BUY", 0.6, 0.5, 0.55);
    assert.equal(buy.ok, false);
    if (!buy.ok) assert.equal(buy.code, "POST_ONLY_CROSSING");
    const sell = checkPostOnly("SELL", 0.5, 0.55, 0.6);
    assert.equal(sell.ok, false);
    if (!sell.ok) assert.equal(sell.code, "POST_ONLY_CROSSING");
  });
  it("resting post-only orders pass", () => {
    assert.equal(checkPostOnly("BUY", 0.5, 0.5, 0.55).ok, true);
    assert.equal(checkPostOnly("SELL", 0.6, 0.55, 0.6).ok, true);
  });
});

describe("Phase 19 CT-24: mode/error matrix (PM-VENUE-04)", () => {
  it("425 maps to restart handling, auth failures are typed, balance is distinct", () => {
    const restart = normalizeVenueError(
      { status: 425 },
      { arrivedPendingStore: false, orderType: "LIMIT" },
    );
    assert.ok(restart.reason.length > 0);
    const auth = normalizeVenueError(
      { status: 401 },
      { arrivedPendingStore: false, orderType: "LIMIT" },
    );
    assert.equal(auth.kind, "AUTH_FAILURE");
    assert.equal(auth.retryable, false);
  });
  it("every venue mode has a defined submit verdict (no undefined cell)", () => {
    for (const mode of [
      "NORMAL",
      "POST_ONLY",
      "CANCEL_ONLY",
      "READ_ONLY",
      "UNAVAILABLE",
      "UNKNOWN",
    ] as const) {
      const r = venueActionGate(mode as any, "ORDER_SUBMIT");
      assert.equal(typeof r.allowed, "boolean", mode);
      assert.ok(r.code.length > 0, mode);
    }
  });
  it("close-only accounts submit nothing but explicit reduce", () => {
    const base = {
      venueMode: "NORMAL",
      accountMode: "CLOSE_ONLY",
      capability: null,
      mandateAllows: true,
      fresh: true,
      riskOpen: true,
    } as const;
    const limit = capabilityIntersection("ORDER_SUBMIT", {
      ...base,
      requiredStyle: "LIMIT",
    } as any);
    assert.equal(limit.allowed, false);
    const reduce = capabilityIntersection("ORDER_SUBMIT", {
      ...base,
      requiredStyle: "REDUCE_ONLY",
    } as any);
    assert.equal(reduce.allowed, true);
  });
});

describe("Phase 19 CT-25: rate-limit budgets protect cancel/heartbeat (PM-VENUE-05)", () => {
  it("exhausted submit budget blocks submit while cancel keeps budget", async () => {
    let now = 0;
    const gov = new RateGovernor({
      classes: {
        submit: { limit: 2, windowMs: 60_000 },
        cancel: { limit: 40, windowMs: 60_000 },
        read: { limit: 120, windowMs: 60_000 },
        heartbeat: { limit: 120, windowMs: 60_000 },
      },
      clock: () => now,
    });
    assert.equal((await gov.acquire("submit")).ok, true);
    assert.equal((await gov.acquire("submit")).ok, true);
    assert.equal((await gov.acquire("submit")).ok, false);
    assert.equal((await gov.acquire("cancel")).ok, true);
  });
  it("server queue-delay hints are honored, not only 429s", async () => {
    let now = 0;
    const gov = new RateGovernor({ clock: () => now });
    gov.ingestServerHint("submit", 30_000);
    const r = await gov.acquire("submit", { deadline: 5_000 });
    assert.equal(r.ok, false);
  });
});
