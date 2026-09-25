import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, runWalletVerify } from "@polyroot/runtime";
import { sealPrivateKey } from "@polyroot/signer";

describe("loadDotEnv resolution", () => {
  it("loads an explicit path and returns it", () => {
    const dir = mkdtempSync(join(tmpdir(), "polyroot-env-"));
    try {
      const path = join(dir, "custom.env");
      writeFileSync(path, "POLYROOT_TEST_LOAD_DOTENV=yes\n");
      delete process.env["POLYROOT_TEST_LOAD_DOTENV"];
      assert.equal(loadDotEnv(path), path);
      assert.equal(process.env["POLYROOT_TEST_LOAD_DOTENV"], "yes");
    } finally {
      delete process.env["POLYROOT_TEST_LOAD_DOTENV"];
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns undefined when nothing exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "polyroot-env-"));
    try {
      assert.equal(loadDotEnv(join(dir, "missing.env")), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR = "0x8fd379246834eac74b8419ffda202cf8051f7a03";
const ACCT = "0x1111111111111111111111111111111111111111";
const FUND = "0x2222222222222222222222222222222222222222";

describe("polyroot wallet verify (no agent, no network)", () => {
  it("passes on a complete, consistent wallet env", () => {
    const r = runWalletVerify({
      WALLET_PRIVATE_KEY: KEY,
      WALLET_ADDRESS: ADDR,
      WALLET_ACCOUNT: ACCT,
      WALLET_FUNDER: FUND,
    });
    assert.equal(r.ok, true);
    assert.equal(r.address, ADDR);
  });
  it("fails when no key is set", () => {
    const r = runWalletVerify({});
    assert.equal(r.ok, false);
    assert.equal(r.checks[0]?.name, "key-present");
  });
  it("fails on a malformed key", () => {
    const r = runWalletVerify({ WALLET_PRIVATE_KEY: "0x123" });
    assert.equal(r.ok, false);
  });
  it("fails when WALLET_ADDRESS mismatches the key", () => {
    const r = runWalletVerify({
      WALLET_PRIVATE_KEY: KEY,
      WALLET_ADDRESS: ACCT,
      WALLET_ACCOUNT: ACCT,
      WALLET_FUNDER: FUND,
    });
    assert.equal(r.ok, false);
    const check = r.checks.find((c) => c.name === "address-match");
    assert.equal(check?.ok, false);
  });
  it("passes without WALLET_ADDRESS and reports the derived one", () => {
    const r = runWalletVerify({
      WALLET_PRIVATE_KEY: KEY,
      WALLET_ACCOUNT: ACCT,
      WALLET_FUNDER: FUND,
    });
    assert.equal(r.ok, true);
    assert.equal(r.address, ADDR);
  });
  it("fails on account/funder collision or absence", () => {
    const missing = runWalletVerify({ WALLET_PRIVATE_KEY: KEY });
    assert.equal(missing.ok, false);
    const colliding = runWalletVerify({
      WALLET_PRIVATE_KEY: KEY,
      WALLET_ACCOUNT: ADDR,
      WALLET_FUNDER: FUND,
    });
    assert.equal(colliding.ok, false);
  });
  it("accepts a sealed keystore with no raw key present", () => {
    const envelope = sealPrivateKey(`0x${KEY}`, "test-pass");
    const r = runWalletVerify({
      POLYROOT_KEYSTORE_JSON: JSON.stringify(envelope),
      POLYROOT_KEYSTORE_PASSPHRASE: "test-pass",
      WALLET_ADDRESS: ADDR,
      WALLET_ACCOUNT: ACCT,
      WALLET_FUNDER: FUND,
    });
    assert.equal(r.ok, true);
    assert.equal(r.address, ADDR);
  });
  it("fails when the keystore passphrase is wrong", () => {
    const envelope = sealPrivateKey(`0x${KEY}`, "test-pass");
    const r = runWalletVerify({
      POLYROOT_KEYSTORE_JSON: JSON.stringify(envelope),
      POLYROOT_KEYSTORE_PASSPHRASE: "wrong-pass",
      WALLET_ACCOUNT: ACCT,
      WALLET_FUNDER: FUND,
    });
    assert.equal(r.ok, false);
  });
});
