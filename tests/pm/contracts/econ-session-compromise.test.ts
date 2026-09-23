import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributeBuilder,
  postConfirmedIncentive,
} from "@polyroot/ledger";
import {
  initRevocationTracker,
  markRevoked,
  isFullyRevoked,
} from "@polyroot/risk";
import {
  grantSessionScope,
  checkRevocationFinality,
  MAX_SESSION_LIFETIME_MS,
} from "@polyroot/signer";

describe("Phase 21 CT-28: builder attribution preserves economics (PM-PROTO-06)", () => {
  it("attribution carries amounts untouched; missing code refuses", () => {
    const order = { orderId: "o1", cashBase: 1_000_000n, feeBase: 2_000n };
    const r = attributeBuilder(order, "builder_xyz");
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.attribution.cashBase, 1_000_000n);
    assert.equal(r.attribution.feeBase, 2_000n);
    assert.equal(r.attribution.builderCode, "builder_xyz");
    const missing = attributeBuilder(order, "");
    assert.equal(missing.ok, false);
  });
});

describe("Phase 21 CT-29: incentive categories with confirmed asset (PM-ECON-03)", () => {
  it("each category posts only when CONFIRMED_PAID in the confirmed asset", () => {
    for (const category of [
      "MAKER_REBATE",
      "LP_REWARD",
      "TAKER_INCENTIVE",
    ] as const) {
      const r = postConfirmedIncentive(
        {
          category,
          amountBase: 500n,
          asset: "pUSD",
          state: "CONFIRMED_PAID",
          provenance: "venue_receipt_1",
        },
        "pUSD",
        1000n,
      );
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.confirmedTotal, 1500n);
    }
  });
  it("expected amounts and wrong-asset postings never touch confirmed books", () => {
    const base = {
      category: "MAKER_REBATE",
      amountBase: 500n,
      asset: "pUSD",
      provenance: "estimate",
    } as const;
    assert.equal(
      postConfirmedIncentive({ ...base, state: "EXPECTED" }, "pUSD", 1000n).ok,
      false,
    );
    const wrongAsset = postConfirmedIncentive(
      { ...base, state: "CONFIRMED_PAID", asset: "USDC" },
      "pUSD",
      1000n,
    );
    assert.equal(wrongAsset.ok, false);
  });
});

describe("Phase 21 CT-30: revocation per-domain with open orders listed (PM-SEC-08)", () => {
  it("API revoke does not auto-revoke session/approval; partial failure persists", () => {
    let t = initRevocationTracker(["o_open_1"]);
    assert.equal(isFullyRevoked(t), false);
    const api = markRevoked(t, "api", true);
    assert.equal(api.ok, true);
    if (!api.ok) throw new Error("expected ok");
    t = api.tracker;
    assert.equal(isFullyRevoked(t), false);
    const sessFail = markRevoked(t, "session", false);
    assert.equal(sessFail.ok, true);
    if (!sessFail.ok) throw new Error("expected ok");
    t = sessFail.tracker;
    assert.equal(isFullyRevoked(t), false);
    assert.deepEqual(t.openOrders, ["o_open_1"]);
    const sess = markRevoked(t, "session", true);
    assert.equal(sess.ok, true);
    if (!sess.ok) throw new Error("expected ok");
    const appr = markRevoked(sess.tracker, "approval", true);
    assert.equal(appr.ok, true);
    if (!appr.ok) throw new Error("expected ok");
    assert.equal(isFullyRevoked(appr.tracker), true);
    assert.deepEqual(appr.tracker.openOrders, ["o_open_1"]);
  });
  it("unknown domains refuse instead of creating new tracks", () => {
    const r = markRevoked(initRevocationTracker(), "root", true);
    assert.equal(r.ok, false);
  });
});

describe("Phase 21 CT-31: session scope beta (PM-WALLET-10)", () => {
  it("allowlisted scopes with explicit bounded lifetime grant", () => {
    const r = grantSessionScope({
      scopes: ["SIGN_ORDERS", "READ"],
      lifetimeMs: 600_000,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(
      r.expiresAt.getTime(),
      new Date("2026-01-01T00:00:00Z").getTime() + 600_000,
    );
  });
  it("non-allowlisted scopes and custom lifetime assumptions refuse", () => {
    const scope = grantSessionScope({ scopes: ["WITHDRAW"], lifetimeMs: 1000 });
    assert.equal(scope.ok, false);
    for (const bad of [0, -5, MAX_SESSION_LIFETIME_MS + 1, Number.NaN]) {
      const r = grantSessionScope({ scopes: ["READ"], lifetimeMs: bad });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "LIFETIME_ASSUMPTION_REJECTED");
    }
  });
  it("revocation finality needs an explicit receipt", () => {
    assert.equal(checkRevocationFinality({ receiptId: null }).final ?? false, false);
    const done = checkRevocationFinality({ receiptId: "rcpt_1" });
    assert.equal(done.final, true);
  });
});

describe("No.3 coverage: negative incentive amounts refuse", () => {
  it("negative postings never touch confirmed books", async () => {
    const { postConfirmedIncentive } = await import("@polyroot/ledger");
    const r = postConfirmedIncentive(
      {
        category: "LP_REWARD",
        amountBase: -10n,
        asset: "pUSD",
        state: "CONFIRMED_PAID",
        provenance: "x",
      },
      "pUSD",
      100n,
    );
    assert.equal(r.ok, false);
  });
});
