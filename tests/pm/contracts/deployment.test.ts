import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSchemaCompatibility,
  validateDeploymentCandidate,
  planBlueGreenDeployment,
  rollbackDeployment,
  selectBlueGreenSlot,
  type DeploymentCandidate,
  type DeploymentState,
} from "@polyroot/control";

/**
 * PR-OPS-07 / T-PR-OPS-07: immutable release + rollback.
 *
 * Rollback is allowed ONLY when the candidate carries the same schema as
 * the active deployment. A candidate older than the active schema is refused
 * even when live orders remain reconcilable — the migration is forward-only.
 *
 * DeploymentMode is "LIVE" only: the PAPER/MICRO_LIVE/MICRO_LIVE canary ladder
 * has been removed, so every rollout now reaches real money and every LIVE
 * promotion demands explicit owner approval.
 */

const ACTIVE_LIVE: DeploymentState = {
  activeSlot: "BLUE",
  activeReleaseId: "rel-001",
  activeSchemaVersion: "1.1.0",
  activeMigrationHash: "sha256:m1",
  activeMode: "LIVE",
};

function candidate(
  overrides: Partial<DeploymentCandidate> = {},
): DeploymentCandidate {
  return {
    releaseId: "rel-002",
    imageDigest: "sha256:" + "a".repeat(64),
    schemaVersion: "1.1.0",
    migrationHash: "sha256:m1",
    mode: "LIVE",
    targetSlot: "GREEN",
    ...overrides,
  };
}

describe("PR-OPS-07 / T-PR-OPS-07: schema compatibility", () => {
  it("accepts a forward migration", () => {
    const r = validateSchemaCompatibility("1.1.0", "1.2.0");
    assert.equal(r.ok, true);
    assert.equal(r.requiresMigration, true);
  });

  it("accepts an equal schema", () => {
    const r = validateSchemaCompatibility("1.1.0", "1.1.0");
    assert.equal(r.ok, true);
    assert.equal(r.requiresMigration, false);
  });

  it("refuses an older schema (rollback)", () => {
    const r = validateSchemaCompatibility("1.2.0", "1.1.0");
    assert.equal(r.ok, false);
    assert.equal(r.code, "INCOMPATIBLE_SCHEMA_ROLLBACK");
  });
});

describe("PR-OPS-07 / T-PR-OPS-07: deployment candidate validation", () => {
  it("rejects a candidate without a release id", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), releaseId: "" },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "RELEASE_ID_REQUIRED");
  });

  it("rejects an invalid image digest", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), imageDigest: "not-a-digest" },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "IMAGE_DIGEST_INVALID");
  });

  it("rejects a candidate targeting the active slot", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), targetSlot: "BLUE" },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "TARGET_SLOT_INVALID");
  });

  it("rejects a candidate missing migration hash", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), migrationHash: "" },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "MIGRATION_HASH_REQUIRED");
  });

  it("refuses LIVE promotion without owner approval", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), ownerApproved: false },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "LIVE_PROMOTION_REQUIRES_OWNER_APPROVAL");
  });

  it("refuses LIVE promotion when already LIVE", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), ownerApproved: true },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ALREADY_LIVE");
  });

  it("refuses an older-schema candidate", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), schemaVersion: "1.0.0" },
      ACTIVE_LIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INCOMPATIBLE_SCHEMA_ROLLBACK");
  });
});

describe("PR-OPS-07 / T-PR-OPS-07: blue-green deployment", () => {
  it("selects the inactive slot", () => {
    assert.equal(selectBlueGreenSlot(ACTIVE_LIVE), "GREEN");
    assert.equal(
      selectBlueGreenSlot({ ...ACTIVE_LIVE, activeSlot: "GREEN" }),
      "BLUE",
    );
  });

  it("rejects a candidate targeting the wrong slot", () => {
    const r = planBlueGreenDeployment(ACTIVE_LIVE, {
      ...candidate(),
      targetSlot: "BLUE",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "TARGET_SLOT_MISMATCH");
  });
});

describe("PR-OPS-07 / T-PR-OPS-07: rollback", () => {
  it("refuses rollback to an older schema", () => {
    const r = rollbackDeployment(ACTIVE_LIVE, {
      ...candidate(),
      schemaVersion: "1.0.0",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INCOMPATIBLE_SCHEMA_ROLLBACK");
  });

  it("refuses rollback to the active slot", () => {
    const r = rollbackDeployment(ACTIVE_LIVE, {
      ...candidate(),
      targetSlot: "BLUE",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ROLLBACK_SLOT_INVALID");
  });
});
