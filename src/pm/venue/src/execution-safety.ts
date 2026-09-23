/**
 * @polyroot/venue — Execution safety contracts (FT-09, FT-10, FT-24, FT-25).
 *
 * Fail-closed guards for a degrading venue, all pure (no I/O):
 *
 *   FT-09 heartbeat loss — an expired heartbeat id, or two writers sharing
 *           one id, never fabricates success: expected cancellations are
 *           reconciled against observations, unknowns stay unknown.
 *   FT-10 engine restart (HTTP 425) — stop new orders, cancel best effort,
 *           reconcile when reachable. A 425 is a venue-state signal, not a
 *           retryable error.
 *   FT-24 fee changes — a fee observed at matching above the quoted bound
 *           blocks the path (or proceeds only with the ledger retaining the
 *           ACTUAL fee). The bound is proven or the path is blocked.
 *   FT-25 tick/minimum changes — metadata changed after the quote is
 *           revalidated; prices round DOWN to tick (never up past the cap),
 *           sizes round DOWN to minimum multiples; nothing ever enlarges
 *           beyond the authorized cap.
 */

export type SafetyCode =
  | "HEARTBEAT_STALE"
  | "HEARTBEAT_CONFLICT"
  | "ENGINE_RESTARTING"
  | "FEE_BOUND_EXCEEDED"
  | "TICK_REVALIDATED";

/* ─── FT-09: heartbeat reconciliation ──────────────────────────────── */

export interface HeartbeatRecord {
  heartbeatId: string;
  writerId: string;
  /** Monotonic sequence per writer; replays/duplicates share it. */
  sequence: number;
  at: Date;
  /** Order ids the writer expected cancelled as of this heartbeat. */
  expectedCancelled: string[];
}

export interface HeartbeatObservation {
  heartbeatId: string;
  writerId: string;
  sequence: number;
  /** Order ids actually observed cancelled. */
  observedCancelled: string[];
}

export type HeartbeatVerdict =
  | { ok: true; reconciled: string[]; stillUnknown: string[] }
  | { ok: false; code: "HEARTBEAT_STALE" | "HEARTBEAT_CONFLICT"; reason: string };

/**
 * Reconcile one heartbeat against observation. Success is NEVER fabricated:
 * only ids present on BOTH sides count as reconciled; the rest stay unknown.
 * A heartbeat id claimed by a DIFFERENT writer is a conflict (two writers),
 * and an older sequence for the same id is stale — both refuse.
 */
export function reconcileHeartbeat(
  record: HeartbeatRecord,
  observation: HeartbeatObservation,
  opts?: { maxAgeMs?: number; now?: Date },
): HeartbeatVerdict {
  const now = opts?.now ?? new Date();
  const maxAgeMs = opts?.maxAgeMs ?? 60_000;
  if (record.heartbeatId !== observation.heartbeatId) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: "heartbeat id mismatch: observation is for another heartbeat",
    };
  }
  if (record.writerId !== observation.writerId) {
    return {
      ok: false,
      code: "HEARTBEAT_CONFLICT",
      reason: `two writers claim heartbeat ${record.heartbeatId}`,
    };
  }
  if (observation.sequence < record.sequence) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: `observation sequence ${observation.sequence} older than recorded ${record.sequence}`,
    };
  }
  if (now.getTime() - record.at.getTime() > maxAgeMs) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: "heartbeat record expired; re-observe before reconciling",
    };
  }
  const observed = new Set(observation.observedCancelled);
  const reconciled = record.expectedCancelled.filter((id) => observed.has(id));
  const stillUnknown = record.expectedCancelled.filter((id) => !observed.has(id));
  return { ok: true, reconciled, stillUnknown };
}

/* ─── FT-10: engine restart (HTTP 425) ─────────────────────────────── */

export type RestartMode = "STOP_NEW" | "CANCEL_BEST_EFFORT" | "RECONCILE";

export interface RestartDirective {
  mode: RestartMode;
  newOrders: "BLOCKED";
  cancel: "BEST_EFFORT";
  reconcileWhenReachable: true;
  reason: string;
}

/**
 * HTTP 425 (or explicit restart signal) is venue-state, not an error to
 * retry through: new orders stop, cancels go best-effort, and everything
 * outstanding reconciles when the venue is reachable again.
 */
export function onEngineRestarting(detail?: string): RestartDirective {
  return {
    mode: "STOP_NEW",
    newOrders: "BLOCKED",
    cancel: "BEST_EFFORT",
    reconcileWhenReachable: true,
    reason: detail ?? "venue reports 425: engine restarting",
  };
}

/* ─── FT-24: fee revalidation at matching ──────────────────────────── */

export type FeeVerdict =
  | { ok: true; feeToRetain: number; note: string }
  | { ok: false; code: "FEE_BOUND_EXCEEDED"; reason: string; feeToRetain: number };

/**
 * The fee observed at matching time must fit the quoted bound. When it does
 * not, the path is blocked — and the LEDGER still retains the ACTUAL fee
 * (never the optimistic quote) so accounting never understates cost.
 */
export function revalidateFee(
  quotedFeeBound: number,
  observedFee: number,
): FeeVerdict {
  if (!Number.isFinite(quotedFeeBound) || !Number.isFinite(observedFee)) {
    return {
      ok: false,
      code: "FEE_BOUND_EXCEEDED",
      reason: "non-finite fee measurement; path blocked",
      feeToRetain: Number.isFinite(observedFee) ? observedFee : 0,
    };
  }
  if (observedFee <= quotedFeeBound) {
    return {
      ok: true,
      feeToRetain: observedFee,
      note: "observed fee within quoted bound",
    };
  }
  return {
    ok: false,
    code: "FEE_BOUND_EXCEEDED",
    reason: `observed fee ${observedFee} exceeds quoted bound ${quotedFeeBound}`,
    feeToRetain: observedFee,
  };
}

/* ─── FT-25: tick/minimum revalidation ─────────────────────────────── */

export interface TickRule {
  tickSize: number;
  minSize: number;
}

export type TickVerdict =
  | { ok: true; price: number; size: number; note: string }
  | { ok: false; code: "TICK_REVALIDATED"; reason: string };

/**
 * Revalidate price/size against venue metadata that may have changed after
 * the quote. Rounding is ALWAYS down (toward safety): prices down to tick,
 * sizes down to minimum multiples. Rounding must never enlarge an order
 * beyond its authorized cap — a size that rounds to zero (or below the new
 * minimum) refuses instead of trading dust.
 */
export function revalidateTick(
  price: number,
  size: number,
  rule: TickRule,
  cap: number,
): TickVerdict {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    !(rule.tickSize > 0) ||
    !(rule.minSize > 0) ||
    !(cap > 0)
  ) {
    return {
      ok: false,
      code: "TICK_REVALIDATED",
      reason: "invalid price/size/rule/cap measurement",
    };
  }
  const safePrice = Math.floor(price / rule.tickSize) * rule.tickSize;
  const safeSize = Math.floor(size / rule.minSize) * rule.minSize;
  if (safePrice <= 0 || safeSize <= 0) {
    return {
      ok: false,
      code: "TICK_REVALIDATED",
      reason: `revalidation rounds to zero (price=${safePrice}, size=${safeSize}); refusing dust`,
    };
  }
  if (safePrice > price || safeSize > size) {
    return {
      ok: false,
      code: "TICK_REVALIDATED",
      reason: "internal error: rounding enlarged the order",
    };
  }
  const notional = safePrice * safeSize;
  if (notional > cap) {
    return {
      ok: false,
      code: "TICK_REVALIDATED",
      reason: `revalidated notional ${notional} exceeds authorized cap ${cap}`,
    };
  }
  return {
    ok: true,
    price: safePrice,
    size: safeSize,
    note: "revalidated within tick/minimum/cap",
  };
}
