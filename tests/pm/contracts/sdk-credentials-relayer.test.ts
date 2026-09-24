import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import {
  discoverWallet,
  reconcileWalletCreate,
  checkApprovalCall,
  checkRelayerNonce,
} from "@polyroot/control";
import { verifyBodyHmac, checkCredentialBinding } from "@polyroot/signer";

describe("Phase 18 CT-07: deposit discover + idempotent create (PM-WALLET-04)", () => {
  it("existing vs absent wallets map explicitly; absent fabricates nothing", () => {
    const found = discoverWallet("0xWALLET");
    assert.equal(found.presence, "EXISTING");
    assert.equal(found.address, "0xWALLET");
    const missing = discoverWallet(null);
    assert.equal(missing.presence, "ABSENT");
    assert.equal(missing.address, null);
  });
  it("create on absent yields the address; create on existing reconciles", () => {
    const created = reconcileWalletCreate(discoverWallet(null), "0xNEW");
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("expected ok");
    assert.equal(created.created, true);
    const same = reconcileWalletCreate(discoverWallet("0xNEW"), "0xNEW");
    assert.equal(same.ok, true);
    if (!same.ok) throw new Error("expected ok");
    assert.equal(same.created, false);
  });
  it("create naming a different address than recorded conflicts", () => {
    const r = reconcileWalletCreate(discoverWallet("0xA"), "0xB");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "CREATE_CONFLICT");
  });
});

describe("Phase 18 CT-08: approval caller/spender (PM-WALLET-05)", () => {
  const base = {
    caller: "0xACCOUNT",
    accountWallet: "0xACCOUNT",
    spender: "0xSPENDER",
    intendedSpender: "0xSPENDER",
    tokenStandard: "ERC20",
  } as const;
  it("correct caller + spender passes for ERC20 and ERC1155", () => {
    assert.equal(checkApprovalCall(base).ok, true);
    assert.equal(
      checkApprovalCall({ ...base, tokenStandard: "ERC1155" }).ok,
      true,
    );
  });
  it("wrong caller and wrong spender are distinct typed refusals", () => {
    const caller = checkApprovalCall({ ...base, caller: "0xINTRUDER" });
    assert.equal(caller.ok, false);
    if (!caller.ok) assert.equal(caller.code, "WRONG_CALLER");
    const spender = checkApprovalCall({ ...base, spender: "0xEVIL" });
    assert.equal(spender.ok, false);
    if (!spender.ok) assert.equal(spender.code, "WRONG_SPENDER");
  });
});

describe("Phase 18 CT-09: L1/L2 credential auth (PM-WALLET-06)", () => {
  const secret = "test-secret";
  const body = '{"action":"place","nonce":7}';
  const tag = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  it("valid typed HMAC authenticates; tampered body/tag refuse", () => {
    assert.equal(verifyBodyHmac(secret, body, tag).ok, true);
    assert.equal(verifyBodyHmac(secret, body + "x", tag).ok, false);
    const bad = verifyBodyHmac(secret, body, "00".repeat(32));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "HMAC_MISMATCH");
  });
  it("credentials bind to exactly one signer", () => {
    const cred = { credentialId: "cred_1", boundSignerAddress: "0xSIGNER" };
    assert.equal(checkCredentialBinding(cred, "0xSIGNER").ok, true);
    assert.equal(checkCredentialBinding(cred, "0xsigner").ok, true);
    const cross = checkCredentialBinding(cred, "0xOTHER");
    assert.equal(cross.ok, false);
    if (!cross.ok) assert.equal(cross.code, "SIGNER_NOT_BOUND");
  });
});

describe("Phase 18 CT-10: relayer nonce conflicts (PM-WALLET-04)", () => {
  it("nonces advance by exactly one; replay and jump refuse distinctly", () => {
    assert.equal(checkRelayerNonce(null, 0).ok, true);
    assert.equal(checkRelayerNonce(7, 8).ok, true);
    const replay = checkRelayerNonce(7, 7);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.code, "NONCE_REPLAY");
    const jump = checkRelayerNonce(7, 9);
    assert.equal(jump.ok, false);
    if (!jump.ok) assert.equal(jump.code, "NONCE_GAP");
  });
});

describe("No.3 coverage: credential-auth invalid branches", () => {
  it("empty secret/body/tag refuse without throwing", async () => {
    const { verifyBodyHmac } = await import("@polyroot/signer");
    assert.equal(verifyBodyHmac("", "b", "aa").ok, false);
    assert.equal(verifyBodyHmac("s", "", "aa").ok, false);
    assert.equal(verifyBodyHmac("s", "b", "").ok, false);
  });
  it("non-hex tags refuse", async () => {
    const { verifyBodyHmac } = await import("@polyroot/signer");
    const r = verifyBodyHmac("s", "b", "zzzz");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "HMAC_MISMATCH");
  });
  it("incomplete credential bindings refuse", async () => {
    const { checkCredentialBinding } = await import("@polyroot/signer");
    const r = checkCredentialBinding(
      { credentialId: "", boundSignerAddress: "0xA" },
      "0xA",
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "SIGNER_NOT_BOUND");
  });
});

describe("credential-auth rate limiting (coverage gate)", () => {
  it("checkRateLimit allows capacity then refuses; empty key passes", async () => {
    const { checkRateLimit } = await import("@polyroot/signer");
    const key = `rl-test-${Date.now()}-allow`;
    for (let i = 0; i < 60; i++) {
      assert.equal(checkRateLimit(key), true);
    }
    assert.equal(checkRateLimit(key), false);
    assert.equal(checkRateLimit(""), true);
  });
  it("verifyBodyHmac surfaces RATE_LIMIT_EXCEEDED on exhausted key", async () => {
    const { verifyBodyHmac } = await import("@polyroot/signer");
    const key = `rl-test-${Date.now()}-hmac`;
    const secret = "s3cr3t";
    const body = "payload";
    const tag = createHmac("sha256", secret).update(body).digest("hex");
    for (let i = 0; i < 60; i++) {
      assert.equal(
        verifyBodyHmac(secret, body, tag, { rateLimitKey: key }).ok,
        true,
      );
    }
    const limited = verifyBodyHmac(secret, body, tag, { rateLimitKey: key });
    assert.equal(limited.ok, false);
    if (!limited.ok) assert.equal(limited.code, "RATE_LIMIT_EXCEEDED");
  });
});
