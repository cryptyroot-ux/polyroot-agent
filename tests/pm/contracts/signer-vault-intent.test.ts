import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignerVault, computePayloadHash } from "@polyroot/signer";
import type { ExecutionPermit, WalletIdentity } from "@polyroot/domain";
import { randomUUID } from "crypto";

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  const base: ExecutionPermit = {
    schema_version: "1.1",
    permit_id: randomUUID(),
    decision_id: randomUUID(),
    intent_id: randomUUID(),
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
  };
  return { ...base, ...over };
}

function makeWallet(): WalletIdentity {
  return {
    schema_version: "1.1",
    wallet_id: randomUUID(),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    chain_id: 137,
    verified_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function buildReq(permit: ExecutionPermit, intentId: string): any {
  const req: any = {
    schema_version: "1.1",
    action: "ORDER_SUBMIT" as const,
    permit,
    wallet: makeWallet(),
    amountBase: 10_000_000n,
    actionId: "act_1",
    intentId,
    marketContext: "mkt_1",
    venueMode: "NORMAL" as const,
    now: new Date("2026-01-01T00:00:30Z"),
    side: "BUY" as const,
    priceBase: 500_000n,
    policyHash: permit.policy_hash,
    quoteId: permit.quote_id,
    expectedChainId: 137,
    expectedLeaseEpoch: permit.lease_epoch,
  };
  req.payloadHash = computePayloadHash(req);
  return req;
}

const vault = () =>
  new SignerVault({
    maxClockSkewMs: 5000,
    expectedChainId: 137,
    cryptoSigner: async (r) => `sig_${r.actionId}`,
  });

describe("Signer Vault — Intent Mismatch Verification (task 01a107f0)", () => {
  it("1. intentId = permit.intent_id + 1 (wrong) → INTENT_MISMATCH", async () => {
    const permit = makePermit();
    const wrongIntent = `${permit.intent_id}-tampered`; // simulates +1 mismatch
    const req = buildReq(permit, wrongIntent);
    const res = await vault().sign(req);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "INTENT_MISMATCH");
      console.log(
        `CASE1 intentId=${req.intentId} permit.intent_id=${permit.intent_id} code=${res.code} reason=${res.reason}`,
      );
    }
  });

  it("2. intentId == permit.intent_id (correct) → sign ok", async () => {
    const permit = makePermit();
    const req = buildReq(permit, permit.intent_id);
    const res = await vault().sign(req);
    assert.equal(res.ok, true);
    if (res.ok) {
      console.log(
        `CASE2 intentId=${req.intent_id} permit.intent_id=${permit.intent_id} signature=${res.signature}`,
      );
    }
  });
});
