import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, restoreBackup, decryptText } from "@polyroot/runtime";

function fakePool() {
  const writes: string[] = [];
  return {
    writes,
    query: async (text: string) => {
      if (/INSERT INTO/.test(text)) {
        writes.push(text);
        return { rows: [] };
      }
      if (/FROM wallets/.test(text)) {
        return {
          rows: [
            {
              wallet_id: "w1",
              wallet_type: "DEPOSIT",
              signer_address: "0xabc",
              account_wallet: "0xdef",
              funder: "0xghi",
              chain_id: 137,
              verified_at: "2026-09-01T00:00:00Z",
              created_at: "2026-09-01T00:00:00Z",
            },
          ],
        };
      }
      if (/live_guard_state/.test(text)) {
        return {
          rows: [
            {
              key: "micro-live",
              halted: false,
              halted_at: null,
              realized_loss_pusd: 0,
              runtime_mode: "MICRO_LIVE",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

describe("polyroot backup/restore", () => {
  let home: string;
  let out: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "pr-home-"));
    out = mkdtempSync(join(tmpdir(), "pr-backup-"));
    writeFileSync(
      join(home, ".env"),
      "DATABASE_URL=postgresql://u:p%40ss@localhost:5432/db\nOPENAI_API_KEY=sk-secret-123\nRUNTIME_MODE=MICRO_LIVE\n",
    );
    writeFileSync(
      join(home, "keystore.json"),
      JSON.stringify({ sealed: true }),
    );
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("redacted backup contains zero secrets", async () => {
    const pool = fakePool();
    const { files } = await createBackup(
      { pool, homeDir: home },
      { outDir: out, encrypt: false },
    );
    assert.ok(files.includes(".env.redacted"));
    assert.ok(files.includes("manifest.json"));
    assert.ok(files.includes("keystore.json"));
    const redacted = readFileSync(join(out, ".env.redacted"), "utf8");
    assert.ok(!redacted.includes("sk-secret-123"), "API key leaked!");
    assert.ok(!redacted.includes("p%40ss"), "DB password leaked!");
    assert.ok(redacted.includes("***REDACTED***"));
    assert.ok(redacted.includes("RUNTIME_MODE=MICRO_LIVE"));
  });

  it("encrypted backup round-trips and restore --apply writes .env + keystore", async () => {
    const pool = fakePool();
    const encDir = mkdtempSync(join(tmpdir(), "pr-enc-"));
    const newHome = mkdtempSync(join(tmpdir(), "pr-newhome-"));
    try {
      await createBackup(
        { pool, homeDir: home },
        { outDir: encDir, encrypt: true, passphrase: "pw-123" },
      );
      const encRaw = readFileSync(join(encDir, ".env.enc"), "utf8");
      assert.equal(
        decryptText(encRaw, "pw-123").includes("sk-secret-123"),
        true,
      );
      const res = await restoreBackup(
        { pool, homeDir: newHome },
        { fromDir: encDir, apply: true, passphrase: "pw-123" },
      );
      assert.ok(res.restored.includes(".env"));
      assert.ok(res.restored.includes("keystore.json"));
      const restoredEnv = readFileSync(join(newHome, ".env"), "utf8");
      assert.ok(restoredEnv.includes("sk-secret-123"));
      assert.ok(
        pool.writes.some((q) => /live_guard_state/.test(q)),
        "latch state must be upserted",
      );
    } finally {
      rmSync(encDir, { recursive: true, force: true });
      rmSync(newHome, { recursive: true, force: true });
    }
  });

  it("restore refuses to apply from a redacted backup and detects tampering", async () => {
    const pool = fakePool();
    await assert.rejects(
      restoreBackup({ pool, homeDir: home }, { fromDir: out, apply: true }),
      /no \.env\.enc in backup/,
    );
    // Tamper with a checksummed file → verify must fail
    writeFileSync(join(out, "wallet-config.json"), "[tampered]");
    await assert.rejects(
      restoreBackup({ pool, homeDir: home }, { fromDir: out, apply: false }),
      /checksum mismatch/,
    );
  });
});
