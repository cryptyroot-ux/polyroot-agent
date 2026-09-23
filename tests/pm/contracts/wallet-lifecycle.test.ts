import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceWalletLifecycle } from "@polyroot/control";

describe("Phase 26: wallet lifecycle happy paths (Blueprint §5)", () => {
  it("absent wallet flows DISCOVERING → READY on receipts", () => {
    let s = "DISCOVERING" as const;
    const steps = [
      { kind: "DISCOVERED", exists: false },
      { kind: "AUTHORIZE_SETUP", ownerAuth: "sig_owner" },
      { kind: "CREATED", txReceipt: "tx_1" },
      { kind: "DEPLOYED", confirmationReceipt: "rcpt_1" },
      { kind: "APPROVALS_SUBMITTED" },
      { kind: "APPROVALS_VERIFIED" },
    ] as const;
    const expect = [
      "ABSENT",
      "SETUP_AUTHORIZED",
      "CREATING",
      "DEPLOYED",
      "APPROVAL_PENDING",
      "READY",
    ];
    steps.forEach((ev, i) => {
      const r = advanceWalletLifecycle(s as any, ev as any);
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("expected ok");
      s = r.state as typeof s;
      assert.equal(s, expect[i]);
    });
  });

  it("existing wallet skips creation but still needs authorization", () => {
    const found = advanceWalletLifecycle("DISCOVERING", {
      kind: "DISCOVERED",
      exists: true,
    });
    assert.equal(found.ok, true);
    if (!found.ok) throw new Error("expected ok");
    assert.equal(found.state, "EXISTING");
    const noAuth = advanceWalletLifecycle("EXISTING", {
      kind: "AUTHORIZE_SETUP",
      ownerAuth: "",
    });
    assert.equal(noAuth.ok, false);
  });
});

describe("Phase 26: lifecycle fail-closed properties", () => {
  it("creation/deployment without receipts refuse", () => {
    assert.equal(
      advanceWalletLifecycle("SETUP_AUTHORIZED", {
        kind: "CREATED",
        txReceipt: "",
      } as any).ok,
      false,
    );
    assert.equal(
      advanceWalletLifecycle("CREATING", {
        kind: "DEPLOYED",
        confirmationReceipt: "",
      } as any).ok,
      false,
    );
  });

  it("skipped steps refuse (no jumping DISCOVERING → READY)", () => {
    const r = advanceWalletLifecycle("DISCOVERING", {
      kind: "APPROVALS_VERIFIED",
    } as any);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ILLEGAL_LIFECYCLE_TRANSITION");
  });

  it("network failure surfaces UNKNOWN; only REDISCOVER exits it", () => {
    const u = advanceWalletLifecycle("CREATING", { kind: "NETWORK_FAILURE" });
    assert.equal(u.ok, true);
    if (!u.ok) throw new Error("expected ok");
    assert.equal(u.state, "UNKNOWN");
    assert.equal(
      advanceWalletLifecycle("UNKNOWN", { kind: "APPROVALS_VERIFIED" } as any)
        .ok,
      false,
    );
    const re = advanceWalletLifecycle("UNKNOWN", { kind: "REDISCOVER" });
    assert.equal(re.ok, true);
    if (re.ok) assert.equal(re.state, "DISCOVERING");
  });

  it("BLOCKED is terminal; FAILED resets only to DISCOVERING", () => {
    const b = advanceWalletLifecycle("READY", {
      kind: "BLOCK",
      reason: "compromise",
    });
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.state, "BLOCKED");
    assert.equal(
      advanceWalletLifecycle("BLOCKED", { kind: "RESET" }).ok,
      false,
    );
    const f = advanceWalletLifecycle("READY", {
      kind: "FAIL",
      reason: "rpc down",
    });
    assert.equal(f.ok, true);
    const reset = advanceWalletLifecycle("FAILED", { kind: "RESET" });
    assert.equal(reset.ok, true);
    if (reset.ok) assert.equal(reset.state, "DISCOVERING");
  });
});
