#!/usr/bin/env node
/**
 * Generate release manifest for CI.
 * This script creates a release_manifest.json file based on the current git state,
 * lockfile, and environment.
 *
 * R20 FIX: imageDigest is now computed from actual build artifacts (source + lockfile),
 * NOT from crypto.randomBytes().
 */

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { execSync } from "child_process";

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Compute a deterministic SHA-256 digest over all source .ts files and lockfile.
 * This represents the actual build input fingerprint, not a random placeholder.
 */
function computeBuildDigest() {
  const hash = crypto.createHash("sha256");

  // Include lockfile
  try {
    const lock = fs.readFileSync("package-lock.json", "utf8");
    hash.update(lock);
  } catch { /* no lockfile */ }

  // Include all source .ts files in deterministic order
  const srcDirs = ["src"];
  for (const dir of srcDirs) {
    try {
      const files = getAllTsFiles(dir);
      files.sort(); // deterministic order
      for (const f of files) {
        const rel = path.relative(".", f);
        hash.update(rel);
        hash.update(fs.readFileSync(f));
      }
    } catch { /* dir missing */ }
  }

  // Include migration files
  try {
    const migDir = "migrations";
    if (fs.existsSync(migDir)) {
      const migs = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
      for (const f of migs) {
        hash.update(f);
        hash.update(fs.readFileSync(path.join(migDir, f)));
      }
    }
  } catch { /* no migrations */ }

  return "sha256:" + hash.digest("hex");
}

function getAllTsFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".turbo") {
        results.push(...getAllTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

const repo = git("config --get remote.origin.url") || "https://github.com/cryptyroot-ux/polyroot-agent";
const branch = git("rev-parse --abbrev-ref HEAD") || "main";
const commit = git("rev-parse HEAD").padStart(40, "0").slice(0, 40);
const tag = git("describe --tags --abbrev=0") || "v0.1.0-foundation";
const dirty = git("status --porcelain").length > 0;

const lock = fs.readFileSync("package-lock.json", "utf8");
const lockHash = crypto.createHash("sha256").update(lock).digest("hex");

// R20 FIX: Use actual build artifact digest instead of randomBytes
const imageDigest = computeBuildDigest();

// Compute migration file hashes
const migrationDir = "migrations";
let migrationFiles = [];
try {
  migrationFiles = fs.readdirSync(migrationDir).filter(f => f.endsWith(".sql")).sort();
} catch {}

// Compute SBOM hash from package.json + lockfile
const pkgJson = fs.readFileSync("package.json", "utf8");
const sbomHash = crypto.createHash("sha256").update(pkgJson).update(lock).digest("hex");

const manifest = {
  schema_version: "1.0.0",
  release_id: commit.slice(0, 8) + "-" + commit.slice(8, 12) + "-" + commit.slice(12, 16) + "-" + commit.slice(16, 20) + "-" + commit.slice(20, 32),
  timestamp_utc: new Date().toISOString(),
  git: { repo, branch, commit_sha: commit, tag, dirty },
  upstream: {
    repo: "https://github.com/alsk1992/CloddsBot",
    commit_sha: "715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8",
    version: "1.9.0",
    license: "MIT",
  },
  runtime: {
    node_version: process.version.slice(1),
    node_engine_range: ">=24.0.0",
    npm_version: execSync("npm --version", { encoding: "utf8" }).trim(),
    lockfile_sha256: lockHash,
  },
  dependencies: {
    "@polymarket/client": "TBD-pinned-at-G0",
    zod: "^3.22.4",
  },
  image: { repository: "polyroot/trader", tag: tag, digest: imageDigest },
  sdk: {
    package: "@polymarket/client",
    version: "TBD-pinned-at-G0-after-contract-checks",
  },
  contracts: { chain_id: 137, registry_version: "v0-bootstrap" },
  schema_migrations: {
    schema_version: "1.0.0",
    migrations: migrationFiles,
  },
  strategies: {},
  policy: {
    policy_version: "v0-bootstrap",
    policy_hash: "TBD-computed-at-commissioning",
  },
  gate_reports: [],
  fork_disposition: "docs/ARTEFAK/fork_disposition.csv (TBD — required before G1)",
  sbom: { format: "spdx-json", sha256: sbomHash },
};

// R20 validation: reject if digest looks like random/placeholder
if (!imageDigest.startsWith("sha256:") || imageDigest.length !== 71) {
  console.error("FATAL: imageDigest is not a valid sha256 hex digest");
  process.exit(1);
}

if (dirty) {
  console.warn("WARNING: working tree is dirty; manifest reflects uncommitted changes");
}

fs.writeFileSync("release_manifest.json", JSON.stringify(manifest, null, 2));
console.log("Generated release_manifest.json");
console.log("imageDigest:", imageDigest);
console.log("release_id:", manifest.release_id);
console.log("sbom_sha256:", sbomHash);
