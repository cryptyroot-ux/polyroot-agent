import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  PolymarketVenueAdapter,
  resolveProtocolProfile,
  validateOrderExpiry,
} from "@polyroot/venue";
import { cashNeededFor } from "@polyroot/risk";
import {
  createSignerFromHex,
  computePayloadHash,
  SignerVault,
} from "@polyroot/signer";

const require = createRequire(import.meta.url);
const elliptic = require("elliptic");
const keccak256 = require("keccak256");

const ROOT = new URL("../../..", import.meta.url);

function readJson(rel: string): any {
  return JSON.parse(readFileSync(new URL(rel, ROOT), "utf8"));
}

describe("Phase 16 CT-01: SDK pin + integrity (PM-PROTO-02, G0)", () => {
  it("venue pins @polymarket/client 0.9.0 with lockfile integrity", () => {
    const venuePkg = readJson("src/pm/venue/package.json");
    assert.equal(venuePkg.dependencies["@polymarket/client"], "0.9.0");
    const lock = readJson("package-lock.json");
    const entry = lock.packages?.["node_modules/@polymarket/client"];
    assert.ok(entry, "lockfile entry missing");
    assert.equal(entry.version, "0.9.0");
    assert.match(entry.integrity ?? "", /^sha512-/);
  });
});

describe("Phase 16 CT-02: public client purity (PM-WALLET-03, G0)", () => {
  it("read paths never create wallets, keys or approvals", async () => {
    const calls: string[] = [];
    const fake = {
      fetchOrderBook: async (req: unknown) => {
        calls.push("fetchOrderBook");
        return {
          bids: [{ price: "0.55", size: "100" }],
          asks: [{ price: "0.6", size: "100" }],
        };
      },
    };
    const adapter = new PolymarketVenueAdapter(fake, "NORMAL");
    const snap = await adapter.getOrderBook("mkt_1");
    assert.equal(snap.yes_price, 0.55);
    assert.deepEqual(calls, ["fetchOrderBook"]);
    for (const banned of [
      "createWallet",
      "deployWallet",
      "deriveCredentials",
      "approveSpender",
      "createApiKey",
    ]) {
      assert.equal(
        typeof (adapter as any)[banned],
        "undefined",
        `${banned} must not exist on the public adapter`,
      );
    }
  });
});

describe("Phase 16 CT-03: EOA signing golden (PM-WALLET-01, G0)", () => {
  // secp256k1 generator scalar (private key 0x01) — a published test
  // vector, documented here so no one mistakes it for a secret.
  // Never fund it; it exists only to pin the golden signature below.
  const TEST_KEY = "0".repeat(63) + "1";
  const EXPECTED_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
  const GOLDEN_SIG =
    "0x86f1bc22dc661434bef802a0db2b0139bfb06835324177523cc5d6eab2c3266d4311d0b622415079b6bf241bbbfde21f4720178a1ceb2d3cbaff0d236777ef05";

  function makeRequest(over: Record<string, any> = {}) {
    const permit: any = {
      schema_version: "1.1",
      permit_id: "permit_golden",
      decision_id: "decision_golden",
      intent_id: "intent_golden",
      ledger_version: "0003",
      policy_version: "v0",
      policy_hash: "ph_test",
      quote_id: "q_test",
      lease_epoch: 1,
      reservation_ids: ["res_1"],
      max_qty: 100,
      max_cash: 1000,
      allowed_order_style: ["LIMIT", "POST_ONLY"],
      venue_mode: "NORMAL",
      issued_at: new Date("2026-01-01T00:00:00Z"),
      expires_at: new Date("2026-01-01T01:00:00Z"),
      single_use: true,
      used_at: null,
    };
    const req: any = {
      schema_version: "1.1",
      action: "ORDER_SUBMIT",
      permit,
      wallet: {
        schema_version: "1.1",
        wallet_id: "wallet_golden",
        wallet_type: "EOA",
        signer_address: EXPECTED_ADDRESS,
        account_wallet: "0xACCOUNT",
        funder: "0xFUNDER",
        chain_id: 137,
        verified_at: new Date("2026-01-01T00:00:00Z"),
      },
      amountBase: 10_000_000n,
      actionId: "act_golden",
      intentId: permit.intent_id,
      marketContext: "mkt_1",
      venueMode: "NORMAL",
      now: new Date("2026-01-01T00:00:30Z"),
      side: "BUY",
      priceBase: 500_000n,
      policyHash: "ph_test",
      quoteId: "q_test",
      expectedChainId: 137,
      expectedLeaseEpoch: 1,
      ...over,
    };
    req.payloadHash = computePayloadHash(req);
    return req;
  }

  it("deterministic RFC-6979 signatures verify against the golden address", async () => {
    const signer = createSignerFromHex(TEST_KEY, 137);
    const req = makeRequest();
    const sig1 = await signer(req);
    const sig2 = await signer(req);
    assert.equal(sig1, sig2, "RFC-6979 signatures must be deterministic");
    assert.equal(sig1, GOLDEN_SIG, "golden vector pinned");
    assert.match(sig1, /^0x[0-9a-f]{128}$/);

    // Independent verification with elliptic + keccak (not the signer's
    // own verify path): recover-equivalent check against the golden key.
    const ec = new elliptic.ec("secp256k1");
    const key = ec.keyFromPrivate(Buffer.from(TEST_KEY, "hex"));
    const pub = Buffer.from(key.getPublic(false, "array"));
    const hash = Buffer.from(req.payloadHash.replace("0x", ""), "hex");
    const sigBytes = Buffer.from(sig1.replace("0x", ""), "hex");
    const ok = ec
      .keyFromPublic(pub, "array" as any)
      .verify(hash, { r: sigBytes.slice(0, 32), s: sigBytes.slice(32, 64) });
    assert.equal(ok, true);
    const derived = "0x" + keccak256(pub.slice(1)).slice(-20).toString("hex");
    assert.equal(derived.toLowerCase(), EXPECTED_ADDRESS.toLowerCase());
  });

  it("tampered hash and wrong chain are refused before signing", async () => {
    const signer = createSignerFromHex(TEST_KEY, 137);
    await assert.rejects(
      signer({ ...makeRequest(), payloadHash: "0x" + "00".repeat(32) }),
      /PAYLOAD_HASH_MISMATCH/,
    );
    const wrongChain: any = { ...makeRequest(), expectedChainId: 1 };
    wrongChain.payloadHash = computePayloadHash(wrongChain);
    await assert.rejects(signer(wrongChain), /CHAIN_ID_MISMATCH/);
  });
});

describe("Phase 16 CT-11/12/13: protocol profiles, no V1 fallback (PM-PROTO-01, G0)", () => {
  it("CTF kinds resolve to the CTF profile", () => {
    const r = resolveProtocolProfile({ version: "V2", assetKind: "CTF" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.profile, "CTF");
  });
  it("structured PolyV2 ids resolve to PolyV2 (never coerced to CTF int)", () => {
    const r = resolveProtocolProfile({
      version: "V2",
      assetKind: "POLY_V2",
      assetId: "polyv2:137:abc",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.profile, "POLY_V2");
  });
  it("V1, legacy and unknown profiles are BLOCKED with no fallback", () => {
    for (const input of [
      { version: "V1", assetKind: "CTF" },
      { version: "V2", assetKind: "LEGACY" },
      { version: "V9", assetKind: "QUANTUM" },
      { version: "V2" },
    ]) {
      const r = resolveProtocolProfile(input);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "PROFILE_BLOCKED");
    }
  });
});

describe("Phase 16 CT-14: base-unit rounding never inflates cash (PM-DATA-01, G0)", () => {
  it("cashNeededFor truncates after the exact integer product", () => {
    // 3 shares @ 0.333333 -> 0.999999, truncated to 999999 base units (never 1000000).
    assert.equal(cashNeededFor(3_000_000n, 333_333n), 999_999n);
    assert.equal(cashNeededFor(100_000_000n, 500_000n), 50_000_000n);
  });
});

describe("Phase 16 CT-16: GTC/GTD expiration (PM-PROTO-05, G0)", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("GTC/FOK/FAK carry no venue expiry", () => {
    for (const tif of ["GTC", "FOK", "FAK"] as const) {
      assert.equal(validateOrderExpiry({ tif, now }).ok, true);
    }
  });
  it("GTD without future expiry refuses (no silent GTC fallback)", () => {
    assert.equal(validateOrderExpiry({ tif: "GTD", now }).ok, false);
    const past = validateOrderExpiry({
      tif: "GTD",
      expiresAt: new Date("2025-12-31T23:59:00Z"),
      now,
    });
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.code, "ORDER_EXPIRED");
    const soon = validateOrderExpiry({
      tif: "GTD",
      expiresAt: new Date("2026-01-01T00:01:00Z"),
      now,
    });
    assert.equal(soon.ok, false);
    if (!soon.ok) assert.equal(soon.code, "GTD_TOO_SOON");
  });
  it("GTD with sufficient horizon passes", () => {
    const r = validateOrderExpiry({
      tif: "GTD",
      expiresAt: new Date("2026-01-01T00:10:00Z"),
      now,
    });
    assert.equal(r.ok, true);
  });
});

describe("Phase 16 CT-32: narrow signer surface (PM-SEC-01, G0/G1)", () => {
  it("SignerVault exposes no arbitrary-bytes signing", async () => {
    const { SignerVault } = await import("@polyroot/signer");
    for (const banned of [
      "signArbitrary",
      "signBytes",
      "signRaw",
      "signMessage",
    ]) {
      assert.equal(
        typeof (SignerVault.prototype as any)[banned],
        "undefined",
        `${banned} must not exist on the vault`,
      );
    }
  });
});
