/**
 * @polyroot/strategy — Research integrity contracts (PRD G3, Blueprint §13).
 *
 * Covers fault-matrix FT-37…FT-41: the anti-selection-bias machinery that
 * makes prospective PAPER/SHADOW evidence trustworthy —
 *
 *   FT-38 denominator audit — a report that retains only winners fails the
 *           denominator audit; the experiment is not eligible.
 *   FT-39 holdout reuse — a threshold tweaked after a holdout peek spends a
 *           new trial budget; the old holdout exposure stays recorded.
 *   FT-40 provider alias drift — a changed fingerprint opens a new
 *           lineage/calibration segment; a hidden change is UNKNOWN.
 *   FT-37 hot cleanup — a reference-count pin blocks deletion of live raw
 *           objects; replay re-verifies content hashes.
 *   FT-41 optimistic fills — proven via the reality-gap gate (runtime):
 *           inflated paper fills must FAIL, see reality-gap tests.
 *
 * Pure functions + one tiny in-memory pin registry (no I/O): the durable
 * projections live in the experiment/shadow stores; these contracts decide
 * what those stores are allowed to accept.
 */

export type IntegrityCode =
  | "DENOMINATOR_MISMATCH"
  | "SURVIVORSHIP_BIAS"
  | "HOLDOUT_REUSE"
  | "LINEAGE_DRIFT"
  | "LINEAGE_UNKNOWN"
  | "PINNED_REFUSAL"
  | "REPLAY_HASH_MISMATCH";

export type IntegrityResult =
  | { ok: true }
  | { ok: false; code: IntegrityCode; reason: string };

/* ─── FT-38: denominator audit ─────────────────────────────────────── */

export function auditDenominator(
  reportedIds: string[],
  universeIds: string[],
): IntegrityResult {
  if (universeIds.length === 0) {
    return {
      ok: false,
      code: "DENOMINATOR_MISMATCH",
      reason: "empty universe: no denominator to audit against",
    };
  }
  const universe = new Set(universeIds);
  const outside = reportedIds.filter((id) => !universe.has(id));
  if (outside.length > 0) {
    return {
      ok: false,
      code: "SURVIVORSHIP_BIAS",
      reason: `${outside.length} reported id(s) outside the universe log (e.g. ${outside[0]})`,
    };
  }
  return { ok: true };
}

/* ─── FT-39: holdout reuse ─────────────────────────────────────────── */

export interface HoldoutExposure {
  /** Holdout ids the tuner has peeked at (recorded, never erased). */
  peekedHoldoutIds: string[];
}

export interface RetuneProposal {
  /** Holdout ids the new threshold would be evaluated on. */
  holdoutIds: string[];
  /** Whether any threshold/parameter changed since the last trial. */
  thresholdTweaked: boolean;
}

export type HoldoutVerdict =
  | {
      ok: true;
      /** True when the proposal must spend a new trial budget. */
      requiresNewTrial: false;
      /** The exposure record that must be preserved alongside the new trial. */
      preservedExposure: HoldoutExposure;
    }
  | {
      ok: false;
      code: "HOLDOUT_REUSE";
      reason: string;
      requiresNewTrial: true;
      preservedExposure: HoldoutExposure;
    };

/**
 * A threshold tweaked after a holdout peek contaminates that holdout:
 * the proposal is only valid as a NEW trial (spending budget), and the
 * old exposure record must travel with it. Untweaked re-runs on
 * unpeeked holdouts pass through.
 */
export function checkHoldoutReuse(
  exposure: HoldoutExposure,
  proposal: RetuneProposal,
): HoldoutVerdict {
  const peeked = new Set(exposure.peekedHoldoutIds);
  const reused = proposal.holdoutIds.filter((id) => peeked.has(id));
  if (proposal.thresholdTweaked && reused.length > 0) {
    return {
      ok: false,
      code: "HOLDOUT_REUSE",
      reason: `threshold tweaked after peeking holdout(s): ${reused.join(", ")}`,
      requiresNewTrial: true,
      preservedExposure: { peekedHoldoutIds: [...exposure.peekedHoldoutIds] },
    };
  }
  return {
    ok: true,
    requiresNewTrial: false,
    preservedExposure: { peekedHoldoutIds: [...exposure.peekedHoldoutIds] },
  };
}

/* ─── FT-40: provider alias drift ──────────────────────────────────── */

export type LineageSegment = "SAME" | "NEW";
export type CalibrationState = "VALID" | "UNKNOWN";

export interface LineageDriftVerdict {
  segment: LineageSegment;
  calibration: CalibrationState;
  reason: string;
}

/**
 * Compare resolved model fingerprints across two observations.
 * A changed fingerprint opens a NEW lineage/calibration segment.
 * A hidden change (null/UNKNOWN on either side) is UNKNOWN — never
 * silently treated as the same backend (Blueprint §6.2).
 */
export function segmentOnLineageDrift(
  previousFingerprint: string | null | undefined,
  currentFingerprint: string | null | undefined,
): LineageDriftVerdict {
  const prev = previousFingerprint ?? "UNKNOWN";
  const curr = currentFingerprint ?? "UNKNOWN";
  if (prev === "UNKNOWN" || curr === "UNKNOWN") {
    return {
      segment: "NEW",
      calibration: "UNKNOWN",
      reason: `provider hid the change (prev=${prev}, curr=${curr}); treat as new uncalibrated segment`,
    };
  }
  if (prev !== curr) {
    return {
      segment: "NEW",
      calibration: "VALID",
      reason: `fingerprint drift ${prev} -> ${curr}; new calibration segment`,
    };
  }
  return {
    segment: "SAME",
    calibration: "VALID",
    reason: "fingerprint stable; calibration carries over",
  };
}

/* ─── FT-37: reference-count pin + replay hash verify ──────────────── */

export class RefPinRegistry {
  private readonly counts = new Map<string, number>();

  acquire(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  release(id: string): void {
    const n = (this.counts.get(id) ?? 0) - 1;
    if (n <= 0) this.counts.delete(id);
    else this.counts.set(id, n);
  }

  pinned(id: string): boolean {
    return (this.counts.get(id) ?? 0) > 0;
  }

  /**
   * Hot cleanup: delete only unpinned ids. Pinned live objects are
   * retained and reported — never force-removed under a running replay.
   */
  cleanup(ids: string[]): { deleted: string[]; retained: string[] } {
    const deleted: string[] = [];
    const retained: string[] = [];
    for (const id of ids) {
      if (this.pinned(id)) retained.push(id);
      else deleted.push(id);
    }
    return { deleted, retained };
  }
}

export function verifyReplayHashes(
  records: Array<{ id: string; hash: string }>,
  expected: ReadonlyMap<string, string> | Record<string, string>,
): IntegrityResult {
  const get =
    expected instanceof Map
      ? (id: string) => expected.get(id)
      : (id: string) => (expected as Record<string, string>)[id];
  for (const record of records) {
    const want = get(record.id);
    if (want === undefined || want !== record.hash) {
      return {
        ok: false,
        code: "REPLAY_HASH_MISMATCH",
        reason: `replay hash mismatch for ${record.id}`,
      };
    }
  }
  return { ok: true };
}
