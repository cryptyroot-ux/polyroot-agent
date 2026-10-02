import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTelegramHandlers } from "@polyroot/runtime";

const CTX = {
  pool: {},
  getOpenExposureUsd: () => 0,
  installDir: "/tmp/polyroot-test",
} as never;

let savedHome: string | undefined;
let savedPassphrase: string | undefined;
let savedAddress: string | undefined;

function useHome(home: string): void {
  savedHome = process.env["HOME"];
  process.env["HOME"] = home;
}

function setPassphrase(): void {
  savedPassphrase = process.env["POLYROOT_KEYSTORE_PASSPHRASE"];
  savedAddress = process.env["WALLET_ADDRESS"];
  delete process.env["WALLET_ADDRESS"];
  delete process.env["WALLET_ACCOUNT"];
  delete process.env["WALLET_FUNDER"];
  process.env["POLYROOT_KEYSTORE_PASSPHRASE"] = "test-vault-pass";
}

beforeEach(() => {
  savedHome = undefined;
  savedPassphrase = undefined;
  savedAddress = undefined;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedPassphrase === undefined)
    delete process.env["POLYROOT_KEYSTORE_PASSPHRASE"];
  else process.env["POLYROOT_KEYSTORE_PASSPHRASE"] = savedPassphrase;
  if (savedAddress === undefined) delete process.env["WALLET_ADDRESS"];
  else process.env["WALLET_ADDRESS"] = savedAddress;
});

function handlers() {
  return buildTelegramHandlers(CTX);
}

describe("telegram /wallet", () => {
  it("view shows WAL-03 addresses without secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-wallet-"));
    useHome(home);
    process.env["WALLET_ADDRESS"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["WALLET_ACCOUNT"] = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    process.env["WALLET_FUNDER"] = "0xcccccccccccccccccccccccccccccccccccccccc";
    const h = handlers();
    const out = (await h["wallet"]!([], {
      userId: "1",
      username: "op",
    })) as string;
    assert.match(out, /Signer Address/);
    assert.match(out, /0xaaa/);
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(out), "no key material in view");
    delete process.env["WALLET_ADDRESS"];
    delete process.env["WALLET_ACCOUNT"];
    delete process.env["WALLET_FUNDER"];
  });

  it("import refuses chat keys and teaches the terminal path", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-wallet-"));
    useHome(home);
    const h = handlers();
    const out = (await h["wallet"]!(
      ["import", "0x" + "ab".repeat(32)],
      { userId: "1", username: "op" },
    )) as string;
    assert.match(out, /HANYA via terminal/);
    assert.ok(
      !existsSync(join(home, ".polyroot", ".env")),
      "nothing written on refused import",
    );
  });

  it("create is two-step: warning first, key only on YA", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-wallet-"));
    useHome(home);
    setPassphrase();
    const h = handlers();
    const step1 = (await h["wallet"]!(["create"], {
      userId: "7",
      username: "op",
    })) as string;
    assert.match(step1, /wallet create YA/);
    assert.ok(
      !existsSync(join(home, ".polyroot", ".env")),
      "step 1 writes nothing",
    );
    const step2 = (await h["wallet"]!(["create", "YA"], {
      userId: "7",
      username: "op",
    })) as string;
    assert.match(step2, /BARU dibuat/);
    const m = step2.match(/0x[0-9a-fA-F]{40}/);
    assert.ok(m, "reply carries the new address");
    assert.ok(
      !/0x[0-9a-fA-F]{64}/.test(step2),
      "private key never appears in chat",
    );
    const envText = readFileSync(join(home, ".polyroot", ".env"), "utf8");
    assert.ok(envText.includes(`WALLET_ADDRESS=${m[0]}`));
    assert.ok(envText.includes("POLYROOT_KEYSTORE_JSON="));
    const st = statSync(join(home, ".polyroot", "keystore.json"));
    assert.equal(st.mode & 0o777, 0o600);
  });

  it("create YA without a pending request restarts the warning (no execution)", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-wallet-"));
    useHome(home);
    setPassphrase();
    const h = handlers();
    const out = (await h["wallet"]!(["create", "YA"], {
      userId: "fresh-user",
      username: "op",
    })) as string;
    assert.match(out, /wallet create YA/);
    assert.ok(
      !existsSync(join(home, ".polyroot", ".env")),
      "stray YA writes nothing",
    );
  });

  it("create refuses when no vault passphrase exists (terminal first)", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-wallet-"));
    useHome(home);
    delete process.env["POLYROOT_KEYSTORE_PASSPHRASE"];
    const h = handlers();
    await h["wallet"]!(["create"], { userId: "9", username: "op" });
    await assert.rejects(
      h["wallet"]!(["create", "YA"], { userId: "9", username: "op" }),
      /via terminal/,
    );
  });
});
