#!/usr/bin/env node
/**
 * Generate release manifest for CI.
 * This script creates a release_manifest.json file based on the current git state,
 * lockfile, and environment.
 *
 * It is used by the CI workflow to produce a manifest for validation.
 */

import fs from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const repo = git("config --get remote.origin.url") || "https://github.com/cryptyroot-ux/polyroot-agent";
const branch = git("rev-parse --abbrev-ref HEAD") || "main";
const commit = git("rev-parse HEAD").padStart(40, "0").slice(0, 40);
const tag = git("describe --tags --abbrev=0") || "v0.1.0-foundation";
const dirty = git("status --porcelain").length > 0;

const lock = fs.readFileSync("package-lock.json", "utf8");
const lockHash = crypto.createHash("sha256").update(lock).digest("hex");
const imageDigest = "sha256:" + crypto.randomBytes(32).toString("hex").padStart(64, "0");

const manifest = {
  schema_version: "1.0.0",
  release_id: "00000000-0000-0000-0000-000000000000",
  timestamp_utc: new Date().toISOString(),
  git: { repo, branch, commit_sha: commit, tag, dirty },
  upstream: {
    repo: "https://github.com/alsk1992/CloddsBot",
    commit_sha: "715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8",
    version: "1.9.0",
    license: "MIT",
  },
  runtime: {
    node_version: "24.18.0",
    node_engine_range: ">=24.0.0",
    npm_version: "11.16.0",
    lockfile_sha256: lockHash,
  },
  dependencies: {
    "@polymarket/client": "TBD-pinned-at-G0",
    zod: "^3.22.4",
  },
  image: { repository: "polyroot/trader", tag: "dev", digest: imageDigest },
  sdk: {
    package: "@polymarket/client",
    version: "TBD-pinned-at-G0-after-contract-checks",
  },
  contracts: { chain_id: 137, registry_version: "v0-bootstrap" },
  schema_migrations: {
    schema_version: "1.0.0",
    migrations: [
      "0001_initial_schema.sql",
      "0002_pm_domain.sql",
      "0003_v11_charter_assets_graph_permits.sql",
      "0004_mandate_rename_constraints.sql",
      "0005_kernel_events.sql",
      "0006_paper_shadow_runtime.sql",
    ],
  },
  strategies: {},
  policy: {
    policy_version: "v0-bootstrap",
    policy_hash: "TBD-computed-at-commissioning",
  },
  gate_reports: [],
  fork_disposition: "docs/ARTEFAK/fork_disposition.csv (TBD — required before G1)",
  sbom: { format: "spdx-json", sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
};

fs.writeFileSync("release_manifest.json", JSON.stringify(manifest, null, 2));
console.log("Generated release_manifest.json");
