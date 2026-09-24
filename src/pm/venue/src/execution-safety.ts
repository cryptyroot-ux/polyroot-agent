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
  at: Date | string;
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
  | {
      ok: false;
      code: "HEARTBEAT_STALE" | "HEARTBEAT_CONFLICT";
      reason: string;
    };

/**
 * Reconcile one heartbeat against observation. Success is NEVER fabricated:
 * only ids present on BOTH sides count as reconciled; the rest stay unknown.
 * A heartbeat id claimed by a DIFFERENT writer is a conflict (two writers),
 * and an older sequence for the same id is stale — both refuse.
 */
export function reconcileHeartbeat(
  record: HeartbeatRecord,
  observation: HeartbeatObservation,
  opts?: { maxAgeMs?: number; maxClockSkewMs?: number; now?: Date },
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
  const recordAt = record.at instanceof Date ? record.at : new Date(record.at);
  if (Number.isNaN(recordAt.getTime())) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: "heartbeat record timestamp is invalid",
    };
  }
  if (now.getTime() - recordAt.getTime() > maxAgeMs) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: "heartbeat record expired; re-observe before reconciling",
    };
  }
  // Adversarial fix (Phase 28): a record dated in the future (beyond clock
  // skew) cannot be reconciled — its "evidence" postdates the observation.
  const maxSkew = opts?.maxClockSkewMs ?? 5_000;
  if (recordAt.getTime() - now.getTime() > maxSkew) {
    return {
      ok: false,
      code: "HEARTBEAT_STALE",
      reason: "heartbeat record is future-dated beyond clock skew",
    };
  }
  const observed = new Set(observation.observedCancelled);
  const reconciled = record.expectedCancelled.filter((id) => observed.has(id));
  const stillUnknown = record.expectedCancelled.filter(
    (id) => !observed.has(id),
  );
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
  | {
      ok: false;
      code: "FEE_BOUND_EXCEEDED";
      reason: string;
      feeToRetain: number;
    };

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
  // Adversarial fix (Phase 28): a negative "fee" is not a cheap fill — it
  // is a miscoded rebate flowing the wrong way. Costs are non-negative;
  // rebates travel the incentive ledger, never the fee path.
  if (quotedFeeBound < 0 || observedFee < 0) {
    return {
      ok: false,
      code: "FEE_BOUND_EXCEEDED",
      reason: "negative fee measurement; path blocked",
      feeToRetain: observedFee < 0 ? 0 : observedFee,
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

/* ─── CT-18: post-only crossing ──────────────────────────────────── */

export type PostOnlyVerdict =
  | { ok: true; note: string }
  | { ok: false; code: "POST_ONLY_CROSSING"; reason: string };

/**
 * CT-18: a post-only order that would cross the book is REJECTED — never
 * silently converted to a taker. BUY must rest strictly below best ask;
 * SELL strictly above best bid.
 */
export function checkPostOnly(
  side: "BUY" | "SELL",
  price: number,
  bestBid: number,
  bestAsk: number,
): PostOnlyVerdict {
  for (const [name, v] of [
    ["price", price],
    ["bestBid", bestBid],
    ["bestAsk", bestAsk],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      return {
        ok: false,
        code: "POST_ONLY_CROSSING",
        reason: `invalid ${name} for post-only check`,
      };
    }
  }
  if (side === "BUY" && price >= bestAsk) {
    return {
      ok: false,
      code: "POST_ONLY_CROSSING",
      reason: `BUY ${price} would cross best ask ${bestAsk}; rejected, not converted to taker`,
    };
  }
  if (side === "SELL" && price <= bestBid) {
    return {
      ok: false,
      code: "POST_ONLY_CROSSING",
      reason: `SELL ${price} would cross best bid ${bestBid}; rejected, not converted to taker`,
    };
  }
  return { ok: true, note: "post-only rests without crossing" };
}

/* ─── CT-16: GTC/GTD expiration ──────────────────────────────────── */

export type OrderTimeInForce = "GTC" | "GTD" | "FOK" | "FAK";

export type ExpiryVerdict =
  | { ok: true; note: string }
  | { ok: false; code: "ORDER_EXPIRED" | "GTD_TOO_SOON"; reason: string };

/**
 * CT-16: time-in-force deadlines. GTD requires a future expiry at least
 * `minFutureMs` out (covers the venue's security offset + minimum future
 * expiry); GTC/FOK/FAK carry no venue expiry. An already-expired deadline
 * refuses — there is no silent fallback to GTC to make a request acceptable.
 */
export function validateOrderExpiry(input: {
  tif: OrderTimeInForce;
  expiresAt?: Date | string | null;
  now?: Date;
  minFutureMs?: number;
}): ExpiryVerdict {
  const now = input.now ?? new Date();
  if (input.tif === "GTC" || input.tif === "FOK" || input.tif === "FAK") {
    return { ok: true, note: `${input.tif} carries no venue expiry` };
  }
  if (input.expiresAt == null) {
    return {
      ok: false,
      code: "ORDER_EXPIRED",
      reason: "GTD requires an explicit future expiry",
    };
  }
  const expires =
    input.expiresAt instanceof Date
      ? input.expiresAt
      : new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime())) {
    return {
      ok: false,
      code: "ORDER_EXPIRED",
      reason: "GTD expiry is not a valid timestamp",
    };
  }
  const minFutureMs = input.minFutureMs ?? 180_000;
  if (expires.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "ORDER_EXPIRED",
      reason: "GTD expiry is already past",
    };
  }
  if (expires.getTime() - now.getTime() < minFutureMs) {
    return {
      ok: false,
      code: "GTD_TOO_SOON",
      reason: `GTD expiry must be at least ${minFutureMs}ms in the future`,
    };
  }
  return { ok: true, note: "GTD expiry satisfies minimum future bound" };
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
