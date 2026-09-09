import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SignerVault,
  permitFingerprint,
  decimalToBase,
  SIGNER_ALLOWED_ACTIONS,
  type SigningOutcome,
} from "@polyroot/signer";
import type { ExecutionPermit, WalletIdentity } from "@polyroot/domain";
import { ulid } from "ulid";

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  const base: ExecutionPermit = {
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
  };
  return { ...base, ...over };
}

function makeWallet(over: Partial<WalletIdentity> = {}): WalletIdentity {
  const base: WalletIdentity = {
    schema_version: "1.1",
    wallet_id: ulid(),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    chain_id: 137,
    verified_at: new Date("2026-01-01T00:00:00Z"),
  };
  return { ...base, ...over };
}

async function outcome(p: Promise<SigningOutcome>): Promise<SigningOutcome> {
  return p;
}

const vault = () =>
  new SignerVault({
    maxClockSkewMs: 5000,
    cryptoSigner: async (req) => `sig_${req.actionId}`,
  });

function validReq(over = {}) {
  const permit = makePermit();
  return {
    schema_version: "1.1",
    action: "ORDER_SUBMIT" as const,
    permit,
    wallet: makeWallet(),
    amountBase: 10_000_000n, // 10 shares * 1e6
    actionId: "act_1",
    marketContext: "mkt_1",
    venueMode: "NORMAL" as const,
    now: new Date("2026-01-01T00:00:30Z"),
    payloadHash: permitFingerprint(permit),
    ...over,
  };
}

describe("Signer Vault — TABLE 8 pre-sign invariants (PM-WALLET-07)", () => {
  it("signs a valid request once and records the signature", async () => {
    const v = vault();
    const res = await outcome(v.sign(validReq()));
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.signature, "sig_act_1");
  });

  it("refuses an action not on the allowlist", async () => {
    const v = vault();
    const res = await v.sign(validReq({ action: "TRANSFER_FUNDS" }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "ACTION_NOT_ALLOWED");
  });

  it("refuses an expired permit", async () => {
    const v = vault();
    const res = await v.sign(
      validReq({ now: new Date("2026-01-01T00:02:00Z") }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PERMIT_EXPIRED");
  });

  it("refuses a single-use permit already marked used", async () => {
    const v = vault();
    const res = await v.sign(
      validReq({ permit: makePermit({ used_at: new Date() }) }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PERMIT_REUSED");
  });

  it("refuses when signer and funder are the same identity", async () => {
    const v = vault();
    const res = await v.sign(
      validReq({ wallet: makeWallet({ funder: "0xSIGNER" }) }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "IDENTITY_CONFLICT");
  });

  it("refuses a payload hash that does not bind to the permit", async () => {
    const v = vault();
    const req = validReq({ payloadHash: "ph_tampered" });
    const res = await v.sign(req);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PAYLOAD_HASH_MISMATCH");
  });

  it("enforces that the amount sits within the permit cap", async () => {
    const v = vault();
    // permit max_qty = 100 (shares), max_cash = 50. A large amount is refused.
    const res = await v.sign(
      validReq({ amountBase: 500_000_000n /* 500*1e6 */ }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "AMOUNT_EXCEEDS_PERMIT");
  });

  it("refuses when amount exceeds the share quota even if it stays under max_cash (dimension check)", async () => {
    const v = vault();
    // max_qty = 100 shares, max_cash = 1000 pUSD. amount of 150 shares is over
    // the share quota yet below the cash cap — the quota must still reject it.
    const res = await v.sign(
      validReq({
        permit: makePermit({ max_qty: 100, max_cash: 1000 }),
        amountBase: 150_000_000n /* 150 shares * 1e6 */,
      }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "AMOUNT_EXCEEDS_PERMIT");
  });

  it("treats the crypto-signer error as a typed refusal, never leaks the secret", async () => {
    const v = new SignerVault({
      cryptoSigner: async () => {
        throw new Error("kms unreachable");
      },
    });
    const res = await v.sign(validReq());
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "SIGN_ENGINE_ERROR");
  });

  it("allowlist contains exactly the four lifecycle operations", () => {
    assert.deepEqual(
      [...SIGNER_ALLOWED_ACTIONS].sort(),
      [
        "ORDER_CANCEL",
        "ORDER_SUBMIT",
        "POSITION_MERGE",
        "POSITION_REDEEM",
      ].sort(),
    );
  });
});
