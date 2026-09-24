import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sealPrivateKey,
  openKeystore,
  resolveWalletKey,
} from "@polyroot/signer";

const KEY = "0x" + "7".repeat(64);
const PASS = "correct horse battery staple";

describe("encrypted keystore (scrypt + AES-256-GCM)", () => {
  it("seal/open round-trips without exposing the key", () => {
    const sealed = sealPrivateKey(KEY, PASS);
    assert.equal(sealed.v, 1);
    assert.ok(!JSON.stringify(sealed).includes("7777"));
    assert.equal(openKeystore(sealed, PASS), KEY);
  });

  it("refuses wrong passphrases and tampered envelopes", () => {
    const sealed = sealPrivateKey(KEY, PASS);
    assert.throws(() => openKeystore(sealed, "wrong"), /KEYSTORE_AUTH_FAILED/);
    const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + "00" };
    assert.throws(() => openKeystore(tampered, PASS), /KEYSTORE_AUTH_FAILED/);
  });

  it("refuses malformed keys and envelopes", () => {
    assert.throws(() => sealPrivateKey("0x123", PASS), /KEYSTORE_INVALID_KEY/);
    assert.throws(
      () => openKeystore({ v: 999 } as never, PASS),
      /KEYSTORE_INVALID_ENVELOPE/,
    );
  });

  it("factory prefers keystore over raw key, fails closed without passphrase", () => {
    const sealed = sealPrivateKey(KEY, PASS);
    const resolved = resolveWalletKey({
      POLYROOT_KEYSTORE_JSON: JSON.stringify(sealed),
      POLYROOT_KEYSTORE_PASSPHRASE: PASS,
      WALLET_PRIVATE_KEY: "0x" + "9".repeat(64),
    });
    assert.equal(resolved, KEY);
    assert.throws(
      () =>
        resolveWalletKey({
          POLYROOT_KEYSTORE_JSON: JSON.stringify(sealed),
        }),
      /KEYSTORE_PASSPHRASE_MISSING/,
    );
    assert.equal(
      resolveWalletKey({ WALLET_PRIVATE_KEY: "0x" + "9".repeat(64) }),
      "0x" + "9".repeat(64),
    );
    assert.throws(() => resolveWalletKey({}), /PRIVATE_KEY_HEX/);
  });
});
