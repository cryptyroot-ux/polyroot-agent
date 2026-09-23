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
      remediation: "export TEST_DATABASE_URL=postgresql://... (read-only user is enough)",
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
      ? { blocker: "prospective observation", status: "READY", detail: `${days}/30 days`, remediation: null }
      : {
          blocker: "prospective observation",
          status: "BLOCKED",
          detail: `${days}/30 days`,
          remediation: "keep the SHADOW loop running; re-run this rehearsal daily",
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

async function main() {
  const rows = [];
  rows.push(await checkObservationDays());
  rows.push({
    blocker: "authenticated live fills",
    status: "BLOCKED",
    detail: "no fill evidence supplied to this rehearsal",
    remediation: "run micro-LIVE calibration, then point FILL_EVIDENCE_REF at its journal",
  });
  const kmsKey = checkEnvPresence("KMS_KEY_ID");
  const awsKey = checkEnvPresence("AWS_ACCESS_KEY_ID");
  rows.push(
    kmsKey && awsKey
      ? {
          blocker: "KMS/HSM signing path",
          status: "READY",
          detail: "KMS_KEY_ID + AWS credentials present (presence only, never printed)",
          remediation: null,
        }
      : {
          blocker: "KMS/HSM signing path",
          status: "BLOCKED",
          detail: `KMS_KEY_ID ${kmsKey ? "present" : "missing"}, AWS credentials ${awsKey ? "present" : "missing"}`,
          remediation: "export KMS_KEY_ID + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY via systemd credentials (never in chat/logs)",
        },
  );
  let wrapper = "BLOCKED";
  let wrapperDetail = "eip712 module missing";
  try {
    const m = await import("@polyroot/signer");
    const fns = ["encodeField", "hashStruct", "signingDigest", "hashNested1271"];
    const missing = fns.filter((f) => typeof m[f] !== "function");
    if (missing.length === 0) {
      wrapper = "READY";
      wrapperDetail = "offline EIP-712/7739 encoding present; on-chain validator call stays G4";
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
    console.log(`${r.blocker} | ${r.status} | ${r.detail} | ${r.remediation ?? "-"}`);
  }
  const blocked = rows.filter((r) => r.status === "BLOCKED").length;
  console.log(`live-readiness: ${rows.length - blocked}/${rows.length} ready (${blocked} blocked)`);
}

await main();
