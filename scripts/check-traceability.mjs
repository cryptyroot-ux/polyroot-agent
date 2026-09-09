#!/usr/bin/env node
/**
 * Traceability gate — Specification pack v1.1 (124 PM-* requirements).
 * Source of truth: docs/spec_pack/.../Requirements_v1.1.json
 * Each PM-* requirement carries a primary acceptance scenario T-PM-*
 * with the same priority. Exit 0 when the mapping is one-to-one and
 * priorities match; exit 1 with a diff report otherwise.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reqFile = resolve(
  root,
  "docs/spec_pack/Polyroot_v1.1_Specification_Pack/Requirements_v1.1.json",
);

const doc = JSON.parse(readFileSync(reqFile, "utf-8"));
const reqs = Array.isArray(doc) ? doc : doc.requirements;
if (!Array.isArray(reqs)) {
  console.error("Requirements_v1.1.json: unexpected shape (expected list or {requirements: list})");
  process.exit(1);
}

const idRe = /^PM-[A-Z]+-\d+$/;
const tIdRe = /^T-PM-[A-Z]+-\d+$/;

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

if (reqMap.size !== 124) fail(`expected 124 PM-* requirements, found ${reqMap.size}`);
if (tests.size !== 124) fail(`expected 124 T-PM-* scenarios, found ${tests.size}`);

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
  console.error("Traceability gate FAILED (pack v1.1 baseline).");
  process.exit(1);
}
console.log(
  "Traceability gate PASSED: 124/124 one-to-one with matching priorities.",
);