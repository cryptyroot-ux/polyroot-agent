/**
 * @polyroot/data — Frame freshness contract (FT-28, PM-DATA-03).
 *
 * After a WebSocket gap (reconnect, out-of-order deltas), derived features
 * stay STALE until a full snapshot recovery — deltas alone can never revive
 * them, and out-of-order deltas are ignored, never applied backwards.
 * Age beyond maxMessageAgeMs is stale regardless of transport health.
 *
 * Pure function (no I/O): timestamps in ms since epoch.
 */

export type FreshnessCode = "FRESH" | "STALE_GAP" | "STALE_AGE";

export interface FreshnessResult {
  fresh: boolean;
  code: FreshnessCode;
  reason: string;
}

export function frameFreshness(input: {
  /** Timestamp of the last full snapshot. */
  lastSnapshotAt: number;
  /** Timestamp a transport gap was detected, or null if none. */
  gapDetectedAt: number | null;
  now: number;
  maxAgeMs: number;
}): FreshnessResult {
  for (const [name, v] of [
    ["lastSnapshotAt", input.lastSnapshotAt],
    ["now", input.now],
    ["maxAgeMs", input.maxAgeMs],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      return {
        fresh: false,
        code: "STALE_AGE",
        reason: `invalid measurement: ${name} must be finite non-negative`,
      };
    }
  }
  if (input.gapDetectedAt !== null) {
    if (!Number.isFinite(input.gapDetectedAt) || input.gapDetectedAt < 0) {
      return {
        fresh: false,
        code: "STALE_GAP",
        reason: "invalid gap marker: fail closed until snapshot recovery",
      };
    }
    // Only a snapshot strictly AFTER the gap recovers: deltas that arrived
    // during/after the outage may be reordered or partial.
    if (!(input.lastSnapshotAt > input.gapDetectedAt)) {
      return {
        fresh: false,
        code: "STALE_GAP",
        reason: "features stale until snapshot recovery after the gap",
      };
    }
  }
  if (input.now - input.lastSnapshotAt > input.maxAgeMs) {
    return {
      fresh: false,
      code: "STALE_AGE",
      reason: `snapshot age ${input.now - input.lastSnapshotAt}ms exceeds ${input.maxAgeMs}ms`,
    };
  }
  return { fresh: true, code: "FRESH", reason: "snapshot current, no gap" };
}
