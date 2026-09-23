import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHeartbeatRequest,
  checkHeartbeatScope,
  validateRedeemTarget,
} from "@polyroot/venue";
import { applyStreamDelta, reconnectFrame } from "@polyroot/data";
import {
  applySettlementEvent,
  applyReorgCorrection,
  initialSettlement,
} from "@polyroot/ledger";

describe("Phase 20 CT-21: heartbeat route carries auth + id (PM-EXE-07)", () => {
  it("builds POST /v1/heartbeats with auth and carried-forward id", () => {
    const r = buildHeartbeatRequest({
      auth: "Bearer test",
      previousId: "hb_9",
      accounts: ["0xA"],
      orderIds: ["o1"],
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.request.method, "POST");
    assert.equal(r.request.path, "/v1/heartbeats");
    assert.equal(r.request.body.heartbeat_id, "hb_9");
  });
  it("missing auth and empty ids refuse (re-establish instead)", () => {
    assert.equal(
      buildHeartbeatRequest({ auth: "", previousId: "hb_9" }).ok,
      false,
    );
    const empty = buildHeartbeatRequest({ auth: "Bearer t", previousId: "" });
    assert.equal(empty.ok, false);
  });
});

describe("Phase 20 CT-22: heartbeat lifetime/scope (PM-EXE-07)", () => {
  const base = {
    issuedAt: new Date("2026-01-01T00:00:00Z"),
    ttlMs: 60_000,
    writerId: "w_1",
    expectedWriterId: "w_1",
    accountCount: 1,
    orderCount: 2,
    now: new Date("2026-01-01T00:00:30Z"),
  };
  it("live heartbeat with coverage passes", () => {
    assert.equal(checkHeartbeatScope(base).ok, true);
  });
  it("expired, conflicted and empty-scope heartbeats refuse distinctly", () => {
    const expired = checkHeartbeatScope({
      ...base,
      now: new Date("2026-01-01T00:05:00Z"),
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.code, "HEARTBEAT_EXPIRED");
    const conflict = checkHeartbeatScope({ ...base, writerId: "w_2" });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "HEARTBEAT_WRITER_CONFLICT");
    const empty = checkHeartbeatScope({
      ...base,
      accountCount: 0,
      orderCount: 0,
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "HEARTBEAT_SCOPE_EMPTY");
  });
});

describe("Phase 20 CT-23: stream ordering/replay/reconnect (PM-DATA-03)", () => {
  it("in-order deltas apply; duplicates are idempotent no-ops", () => {
    const frame = { lastAppliedSeq: 10, gapDetected: false };
    const first = applyStreamDelta(frame, 11);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("expected ok");
    assert.equal(first.applied, true);
    assert.equal(first.lastAppliedSeq, 11);
    const dup = applyStreamDelta(
      { lastAppliedSeq: 11, gapDetected: false },
      11,
    );
    assert.equal(dup.ok, true);
    if (dup.ok) assert.equal(dup.applied, false);
  });
  it("missing sequences and open gaps refuse; only snapshots recover", () => {
    assert.equal(
      applyStreamDelta({ lastAppliedSeq: 10, gapDetected: false }, 12).ok,
      false,
    );
    assert.equal(
      applyStreamDelta({ lastAppliedSeq: 10, gapDetected: true }, 11).ok,
      false,
    );
    assert.equal(
      reconnectFrame({ snapshotSeq: null, reconnectAt: 99 }).ok,
      false,
    );
    const recovered = reconnectFrame({ snapshotSeq: 20, reconnectAt: 99 });
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.lastAppliedSeq, 20);
  });
});

describe("Phase 20 CT-26: settlement MINED/RETRYING + reorg (PM-LED-03)", () => {
  it("MATCHED -> MINED -> RETRYING -> CONFIRMED is a legal path", () => {
    let s = initialSettlement();
    for (const kind of ["MATCH", "MINE", "RETRY", "MINE", "CONFIRM"] as const) {
      const r = applySettlementEvent(s, { kind, entry: `J_${kind}` });
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("expected ok");
      s = r.state;
    }
    assert.equal(s.status, "CONFIRMED");
    assert.equal(s.spendable, true);
  });
  it("reorg on CONFIRMED posts correction and revokes spendability", () => {
    let s = initialSettlement();
    for (const kind of ["MATCH", "MINE", "CONFIRM"] as const) {
      const r = applySettlementEvent(s, { kind, entry: `J_${kind}` });
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("expected ok");
      s = r.state;
    }
    const reorg = applyReorgCorrection(s, "J_FIX");
    assert.equal(reorg.ok, true);
    if (!reorg.ok) throw new Error("expected ok");
    assert.equal(reorg.state.status, "FAILED");
    assert.equal(reorg.state.spendable, false);
    assert.ok(reorg.state.journal.includes("REORG_CORRECT:J_FIX"));
  });
  it("reorg on non-CONFIRMED refuses (no silent rewrite)", () => {
    const r = applyReorgCorrection(initialSettlement(), "J_X");
    assert.equal(r.ok, false);
  });
});

describe("Phase 20 CT-27: redeem flow (PM-EXE-08)", () => {
  const base = {
    resolutionFinal: true,
    disputed: false,
    version: "V2",
    assetKind: "CTF",
    hasReceipt: true,
  };
  it("final undisputed CTF with receipt redeems", () => {
    const r = validateRedeemTarget(base);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.target, "CTF");
  });
  it("non-final, disputed, blocked-profile and missing-receipt all refuse distinctly", () => {
    assert.equal(
      validateRedeemTarget({ ...base, resolutionFinal: false }).ok,
      false,
    );
    const disputed = validateRedeemTarget({ ...base, disputed: true });
    assert.equal(disputed.ok, false);
    if (!disputed.ok) assert.equal(disputed.code, "REDEEM_DISPUTED");
    const profile = validateRedeemTarget({ ...base, version: "V1" });
    assert.equal(profile.ok, false);
    if (!profile.ok) assert.equal(profile.code, "REDEEM_PROFILE_BLOCKED");
    const receipt = validateRedeemTarget({ ...base, hasReceipt: false });
    assert.equal(receipt.ok, false);
    if (!receipt.ok) assert.equal(receipt.code, "REDEEM_NO_RECEIPT");
  });
});
