/**
 * @polyroot/data — Stream frame ordering contracts (CT-23, PM-DATA-03).
 *
 * Market/user streams deliver snapshot + deltas with sequence numbers.
 * The contract: in-order deltas apply; duplicates are idempotent no-ops;
 * a missing sequence or a reconnect WITHOUT a fresh snapshot keeps the
 * frame stale (deltas alone never recover — see frame-freshness). Only a
 * snapshot at/after the gap re-establishes the frame.
 *
 * Pure functions (no I/O).
 */

export interface StreamFrame {
  lastAppliedSeq: number | null;
  gapDetected: boolean;
}

export type FrameApplyResult =
  | { ok: true; applied: boolean; lastAppliedSeq: number | null; note: string }
  | { ok: false; code: "FRAME_STALE"; reason: string };

/**
 * Apply one delta frame. Returns whether it was applied; duplicates and
 * out-of-order frames never move state backwards.
 */
export function applyStreamDelta(
  frame: StreamFrame,
  deltaSeq: number,
): FrameApplyResult {
  if (!Number.isInteger(deltaSeq) || deltaSeq < 0) {
    return {
      ok: false,
      code: "FRAME_STALE",
      reason: "invalid delta sequence",
    };
  }
  if (frame.gapDetected) {
    return {
      ok: false,
      code: "FRAME_STALE",
      reason: "gap open: deltas refused until snapshot recovery",
    };
  }
  if (frame.lastAppliedSeq === null) {
    return {
      ok: false,
      code: "FRAME_STALE",
      reason: "no baseline snapshot yet",
    };
  }
  if (deltaSeq <= frame.lastAppliedSeq) {
    return {
      ok: true,
      applied: false,
      lastAppliedSeq: frame.lastAppliedSeq,
      note: `duplicate/out-of-order delta ${deltaSeq} ignored`,
    };
  }
  if (deltaSeq > frame.lastAppliedSeq + 1) {
    return {
      ok: false,
      code: "FRAME_STALE",
      reason: `missing sequence: have ${frame.lastAppliedSeq}, got ${deltaSeq}`,
    };
  }
  return {
    ok: true,
    applied: true,
    lastAppliedSeq: deltaSeq,
    note: "delta applied in order",
  };
}

/**
 * Reconnect outcome: the frame recovers ONLY on a fresh snapshot at or
 * after the reconnect; bare reconnect without snapshot stays stale.
 */
export function reconnectFrame(input: {
  snapshotSeq: number | null;
  reconnectAt: number;
}): FrameApplyResult {
  if (input.snapshotSeq === null) {
    return {
      ok: false,
      code: "FRAME_STALE",
      reason: "reconnect without snapshot: frame stays stale",
    };
  }
  return {
    ok: true,
    applied: true,
    lastAppliedSeq: input.snapshotSeq,
    note: "snapshot recovery re-established the frame",
  };
}
