#!/usr/bin/env node
/**
 * Traceability gate — FINAL PolyRoot v1.1 (96 PR-* requirements).
 * Source of truth: docs/implementation/FINAL_96_REQUIREMENTS.json
 * Each PR-* requirement carries a primary acceptance scenario T-PR-*
 * with the same priority. Exit 0 when the mapping is one-to-one and
 * priorities match; exit 1 with a diff report otherwise.
 * 
 * Legacy 124 PM-* pack is HISTORICAL_ONLY and no longer authoritative.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reqFile = resolve(root, "docs/implementation/FINAL_96_REQUIREMENTS.json");

const doc = JSON.parse(readFileSync(reqFile, "utf-8"));
const reqs = Array.isArray(doc) ? doc : doc.requirements;
if (!Array.isArray(reqs)) {
  console.error("FINAL_96_REQUIREMENTS.json: unexpected shape (expected list)");
  process.exit(1);
}

const idRe = /^PR-[A-Z]+-\d+$/;
const tIdRe = /^T-PR-[A-Z]+-\d+$/;

const reqMap = new Map();
for (const r of reqs) {
  const id = r?.id;
  if (typeof id !== "string" || !idRe.test(id)) {
    console.error(`BAD ID: ${JSON.stringify(id)}`);
    process.exitCode = 1;
    continue;
  }
  if (reqMap.has(id)) {
    console.error(`DUPLICATE ${id}`);
    process.exitCode = 1;
  }
  if (!(r.priority === "P0" || r.priority === "P1")) {
    console.error(`BAD priority ${id}: ${r.priority}`);
    process.exitCode = 1;
  }
  reqMap.set(id, { priority: r.priority, testId: r.test_id });
}

const tests = new Map();
for (const r of reqs) {
  const tid = r?.test_id;
  if (typeof tid !== "string" || !tIdRe.test(tid)) {
    console.error(`BAD test_id for ${r?.id}: ${JSON.stringify(tid)}`);
    process.exitCode = 1;
    continue;
  }
  if (tests.has(tid)) console.error(`DUPLICATE test ${tid}`);
  tests.set(tid, r.priority);
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};

const EXPECTED_COUNT = 96;
if (reqMap.size !== EXPECTED_COUNT) fail(`expected ${EXPECTED_COUNT} PR-* requirements, found ${reqMap.size}`);
if (tests.size !== EXPECTED_COUNT) fail(`expected ${EXPECTED_COUNT} T-PR-* scenarios, found ${tests.size}`);

const missingTests = [];
const missingReqs = [];
const prioMismatch = [];
for (const [id, { priority, testId }] of reqMap) {
  if (!tests.has(testId)) {
    missingTests.push(testId);
    fail(`requirement ${id} (${priority}) has no primary scenario ${testId}`);
  } else if (tests.get(testId) !== priority) {
    prioMismatch.push(`${id}: req=${priority} test=${tests.get(testId)}`);
    fail(`priority mismatch ${id}: req=${priority} test=${tests.get(testId)}`);
  }
}
for (const tid of tests.keys()) {
  const candidate = tid.slice(2); // strip "T-"
  const r = reqMap.get(candidate);
  if (!r || r.testId !== tid) {
    missingReqs.push(tid);
    fail(`scenario ${tid} has no matching requirement mapping`);
  }
}

const p0 = [...reqMap.values()].filter((r) => r.priority === "P0").length;
const p1 = reqMap.size - p0;
console.log(
  `requirements=${reqMap.size} (P0=${p0} P1=${p1}) scenarios=${tests.size} failures=${failures}`,
);
if (failures > 0) {
  console.error("Traceability gate FAILED (FINAL 96 baseline).");
  process.exit(1);
}
console.log(
  `Traceability gate PASSED: ${EXPECTED_COUNT}/${EXPECTED_COUNT} one-to-one with matching priorities.`,
);
