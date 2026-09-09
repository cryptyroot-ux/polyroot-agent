#!/usr/bin/env node
/**
 * Traceability gate — PRD v1.1 P12.1 Definition of Done (documents):
 * "PRD and Blueprint use the same 96 IDs, priorities, owners/gates and
 * primary test IDs." Each PR-* requirement maps one-to-one to a T-PR-*
 * primary acceptance scenario with the same priority.
 *
 * Usage: node scripts/check-traceability.mjs
 * Exit 0 when traceable, 1 with a diff report otherwise.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function extractIds(doc, prefix) {
  // Tables are arrays of rows; the ID cell looks like "PR-GOV-01\nP0".
  const found = new Map();
  for (const table of doc.tables ?? []) {
    for (const row of table) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const cell = String(row[0]);
      const m = cell.match(new RegExp(`^(${prefix}-[A-Z]+-\\d+)\\n(P0|P1)`));
      if (m) {
        if (found.has(m[1])) {
          console.error(`DUPLICATE ${m[1]} in ${prefix} source`);
          process.exitCode = 1;
        }
        found.set(m[1], m[2]);
      }
    }
  }
  return found;
}

const prd = JSON.parse(
  readFileSync(resolve(root, "docs/PRD_v1.1_clean.txt"), "utf-8"),
);
const bp = JSON.parse(
  readFileSync(resolve(root, "docs/BLUEPRINT_v1.1_clean.txt"), "utf-8"),
);

const reqs = extractIds(prd, "PR");
const tests = extractIds(bp, "T-PR");

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};

if (reqs.size !== 96) fail(`expected 96 PR-* requirements, found ${reqs.size}`);
if (tests.size !== 96)
  fail(`expected 96 T-PR-* scenarios, found ${tests.size}`);

for (const [id, prio] of reqs) {
  const tid = `T-${id}`;
  if (!tests.has(tid)) {
    fail(`requirement ${id} (${prio}) has no primary scenario ${tid}`);
  } else if (tests.get(tid) !== prio) {
    fail(
      `priority mismatch ${id}: PRD=${prio} Blueprint=${tests.get(tid)} (${tid})`,
    );
  }
}
for (const tid of tests.keys()) {
  const id = tid.replace(/^T-/, "");
  if (!reqs.has(id)) fail(`scenario ${tid} has no PRD requirement ${id}`);
}

const p0 = [...reqs.values()].filter((p) => p === "P0").length;
const p1 = reqs.size - p0;
console.log(
  `requirements=${reqs.size} (P0=${p0} P1=${p1}) scenarios=${tests.size} failures=${failures}`,
);
if (failures > 0) {
  console.error("Traceability gate FAILED (P12.1).");
  process.exit(1);
}
console.log(
  "Traceability gate PASSED: 96/96 one-to-one with matching priorities.",
);
