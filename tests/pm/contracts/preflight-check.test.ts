import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPreflightCheck } from "@polyroot/runtime";

const FULL_LIVE: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  POLYROOT_KEYSTORE_JSON: '{"sealed":true}',
  POLYROOT_KEYSTORE_PASSPHRASE: "pass",
  WALLET_ADDRESS: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  WALLET_ACCOUNT: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  WALLET_FUNDER: "0xcccccccccccccccccccccccccccccccccccccccc",
  POLYMARKET_API_KEY: "k",
  POLYMARKET_API_SECRET: "s",
  POLYMARKET_API_PASSPHRASE: "p",
  POLYROOT_FORECAST_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-x",
  RPC_URL: "https://polygon-rpc.com",
};

describe("pre-flight check (polyroot run gate)", () => {
  it("LIVE with everything configured passes", () => {
    const r = runPreflightCheck("LIVE", { ...FULL_LIVE });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.ok(r.info.some((m) => m.includes("WAL-03")));
  });

  it("LIVE with empty env fails with named errors", () => {
    const r = runPreflightCheck("LIVE", {});
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((m) => m.includes("DATABASE_URL")));
    assert.ok(r.errors.some((m) => m.includes("Wallet not configured")));
    assert.ok(r.errors.some((m) => m.includes("WALLET_ACCOUNT")));
    assert.ok(r.errors.some((m) => m.includes("Polymarket credentials")));
  });

  it("LIVE rejects non-distinct WAL-03 addresses", () => {
    const r = runPreflightCheck("LIVE", {
      ...FULL_LIVE,
      WALLET_FUNDER: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((m) => m.includes("3 distinct")));
  });

  it("SHADOW without wallet/venue warns instead of failing", () => {
    const r = runPreflightCheck("SHADOW", {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((m) => m.includes("Wallet not configured")));
    assert.ok(r.warnings.some((m) => m.includes("Polymarket credentials")));
  });

  it("SHADOW without database still fails", () => {
    const r = runPreflightCheck("SHADOW", {});
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((m) => m.includes("DATABASE_URL")));
  });

  it("honors the injected env instead of process.env", () => {
    // Would fail against real process.env if it read the wrong source.
    const r = runPreflightCheck("PAPER", {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      POLYROOT_FORECAST_PROVIDER: "codex",
    });
    assert.equal(r.ok, true);
    assert.ok(r.info.some((m) => m.includes("Codex")));
  });

  it("no duplicated DATABASE_URL lines", () => {
    const r = runPreflightCheck("PAPER", {});
    const dbLines = [...r.errors, ...r.info].filter((m) =>
      m.includes("DATABASE_URL"),
    );
    assert.equal(dbLines.length, 1);
  });
});
