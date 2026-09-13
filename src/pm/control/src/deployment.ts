/**
 * @polyroot/control — Deployment workflow gates (PR-OPS-07, T-PR-OPS-07).
 *
 * Blue-green promotion is deliberately split into:
 * 1. immutable PAPER canary validation,
 * 2. explicit owner-approved LIVE promotion,
 * 3. rollback refusal when the candidate schema is incompatible.
 *
 * Validation never routes financial orders and never self-promotes to LIVE.
 */

export type DeploymentSlot = "BLUE" | "GREEN";
export type DeploymentMode = "PAPER" | "LIVE";

export interface DeploymentCandidate {
  /** Immutable release identifier from the release manifest. */
  releaseId: string;
  /** Image digest pinned for this rollout. */
  imageDigest: string;
  /** Database schema version carried by the candidate. */
  schemaVersion: string;
  /** Hash of the migration set carried by the candidate. */
  migrationHash: string;
  /** PAPER is validated automatically; LIVE requires explicit owner approval. */
  mode: DeploymentMode;
  /** Slot that should receive the candidate. */
  targetSlot: DeploymentSlot;
  /** Set only by an explicit owner-approved LIVE promotion. */
  ownerApproved?: boolean;
}

export interface DeploymentState {
  activeSlot: DeploymentSlot;
  activeReleaseId: string;
  activeSchemaVersion: string;
  activeMigrationHash: string;
  activeMode: DeploymentMode;
}

export type DeploymentDecision =
  | {
      ok: true;
      code: "PAPER_CANARY_READY" | "LIVE_PROMOTION_AUTHORIZED" | "ROLLBACK_ALLOWED";
      reason: string;
      targetSlot: DeploymentSlot;
    }
  | { ok: false; code: string; reason: string };

function compareSchemaVersions(left: string, right: string): -1 | 0 | 1 {
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Financial migrations are forward-only. A candidate may advance the schema,
 * but a candidate older than the active schema is never allowed to roll back.
 */
export function validateSchemaCompatibility(
  currentVersion: string,
  candidateVersion: string,
): { ok: boolean; code?: string; reason?: string; requiresMigration: boolean } {
  const comparison = compareSchemaVersions(candidateVersion, currentVersion);
  if (comparison < 0) {
    return {
      ok: false,
      code: "INCOMPATIBLE_SCHEMA_ROLLBACK",
      reason: `candidate schema ${candidateVersion} is older than active schema ${currentVersion}`,
      requiresMigration: false,
    };
  }
  if (comparison === 0) {
    return { ok: true, requiresMigration: false };
  }
  return { ok: true, requiresMigration: true };
}

export function validateDeploymentCandidate(
  candidate: DeploymentCandidate,
  current: DeploymentState,
): DeploymentDecision {
  if (!candidate.releaseId) {
    return { ok: false, code: "RELEASE_ID_REQUIRED", reason: "releaseId is required" };
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(candidate.imageDigest)) {
    return { ok: false, code: "IMAGE_DIGEST_INVALID", reason: "imageDigest must be sha256:<64 hex>" };
  }
  if (!candidate.migrationHash) {
    return { ok: false, code: "MIGRATION_HASH_REQUIRED", reason: "migrationHash is required" };
  }
  if (candidate.targetSlot === current.activeSlot) {
    return {
      ok: false,
      code: "TARGET_SLOT_INVALID",
      reason: `targetSlot must be the inactive slot, got ${candidate.targetSlot}`,
    };
  }

  const schema = validateSchemaCompatibility(current.activeSchemaVersion, candidate.schemaVersion);
  if (!schema.ok) {
    return { ok: false, code: schema.code ?? "INCOMPATIBLE_SCHEMA_ROLLBACK", reason: schema.reason ?? "incompatible schema" };
  }

  if (candidate.mode === "LIVE" && !candidate.ownerApproved) {
    return {
      ok: false,
      code: "LIVE_PROMOTION_REQUIRES_OWNER_APPROVAL",
      reason: "LIVE promotion requires explicit owner approval",
    };
  }
  if (candidate.mode === "LIVE" && current.activeMode === "LIVE") {
    return { ok: false, code: "ALREADY_LIVE", reason: "active deployment is already LIVE" };
  }

  if (candidate.mode === "PAPER") {
    return {
      ok: true,
      code: "PAPER_CANARY_READY",
      reason: schema.requiresMigration
        ? "PAPER canary validated; forward migration required before promotion"
        : "PAPER canary validated",
      targetSlot: candidate.targetSlot,
    };
  }

  return {
    ok: true,
    code: "LIVE_PROMOTION_AUTHORIZED",
    reason: "LIVE promotion authorized by owner",
    targetSlot: candidate.targetSlot,
  };
}

export function selectBlueGreenSlot(current: DeploymentState): DeploymentSlot {
  return current.activeSlot === "BLUE" ? "GREEN" : "BLUE";
}

export function planBlueGreenDeployment(
  current: DeploymentState,
  candidate: DeploymentCandidate,
): DeploymentDecision {
  const expectedSlot = selectBlueGreenSlot(current);
  if (candidate.targetSlot !== expectedSlot) {
    return {
      ok: false,
      code: "TARGET_SLOT_MISMATCH",
      reason: `candidate targets ${candidate.targetSlot}, expected ${expectedSlot}`,
    };
  }
  return validateDeploymentCandidate(candidate, current);
}

/**
 * Rollback is allowed only when the candidate carries the same schema as the
 * active deployment. This prevents an older binary from reading a newer DB.
 */
export function rollbackDeployment(
  current: DeploymentState,
  candidate: DeploymentCandidate,
): DeploymentDecision {
  if (candidate.schemaVersion !== current.activeSchemaVersion) {
    return {
      ok: false,
      code: "INCOMPATIBLE_SCHEMA_ROLLBACK",
      reason: `rollback to schema ${candidate.schemaVersion} refused; active schema is ${current.activeSchemaVersion}`,
    };
  }
  if (candidate.targetSlot === current.activeSlot) {
    return {
      ok: false,
      code: "ROLLBACK_SLOT_INVALID",
      reason: "rollback target must be the inactive slot",
    };
  }
  return {
    ok: true,
    code: "ROLLBACK_ALLOWED",
    reason: "schema-compatible rollback allowed",
    targetSlot: candidate.targetSlot,
  };
}
