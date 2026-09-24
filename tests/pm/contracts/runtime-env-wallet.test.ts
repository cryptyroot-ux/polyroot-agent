import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRuntimeEnv,
  buildWalletIdentity,
  deterministicWalletId,
} from "@polyroot/runtime";
import { deriveAddressFromPrivateKey } from "@polyroot/signer";

const TEST_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_KEY =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("runtime env validation (fail-closed)", () => {
  it("PAPER needs nothing extra", () => {
    assertRuntimeEnv("PAPER", {});
    assertRuntimeEnv("SHADOW", {});
  });
  it("live modes require a wallet key", () => {
    assert.throws(() => assertRuntimeEnv("MICRO_LIVE", {}), /LIVE_ENV_MISSING/);
    assertRuntimeEnv("MICRO_LIVE", {
      WALLET_PRIVATE_KEY: TEST_KEY,
      WALLET_ACCOUNT: "0x1111111111111111111111111111111111111111",
      WALLET_FUNDER: "0x2222222222222222222222222222222222222222",
    });
  });
  it("live modes require distinct account and funder", () => {
    assert.throws(
      () =>
        assertRuntimeEnv("LIVE", {
          PRIVATE_KEY_HEX: TEST_KEY,
          WALLET_ACCOUNT: "0xA",
        }),
      /WALLET_ACCOUNT and WALLET_FUNDER/,
    );
    assert.throws(
      () =>
        assertRuntimeEnv("LIVE", {
          PRIVATE_KEY_HEX: TEST_KEY,
          WALLET_ACCOUNT: "0xA",
          WALLET_FUNDER: "0xA",
        }),
      /must be distinct/,
    );
  });
});

describe("wallet identity derivation", () => {
  it("derives a well-formed address from a key", () => {
    const addr = deriveAddressFromPrivateKey(TEST_KEY);
    assert.match(addr, /^0x[0-9a-f]{40}$/);
    assert.notEqual(addr, deriveAddressFromPrivateKey(OTHER_KEY));
  });
  it("PAPER keeps the mock placeholder", () => {
    const w = buildWalletIdentity("PAPER", {});
    assert.equal(w.signer_address, "0xSIGNER_ADDRESS_1111111111111111");
  });
  it("live builds a distinct, stable identity from env", () => {
    const addr = deriveAddressFromPrivateKey(TEST_KEY);
    const env = {
      WALLET_PRIVATE_KEY: TEST_KEY,
      WALLET_ACCOUNT: "0x1111111111111111111111111111111111111111",
      WALLET_FUNDER: "0x2222222222222222222222222222222222222222",
    };
    const w = buildWalletIdentity("MICRO_LIVE", env);
    assert.equal(w.signer_address, addr);
    assert.equal(w.wallet_id, buildWalletIdentity("MICRO_LIVE", env).wallet_id);
    assert.match(
      w.wallet_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(deterministicWalletId(addr), w.wallet_id);
  });
  it("live refuses signer/account/funder collisions", () => {
    const addr = deriveAddressFromPrivateKey(TEST_KEY);
    assert.throws(
      () =>
        buildWalletIdentity("MICRO_LIVE", {
          WALLET_PRIVATE_KEY: TEST_KEY,
          WALLET_ACCOUNT: addr,
          WALLET_FUNDER: "0x2222222222222222222222222222222222222222",
        }),
      /three distinct addresses/,
    );
  });
});
