#!/usr/bin/env node
/**
 * Live-readiness rehearsal (No.5): evaluates the 5 live-blockers named by
 * the release verdict against THIS environment and prints exactly what is
 * missing, with the remediation for each. Read-only: it never mutates the
 * database, never touches keys (presence checks only, values never
 * printed), never submits anything.
 *
 * Usage: node scripts/live-readiness.mjs [--json] [--gate]
 *   --json  machine-readable output
 *   --gate  exit 1 when any blocker is BLOCKED (default: exit 0, it is a report)
 */
import { Pool } from "pg";
import {
  SHADOW_BASELINE_ID,
  SHADOW_BASELINE_MIN_DAYS,
  SHADOW_BASELINE_MIN_CLUSTERS,
  checkShadowBaselineRow,
} from "@polyroot/runtime";

const NO_URL = {
  blocker: "",
  status: "BLOCKED",
  detail: "no database URL configured",
  remediation:
    "export TEST_DATABASE_URL=postgresql://... (read-only user is enough)",
};

function row(blocker, status, detail, remediation) {
  return { blocker, status, detail, remediation };
}

async function withPool(url, fn) {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function dbError(e) {
  return `database unreachable: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Prospective observation (G5): the SAME baseline row and the SAME rule the
 * MICRO_LIVE startup gate enforces, so a rehearsal that says READY cannot be
 * contradicted at boot. Provenance (frozen version + preregistration) is
 * required too: observation without a frozen pre-live spec is not evidence.
 */
async function checkObservationDays(url) {
  if (!url)
    return row(
      "prospective observation",
      "BLOCKED",
      NO_URL.detail,
      NO_URL.remediation,
    );
  try {
    const result = await withPool(url, (pool) =>
      pool.query(
        `SELECT observed_days, resolved_clusters, versions_frozen_sha,
                preregistered, observed_started_at::text AS started,
                updated_at::text AS updated
           FROM shadow_baseline WHERE id = $1`,
        [SHADOW_BASELINE_ID],
      ),
    );
    const r = result.rows[0];
    if (!r) {
      return row(
        "prospective observation",
        "BLOCKED",
        `no baseline row ${SHADOW_BASELINE_ID}`,
        "npm run migrate:latest (migration 0006 seeds the baseline row)",
      );
    }
    const verdict = checkShadowBaselineRow(r);
    const days = Number(r.observed_days);
    const clusters = Number(r.resolved_clusters);
    const detail =
      `${days}/${SHADOW_BASELINE_MIN_DAYS} days, ` +
      `${clusters}/${SHADOW_BASELINE_MIN_CLUSTERS} clusters, ` +
      `preregistered=${r.preregistered}, frozen=${r.versions_frozen_sha ?? "none"}`;

    if (verdict.ok !== true) {
      return row(
        "prospective observation",
        "BLOCKED",
        detail,
        `collect evidence up to ${SHADOW_BASELINE_MIN_DAYS}d / ${SHADOW_BASELINE_MIN_CLUSTERS} clusters (polyroot shadow-baseline)`,
      );
    }
    if (r.preregistered !== true || !r.versions_frozen_sha) {
      return row(
        "prospective observation",
        "BLOCKED",
        detail,
        "freeze the pre-live spec: polyroot shadow-baseline --freeze <git-sha> --rule <text>",
      );
    }
    return row("prospective observation", "READY", detail, null);
  } catch (e) {
    return row(
      "prospective observation",
      "BLOCKED",
      dbError(e),
      "verify the DB is migrated and reachable",
    );
  }
}

/**
 * Authenticated live fills: reconciled consumed fill quantity, NOT
 * resolved_state='ACKNOWLEDGED'. An acknowledgement is a submission handshake
 * — the domain contract states explicitly that an ACK is not a fill.
 */
async function checkLiveFills(url) {
  if (!url)
    return row(
      "authenticated live fills",
      "BLOCKED",
      NO_URL.detail,
      NO_URL.remediation,
    );
  try {
    const result = await withPool(url, (pool) =>
      pool.query(
        `SELECT consumed_fill_shares_base, consumed_fill_cash_base,
                resolved_at::text AS last_at
           FROM recovery_ledger
          WHERE venue_order_id IS NOT NULL AND venue_order_id <> ''`,
      ),
    );
    const isPositive = (v) =>
      typeof v === "string" &&
      /^[0-9]+$/.test(v.trim()) &&
      BigInt(v.trim()) > 0n;
    const filled = result.rows.filter(
      (r) =>
        isPositive(r.consumed_fill_shares_base) ||
        isPositive(r.consumed_fill_cash_base),
    );
    const n = filled.length;
    if (n === 0) {
      return row(
        "authenticated live fills",
        "BLOCKED",
        "0 reconciled live fills on record",
        "run bounded MICRO_LIVE first; an acknowledged submission is not a fill",
      );
    }
    const last = filled
      .map((r) => r.last_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    return row(
      "authenticated live fills",
      "READY",
      `${n} reconciled fill(s), latest ${last ?? "unknown"}`,
      null,
    );
  } catch (e) {
    const missing =
      e instanceof Error && /does not exist|relation/i.test(e.message);
    return row(
      "authenticated live fills",
      "BLOCKED",
      missing
        ? "recovery_ledger missing — run migrations through 0026"
        : dbError(e),
      missing
        ? "npm run migrate:latest"
        : "provide TEST_DATABASE_URL with valid credentials",
    );
  }
}

async function checkPromotion(url) {
  if (!url)
    return row(
      "owner-signed LIVE promotion",
      "BLOCKED",
      NO_URL.detail,
      NO_URL.remediation,
    );
  try {
    const result = await withPool(url, (pool) =>
      pool.query(
        `SELECT id::text AS id, strategy, profile, to_cap_usd, expires_at::text AS exp
           FROM live_promotions
          WHERE revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
      ),
    );
    const r = result.rows[0];
    return r
      ? row(
          "owner-signed LIVE promotion",
          "READY",
          `${r.strategy}/${r.profile} → $${r.to_cap_usd} until ${r.exp} (${r.id})`,
          null,
        )
      : row(
          "owner-signed LIVE promotion",
          "BLOCKED",
          "no live owner-signed promotion row",
          "grant one in the terminal: `polyroot live-promote` (typed PROMOTE, wallet-signed)",
        );
  } catch (e) {
    const missing =
      e instanceof Error && /does not exist|relation/i.test(e.message);
    return row(
      "owner-signed LIVE promotion",
      "BLOCKED",
      missing
        ? "live_promotions table missing — run migrations through 0027"
        : dbError(e),
      missing
        ? "npm run migrate:latest"
        : "provide TEST_DATABASE_URL with valid credentials",
    );
  }
}

function checkEnvPresence(name) {
  return typeof process.env[name] === "string" && process.env[name].length > 0;
}

function checkSigningPath() {
  const kmsKey = checkEnvPresence("KMS_KEY_ID");
  const awsKey = checkEnvPresence("AWS_ACCESS_KEY_ID");
  const hasKeystore =
    checkEnvPresence("POLYROOT_KEYSTORE_JSON") ||
    checkEnvPresence("POLYROOT_KEYSTORE_FILE");
  if ((kmsKey && awsKey) || hasKeystore) {
    return row(
      "Signing path (KMS/HSM or keystore)",
      "READY",
      hasKeystore
        ? "POLYROOT_KEYSTORE_JSON/FILE present (keystore at rest)"
        : "KMS_KEY_ID + AWS credentials present (presence only, never printed)",
      null,
    );
  }
  return row(
    "Signing path (KMS/HSM or keystore)",
    "BLOCKED",
    `KMS_KEY_ID ${kmsKey ? "present" : "missing"}, AWS credentials ${awsKey ? "present" : "missing"}, Keystore ${hasKeystore ? "present" : "missing"}`,
    "Option A: export KMS_KEY_ID + AWS credentials via systemd credentials\nOption B: seal key with 'polyroot wallet seal' and set POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE",
  );
}

async function checkPoly1271Wrapper() {
  try {
    const m = await import("@polyroot/signer");
    const missing = [
      "encodeField",
      "hashStruct",
      "signingDigest",
      "hashNested1271",
    ].filter((f) => typeof m[f] !== "function");
    return missing.length === 0
      ? row(
          "POLY_1271 wrapper",
          "READY",
          "offline EIP-712/7739 encoding present; on-chain validator call stays G4",
          null,
        )
      : row(
          "POLY_1271 wrapper",
          "BLOCKED",
          `missing exports: ${missing.join(", ")}`,
          "complete the offline 1271 encoder, then schedule the validator-contract call (G4)",
        );
  } catch (e) {
    return row(
      "POLY_1271 wrapper",
      "BLOCKED",
      `signer package not loadable: ${e instanceof Error ? e.message : String(e)}`,
      "build the workspace: npm run build:all",
    );
  }
}

async function main() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const rows = [
    await checkObservationDays(url),
    await checkLiveFills(url),
    await checkPromotion(url),
    checkSigningPath(),
    await checkPoly1271Wrapper(),
  ];

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 1));
  } else {
    console.log("blocker | status | detail | remediation");
    for (const r of rows) {
      console.log(
        `${r.blocker} | ${r.status} | ${r.detail} | ${r.remediation ?? "-"}`,
      );
    }
  }

  const blocked = rows.filter((r) => r.status === "BLOCKED").length;
  if (!process.argv.includes("--json")) {
    console.log(
      `live-readiness: ${rows.length - blocked}/${rows.length} ready (${blocked} blocked)`,
    );
  }
  if (blocked > 0 && process.argv.includes("--gate")) {
    process.exitCode = 1;
  }
}

await main();
