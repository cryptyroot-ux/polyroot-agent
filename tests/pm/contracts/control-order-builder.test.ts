import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSignedOrder, type OrderBuildInput } from "@polyroot/control";
import { SignerVault, computePayloadHash } from "@polyroot/signer";
import type {
  ExecutionPermit,
  SignedOrder,
  TradeIntent,
  WalletIdentity,
} from "@polyroot/domain";
import { ulid } from "ulid";

function makeWallet(over: Partial<WalletIdentity> = {}): WalletIdentity {
  return {
    schema_version: "1.1",
    wallet_id: ulid(),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    chain_id: 137,
    verified_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  return {
    schema_version: "1.1",
    permit_id: ulid(),
    decision_id: ulid(),
    intent_id: ulid(),
    ledger_version: "0003",
    policy_version: "v0-bootstrap",
    policy_hash: "ph_audited",
    quote_id: "quote_x",
    lease_epoch: 1,
    reservation_ids: ["res_1"],
    max_qty: 100,
    max_cash: 50,
    allowed_order_style: ["LIMIT", "POST_ONLY"],
    venue_mode: "NORMAL",
    issued_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: new Date("2026-01-01T00:01:00Z"),
    single_use: true,
    used_at: null,
    ...over,
  };
}

function makeIntent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schema_version: "1.1",
    intent_id: ulid(),
    dedupe_key: "dk_1",
    purpose: "ENTRY",
    market_id: "mkt_1",
    side: "BUY",
    desired_qty: 10,
    limit_price: 0.5,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function buildInput(over: Partial<OrderBuildInput> = {}): OrderBuildInput {
  return {
    intent: makeIntent(),
    permit: makePermit(),
    wallet: makeWallet(),
    venueMode: "NORMAL",
    now: new Date("2026-01-01T00:00:30Z"),
    ...over,
  };
}

function signer(cryptoSigner = async () => "sig_ctrl"): SignerVault {
  return new SignerVault({ cryptoSigner });
}

describe("Control — order builder (buildSignedOrder)", () => {
  it("builds a signed order inside permit bounds", async () => {
    const vault = signer();
    const permit = makePermit();
    const res = await buildSignedOrder(buildInput({ permit }), vault);
    assert.equal(res.ok, true);
    if (res.ok) {
      const o = res.order;
      assert.equal(o.market_id, "mkt_1");
      assert.equal(o.side, "BUY");
      assert.ok(Math.abs(o.price - 0.5) < 1e-9);
      assert.ok(Math.abs(o.size - 10) < 1e-9);
      assert.equal(o.signature, "sig_ctrl");
      assert.equal(o.signer, "0xSIGNER");
      assert.equal(o.permit_id, permit.permit_id);
      assert.equal(o.decision_id, permit.decision_id);
    }
  });

  it("clamps the size down to the permit share quota", async () => {
    const vault = signer();
    const permit = makePermit({ max_qty: 100, max_cash: 5000 });
    const res = await buildSignedOrder(
      buildInput({ permit, intent: makeIntent({ desired_qty: 200, limit_price: 0.1 }) }),
      vault,
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(Math.abs(res.order.size - 100) < 1e-9);
  });

  it("clamps the size down to the permit cash ceiling", async () => {
    const vault = signer();
    const permit = makePermit({ max_qty: 100, max_cash: 50 });
    const res = await buildSignedOrder(
      buildInput({ permit, intent: makeIntent({ desired_qty: 100, limit_price: 1.0 }) }),
      vault,
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.ok(Math.abs(res.order.size - 50) < 1e-9);
  });

  it("records the exact permit payload hash on the sign request", async () => {
    const permit = makePermit();
    let seenHash: string | undefined;
    let seenRequest: any = undefined;
    const vault = signer(async (req) => {
      seenHash = req.payloadHash;
      seenRequest = { ...req, payloadHash: "" }; // Create copy with placeholder
      return "sig_ctrl";
    });
    const res = await buildSignedOrder(buildInput({ permit }), vault);
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("Failed to build order");

    // Verify the payloadHash was computed correctly
    assert.equal(typeof seenHash, "string");
    assert.equal(seenHash.length, 64);
    assert.equal(/^[0-9a-f]{64}$/.test(seenHash), true);

    // Recompute what the hash should be (without the actual payloadHash)
    const expectedHash = computePayloadHash(seenRequest);
    assert.equal(seenHash, expectedHash);
  });

  it("surfaces a low-level signing failure", async () => {
    const vault = signer(async () => {
      throw new Error("hsm offline");
    });
    const res = await buildSignedOrder(buildInput(), vault);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "SIGN_ENGINE_ERROR");
  });

  it("refuses without a price in the intent", async () => {
    const vault = signer();
    const res = await buildSignedOrder(
      buildInput({ intent: makeIntent({ limit_price: undefined, price: undefined }) }),
      vault,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PRICE_REQUIRED");
  });

  it("refuses without a size or notional in the intent", async () => {
    const vault = signer();
    const res = await buildSignedOrder(
      buildInput({
        intent: makeIntent({ desired_qty: undefined, desired_notional: undefined }),
      }),
      vault,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "SIZE_REQUIRED");
  });
});