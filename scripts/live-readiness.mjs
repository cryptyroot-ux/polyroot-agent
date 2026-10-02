#!/usr/bin/env node
/**
 * Live-readiness rehearsal (No.5): evaluates the 4 live-blockers named by
 * the release verdict against THIS environment and prints exactly what is
 * missing, with the remediation for each. Read-only: it never mutates the
 * database, never touches keys (presence checks only, values never
 * printed), never submits anything.
 *
 * Usage: node scripts/live-readiness.mjs [--json]
 * Exit 0 always (it is a report, not a gate); machine output via --json.
 */
import { Pool } from "pg";

async function checkObservationDays() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    return {
      blocker: "prospective observation",
      status: "BLOCKED",
      detail: "no database URL configured",
      remediation:
        "export TEST_DATABASE_URL=postgresql://... (read-only user is enough)",
    };
  }
  let pool = null;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    const r = await pool.query(
      "SELECT observed_days FROM shadow_gate_evaluations ORDER BY evaluated_at DESC LIMIT 1",
    );
    const days = r.rows.length > 0 ? Number(r.rows[0].observed_days) : 0;
    return days >= 30
      ? {
          blocker: "prospective observation",
          status: "READY",
          detail: `${days}/30 days`,
          remediation: null,
        }
      : {
          blocker: "prospective observation",
          status: "BLOCKED",
          detail: `${days}/30 days`,
          remediation:
            "keep the SHADOW loop running; re-run this rehearsal daily",
        };
  } catch (e) {
    return {
      blocker: "prospective observation",
      status: "BLOCKED",
      detail: `database unreachable: ${e instanceof Error ? e.message : String(e)}`,
      remediation: "provide TEST_DATABASE_URL with valid credentials",
    };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

function checkEnvPresence(name) {
  return typeof process.env[name] === "string" && process.env[name].length > 0;
}

async function checkLiveFills(url) {
  if (!url) {
    return {
      blocker: "authenticated live fills",
      status: "BLOCKED",
      detail: "no database URL configured",
      remediation:
        "export TEST_DATABASE_URL=postgresql://... (read-only user is enough)",
    };
  }
  let pool = null;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    // Real venue acknowledgements: resolved rows carrying a venue order id.
    // Paper/shadow sim fills never write venue_order_id — this counts only
    // venue-confirmed executions.
    const r = await pool.query(
      `SELECT count(*)::text AS n,
              max(resolved_at)::text AS last_at
       FROM recovery_ledger
       WHERE resolved = true AND resolved_state = 'ACKNOWLEDGED'
         AND venue_order_id IS NOT NULL AND venue_order_id <> ''`,
    );
    const n = Number(r.rows[0]?.n ?? 0);
    return n > 0
      ? {
          blocker: "authenticated live fills",
          status: "READY",
          detail: `${n} venue-confirmed fill(s), latest ${r.rows[0]?.last_at ?? "unknown"}`,
          remediation: null,
        }
      : {
          blocker: "authenticated live fills",
          status: "BLOCKED",
          detail: "0 venue-confirmed fills on record",
          remediation:
            "run bounded MICRO_LIVE first; SHADOW/PAPER sim fills do not count",
        };
  } catch (e) {
    return {
      blocker: "authenticated live fills",
      status: "BLOCKED",
      detail: `database unreachable: ${e instanceof Error ? e.message : String(e)}`,
      remediation: "provide TEST_DATABASE_URL with valid credentials",
    };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

async function checkPromotion(url) {
  if (!url) {
    return {
      blocker: "owner-signed LIVE promotion",
      status: "BLOCKED",
      detail: "no database URL configured",
      remediation:
        "export TEST_DATABASE_URL=postgresql://... (read-only user is enough)",
    };
  }
  let pool = null;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    const r = await pool.query(
      `SELECT id::text AS id, strategy, profile, to_cap_usd, expires_at::text AS exp
       FROM live_promotions
       WHERE revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    return row
      ? {
          blocker: "owner-signed LIVE promotion",
          status: "READY",
          detail: `${row.strategy}/${row.profile} → $${row.to_cap_usd} until ${row.exp} (${row.id})`,
          remediation: null,
        }
      : {
          blocker: "owner-signed LIVE promotion",
          status: "BLOCKED",
          detail: "no live owner-signed promotion row",
          remediation:
            "grant one in the terminal: `polyroot live-promote` (typed PROMOTE, wallet-signed)",
        };
  } catch (e) {
    const missing =
      e instanceof Error && /does not exist|relation/i.test(e.message);
    return {
      blocker: "owner-signed LIVE promotion",
      status: "BLOCKED",
      detail: missing
        ? "live_promotions table missing — run migrations through 0027"
        : `database unreachable: ${e instanceof Error ? e.message : String(e)}`,
      remediation: missing
        ? "npm run migrate:latest"
        : "provide TEST_DATABASE_URL with valid credentials",
    };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

async function main() {
  const rows = [];
  rows.push(await checkObservationDays());
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  rows.push(await checkLiveFills(url));
  rows.push(await checkPromotion(url));
  const kmsKey = checkEnvPresence("KMS_KEY_ID");
  const awsKey = checkEnvPresence("AWS_ACCESS_KEY_ID");
  const keystoreJson = checkEnvPresence("POLYROOT_KEYSTORE_JSON");
  const keystoreFile = checkEnvPresence("POLYROOT_KEYSTORE_FILE");
  const hasKeystore = keystoreJson || keystoreFile;
  rows.push(
    (kmsKey && awsKey) || hasKeystore
      ? {
          blocker: "Signing path (KMS/HSM or keystore)",
          status: "READY",
          detail: hasKeystore
            ? "POLYROOT_KEYSTORE_JSON/FILE present (keystore at rest)"
            : "KMS_KEY_ID + AWS credentials present (presence only, never printed)",
          remediation: null,
        }
      : {
          blocker: "Signing path (KMS/HSM or keystore)",
          status: "BLOCKED",
          detail: `KMS_KEY_ID ${kmsKey ? "present" : "missing"}, AWS credentials ${awsKey ? "present" : "missing"}, Keystore ${hasKeystore ? "present" : "missing"}`,
          remediation:
            "Option A: export KMS_KEY_ID + AWS credentials via systemd credentials\nOption B: seal key with 'polyroot wallet seal' and set POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE",
        },
  );
  let wrapper = "BLOCKED";
  let wrapperDetail = "eip712 module missing";
  try {
    const m = await import("@polyroot/signer");
    const fns = [
      "encodeField",
      "hashStruct",
      "signingDigest",
      "hashNested1271",
    ];
    const missing = fns.filter((f) => typeof m[f] !== "function");
    if (missing.length === 0) {
      wrapper = "READY";
      wrapperDetail =
        "offline EIP-712/7739 encoding present; on-chain validator call stays G4";
    } else {
      wrapperDetail = `missing exports: ${missing.join(", ")}`;
    }
  } catch (e) {
    wrapperDetail = `signer package not loadable: ${e instanceof Error ? e.message : String(e)}`;
  }
  rows.push({
    blocker: "POLY_1271 wrapper",
    status: wrapper,
    detail: wrapperDetail,
    remediation:
      wrapper === "READY"
        ? null
        : "complete the offline 1271 encoder, then schedule the validator-contract call (G4)",
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 1));
    return;
  }
  console.log("blocker | status | detail | remediation");
  for (const r of rows) {
    console.log(
      `${r.blocker} | ${r.status} | ${r.detail} | ${r.remediation ?? "-"}`,
    );
  }
  const blocked = rows.filter((r) => r.status === "BLOCKED").length;
  console.log(
    `live-readiness: ${rows.length - blocked}/${rows.length} ready (${blocked} blocked)`,
  );
}

await main();
