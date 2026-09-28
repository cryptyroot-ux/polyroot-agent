/**
 * @polyroot/runtime — Disaster-recovery export/import for
 * `polyroot backup` / `polyroot restore`.
 *
 * Honest scope, documented in the manifest:
 * - Irreplaceable operator state IS restorable: `.env` (encrypted copy),
 *   `keystore.json` (already an encrypted envelope), `wallets` rows,
 *   `live_guard_state` rows.
 * - Append-only log data (forecasts, risk decisions, paper/shadow logs) is
 *   exported as checksum-verified JSON reference copies. Re-running the
 *   agent reproduces live state; the JSON exists for audit, not replay.
 * - `.env.redacted` (default mode) NEVER contains secrets — restore refuses
 *   to apply from a redacted backup and tells the operator to re-run with
 *   `--encrypt`.
 */

import {
  createHash,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { QueryablePool } from "../mode-watcher.js";

export interface BackupDeps {
  pool: QueryablePool;
  /** Operator home dir containing `.env` + `keystore.json` (e.g. ~/.polyroot). */
  homeDir: string;
}

export interface BackupRequest {
  outDir: string;
  encrypt: boolean;
  passphrase?: string | undefined;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  mode: "encrypted" | "redacted";
  runtimeMode: string;
  files: Record<string, string>;
  notes: string[];
}

const SECRET_NAME = /KEY|SECRET|PASSPHRASE|PRIVATE|TOKEN|PASSWORD/i;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function redactEnv(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const eq = t.indexOf("=");
      if (eq <= 0) return line;
      const key = t.slice(0, eq).trim();
      if (
        key === "DATABASE_URL" ||
        key === "RPC_URL" ||
        SECRET_NAME.test(key)
      ) {
        return `${key}=***REDACTED***`;
      }
      return line;
    })
    .join("\n");
}

interface EncEnvelope {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function encryptText(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const env: EncEnvelope = {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
  };
  return JSON.stringify(env);
}

export function decryptText(envelope: string, passphrase: string): string {
  const env = JSON.parse(envelope) as EncEnvelope;
  if (env.v !== 1) throw new Error("unsupported envelope version");
  const key = scryptSync(passphrase, Buffer.from(env.salt, "base64"), 32);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(env.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(env.data, "base64")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

const DATA_TABLES: Array<{ table: string; timeCol: string | null }> = [
  { table: "forecasts", timeCol: "created_at" },
  { table: "risk_decisions", timeCol: "decided_at" },
  { table: "paper_log", timeCol: "created_at" },
  { table: "shadow_log", timeCol: "created_at" },
  { table: "live_guard_state", timeCol: null },
];

/** Export operator state + reference data into outDir. Returns manifest path. */
export async function createBackup(
  deps: BackupDeps,
  req: BackupRequest,
): Promise<{ manifestPath: string; files: string[] }> {
  if (req.encrypt && !req.passphrase) {
    throw new Error(
      "backup --encrypt needs POLYROOT_BACKUP_PASSPHRASE (env) — refusing to write secrets unprotected",
    );
  }
  await mkdir(req.outDir, { recursive: true });
  const files: string[] = [];
  const hashes: Record<string, string> = {};
  const track = async (name: string, data: Buffer | string): Promise<void> => {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await writeFile(join(req.outDir, name), buf);
    files.push(name);
    hashes[name] = sha256Hex(buf);
  };

  // 1. Environment (encrypted envelope, or redacted copy — never raw).
  const envRaw = await readIfExists(join(deps.homeDir, ".env"));
  if (envRaw) {
    if (req.encrypt) {
      await track(
        ".env.enc",
        encryptText(envRaw.toString("utf8"), req.passphrase as string),
      );
    } else {
      await track(".env.redacted", redactEnv(envRaw.toString("utf8")));
    }
  }

  // 2. Keystore envelope (already encrypted at rest — copy bytes as-is, 0600).
  const ks = await readIfExists(join(deps.homeDir, "keystore.json"));
  if (ks) {
    await writeFile(join(req.outDir, "keystore.json"), ks, { mode: 0o600 });
    files.push("keystore.json");
    hashes["keystore.json"] = sha256Hex(ks);
  }

  // 3. Wallet identities (addresses only — no key material lives here).
  try {
    const wallets = await deps.pool.query(
      `SELECT wallet_id, wallet_type, signer_address, account_wallet,
              funder, chain_id, verified_at, created_at FROM wallets`,
      [],
    );
    await track("wallet-config.json", JSON.stringify(wallets.rows, null, 2));
  } catch {
    await track(
      "wallet-config.json",
      JSON.stringify({ exported: false, reason: "wallets unreadable" }),
    );
  }

  // 4. Reference data (last 7 days, capped) — checksum-verified, audit use.
  await mkdir(join(req.outDir, "data"), { recursive: true });
  for (const { table, timeCol } of DATA_TABLES) {
    try {
      const sql = timeCol
        ? `SELECT * FROM ${table} WHERE ${timeCol} > now() - interval '7 days' ORDER BY ${timeCol} DESC LIMIT 1000`
        : `SELECT * FROM ${table}`;
      const res = await deps.pool.query(sql, []);
      await track(
        join("data", `${table}.json`),
        JSON.stringify(res.rows, null, 2),
      );
    } catch {
      await track(
        join("data", `${table}.json`),
        JSON.stringify({ exported: false, reason: "unreadable" }),
      );
    }
  }

  // 5. Runtime mode marker.
  let runtimeMode = "unknown";
  try {
    const m = await deps.pool.query(
      `SELECT runtime_mode FROM live_guard_state WHERE key = 'micro-live'`,
      [],
    );
    const v = m.rows[0]?.["runtime_mode"];
    if (typeof v === "string") runtimeMode = v;
  } catch {
    // marker stays unknown
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: req.encrypt ? "encrypted" : "redacted",
    runtimeMode,
    files: hashes,
    notes: [
      ".env.redacted contains NO secrets — restore --apply needs .env.enc from backup --encrypt.",
      "data/*.json are audit reference copies (checksummed), not replayed on restore.",
      "live_guard_state + wallets ARE restored with --apply.",
    ],
  };
  await track("manifest.json", JSON.stringify(manifest, null, 2));
  return { manifestPath: join(req.outDir, "manifest.json"), files };
}

export interface RestoreDeps {
  pool: QueryablePool;
  homeDir: string;
}

export interface RestoreRequest {
  fromDir: string;
  apply: boolean;
  passphrase?: string | undefined;
}

export interface RestoreResult {
  verified: string[];
  restored: string[];
  apply: boolean;
  notes: string[];
}

/** Verify manifest checksums; with apply=true, restore config + latch state. */
export async function restoreBackup(
  deps: RestoreDeps,
  req: RestoreRequest,
): Promise<RestoreResult> {
  const manifestRaw = await readFile(
    join(req.fromDir, "manifest.json"),
    "utf8",
  ).catch(() => {
    throw new Error(`manifest.json not found in ${req.fromDir}`);
  });
  const manifest = JSON.parse(manifestRaw) as BackupManifest;
  if (manifest.version !== 1 || typeof manifest.files !== "object") {
    throw new Error("unsupported or corrupt manifest");
  }
  const verified: string[] = [];
  for (const [name, want] of Object.entries(manifest.files)) {
    if (name === "manifest.json") continue;
    const data = await readFile(join(req.fromDir, name)).catch(() => {
      throw new Error(`backup file missing: ${name}`);
    });
    if (sha256Hex(data) !== want) {
      throw new Error(`checksum mismatch: ${name} (backup tampered?)`);
    }
    verified.push(name);
  }

  const restored: string[] = [];
  const notes: string[] = [];
  if (!req.apply) {
    notes.push(
      "dry-run: verified only, nothing written (pass --apply to restore).",
    );
    return { verified, restored, apply: false, notes };
  }

  // .env: only from the encrypted envelope — never from the redacted copy.
  const encNames = verified.filter((n) => basename(n) === ".env.enc");
  if (encNames.length === 0) {
    throw new Error(
      "no .env.enc in backup (redacted backups hold no secrets) — re-run backup --encrypt first",
    );
  }
  if (!req.passphrase) {
    throw new Error(
      "restore needs POLYROOT_BACKUP_PASSPHRASE to decrypt .env.enc",
    );
  }
  const envPlain = decryptText(
    await readFile(join(req.fromDir, encNames[0] as string), "utf8"),
    req.passphrase,
  );
  await writeFile(join(deps.homeDir, ".env"), envPlain, { mode: 0o600 });
  restored.push(".env");

  if (verified.some((n) => basename(n) === "keystore.json")) {
    const ks = await readFile(join(req.fromDir, "keystore.json"));
    await writeFile(join(deps.homeDir, "keystore.json"), ks, { mode: 0o600 });
    restored.push("keystore.json");
  }

  // Latch state + wallets (best-effort, idempotent).
  try {
    const latchRaw = await readFile(
      join(req.fromDir, "data", "live_guard_state.json"),
      "utf8",
    );
    const rows = JSON.parse(latchRaw) as Record<string, unknown>[];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        await deps.pool.query(
          `INSERT INTO live_guard_state (key, halted, halted_at, realized_loss_pusd, updated_at)
           VALUES ('micro-live', $1, $2, $3, now())
           ON CONFLICT (key) DO UPDATE SET halted = EXCLUDED.halted,
             halted_at = EXCLUDED.halted_at,
             realized_loss_pusd = EXCLUDED.realized_loss_pusd, updated_at = now()`,
          [
            r["halted"] === true,
            (r["halted_at"] as string) ?? null,
            Number(r["realized_loss_pusd"] ?? 0),
          ],
        );
      }
      restored.push("live_guard_state");
    }
  } catch {
    notes.push("live_guard_state not restored (absent or unreadable).");
  }
  try {
    const wRaw = await readFile(
      join(req.fromDir, "wallet-config.json"),
      "utf8",
    );
    const rows = JSON.parse(wRaw) as Record<string, unknown>[];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        await deps.pool.query(
          `INSERT INTO wallets (wallet_id, wallet_type, signer_address, account_wallet,
             funder, chain_id, verified_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (wallet_id) DO NOTHING`,
          [
            r["wallet_id"],
            r["wallet_type"],
            r["signer_address"],
            r["account_wallet"],
            r["funder"],
            r["chain_id"],
            r["verified_at"],
            r["created_at"],
          ],
        );
      }
      restored.push("wallets");
    }
  } catch {
    notes.push("wallets not restored (absent or unreadable).");
  }
  return { verified, restored, apply: true, notes };
}
