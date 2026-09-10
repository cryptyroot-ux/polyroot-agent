import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReleaseManifest, assertDependencyResolved } from "@polyroot/control";

describe("PR-GOV-01 / T-PR-GOV-01: controlled fork baseline", () => {
  const valid = {
    schema_version: "1.1.0",
    upstream: { repo: "alsk1992/CloddsBot", commit: "715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8", license: "MIT" },
    dependencies: {
      "@polymarket/clob-client": { version: "0.9.0", resolved: true, disposition: "ADAPT" },
      "legacy-signer": { version: "old", resolved: false, disposition: "REMOVE" },
    },
    migrations: ["0001_initial_schema.sql", "0006_paper_shadow_runtime.sql"],
    schema_version_db: "1.1.0",
  };

  it("accepts a manifest with every path disposed and hashes pinned", () => {
    const parsed = parseReleaseManifest(JSON.stringify(valid));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const dep = assertDependencyResolved(parsed.manifest, "@polymarket/clob-client");
      assert.equal(dep.ok, true);
    }
  });

  it("rejects a manifest with an unresolved upstream financial path", () => {
    const parsed = parseReleaseManifest(JSON.stringify(valid));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const bad = assertDependencyResolved(parsed.manifest, "legacy-signer");
      assert.equal(bad.ok, false);
    }
  });

  it("rejects malformed JSON / missing schema_version", () => {
    assert.equal(parseReleaseManifest("{not json").ok, false);
    assert.equal(parseReleaseManifest(JSON.stringify({ dependencies: {} })).ok, false);
  });
});