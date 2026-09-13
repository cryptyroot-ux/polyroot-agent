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
 */

const ACTIVE: DeploymentState = {
  activeSlot: "BLUE",
  activeReleaseId: "rel-001",
  activeSchemaVersion: "1.1.0",
  activeMigrationHash: "sha256:m1",
  activeMode: "PAPER",
};

function candidate(overrides: Partial<DeploymentCandidate> = {}): DeploymentCandidate {
  return {
    releaseId: "rel-002",
    imageDigest: "sha256:" + "a".repeat(64),
    schemaVersion: "1.1.0",
    migrationHash: "sha256:m1",
    mode: "PAPER",
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
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "RELEASE_ID_REQUIRED");
  });

  it("rejects an invalid image digest", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), imageDigest: "not-a-digest" },
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "IMAGE_DIGEST_INVALID");
  });

  it("rejects a candidate targeting the active slot", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), targetSlot: "BLUE" },
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "TARGET_SLOT_INVALID");
  });

  it("rejects a candidate missing migration hash", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), migrationHash: "" },
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "MIGRATION_HASH_REQUIRED");
  });

  it("accepts a PAPER canary on the inactive slot", () => {
    const r = validateDeploymentCandidate(candidate(), ACTIVE);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.code, "PAPER_CANARY_READY");
      assert.equal(r.targetSlot, "GREEN");
    }
  });

  it("refuses LIVE promotion without owner approval", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), mode: "LIVE" },
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "LIVE_PROMOTION_REQUIRES_OWNER_APPROVAL");
  });

  it("refuses LIVE promotion when already LIVE", () => {
    const live: DeploymentState = { ...ACTIVE, activeMode: "LIVE" };
    const r = validateDeploymentCandidate(
      { ...candidate(), mode: "LIVE", ownerApproved: true },
      live,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ALREADY_LIVE");
  });

  it("authorizes LIVE promotion with owner approval", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), mode: "LIVE", ownerApproved: true },
      ACTIVE,
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.code, "LIVE_PROMOTION_AUTHORIZED");
  });

  it("refuses an older-schema candidate even for PAPER", () => {
    const r = validateDeploymentCandidate(
      { ...candidate(), schemaVersion: "1.0.0" },
      ACTIVE,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INCOMPATIBLE_SCHEMA_ROLLBACK");
  });
});

describe("PR-OPS-07 / T-PR-OPS-07: blue-green deployment", () => {
  it("selects the inactive slot", () => {
    assert.equal(selectBlueGreenSlot(ACTIVE), "GREEN");
    assert.equal(
      selectBlueGreenSlot({ ...ACTIVE, activeSlot: "GREEN" }),
      "BLUE",
    );
  });

  it("rejects a candidate targeting the wrong slot", () => {
    const r = planBlueGreenDeployment(ACTIVE, { ...candidate(), targetSlot: "BLUE" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "TARGET_SLOT_MISMATCH");
  });

  it("accepts a blue-green PAPER candidate", () => {
    const r = planBlueGreenDeployment(ACTIVE, candidate());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.code, "PAPER_CANARY_READY");
  });
});

describe("PR-OPS-07 / T-PR-OPS-07: rollback", () => {
  it("allows a schema-compatible rollback to the inactive slot", () => {
    const r = rollbackDeployment(ACTIVE, candidate());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.code, "ROLLBACK_ALLOWED");
      assert.equal(r.targetSlot, "GREEN");
    }
  });

  it("refuses rollback to the active slot", () => {
    const r = rollbackDeployment(ACTIVE, { ...candidate(), targetSlot: "BLUE" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ROLLBACK_SLOT_INVALID");
  });

  it("refuses rollback to an older schema", () => {
    const r = rollbackDeployment(ACTIVE, {
      ...candidate(),
      schemaVersion: "1.0.0",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INCOMPATIBLE_SCHEMA_ROLLBACK");
  });
});
