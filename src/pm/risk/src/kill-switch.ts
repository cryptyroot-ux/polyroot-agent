/**
 * @polyroot/risk — Kill switch (PM-RISK-05) and reduction paths (PM-RISK-06).
 *
 * The kill switch is a monotonic escalation lattice; activation is a side
 * effect the caller persists (never derived from market state). Every action
 * here is a *plan* the caller executes against real orders/positions: no
 * cancel/fill is ever claimed successful without an observed result.
 *
 *   NONE -> PAUSE_ENTRIES -> CANCEL_OPEN -> FLATTEN
 *
 * - PAUSE_ENTRIES: blocks queued intents and new worker submissions
 *   (TEST PM-RISK-05: kill switch blocks queued intent and new worker).
 * - CANCEL_OPEN: additionally plans cancellation of open orders; each order
 *   keeps its own observable status, and a failed cancel is surfaced as
 *   CANCEL_FAILED — never silently reported as cancelled.
 * - FLATTEN: a separate action with its own price cap, sized from ACTUAL
 *   verified positions (never from open-request state).
 *
 * Reduction path (PM-RISK-06): SELL may only consume VERIFIED shares plus
 * freshly released reservations. It never opens a short and never assumes a
 * native reduce-only order type exists at the venue.
 */

export type KillLevel =
  | "NONE"
  | "PAUSE_ENTRIES"
  | "CANCEL_OPEN"
  | "FLATTEN";

export const KILL_LEVELS: readonly KillLevel[] = [
  "NONE",
  "PAUSE_ENTRIES",
  "CANCEL_OPEN",
  "FLATTEN",
];

/** Monotonic comparison: heavier level >= lighter level. */
export function levelAtLeast(a: KillLevel, b: KillLevel): boolean {
  return KILL_LEVELS.indexOf(a) >= KILL_LEVELS.indexOf(b);
}

/** A queued intent offered to the engine while the switch is engaged. */
export interface PendingIntentRef {
  intentId: string;
  marketId: string;
}

export interface IntentBlockResult {
  block: boolean;
  level: KillLevel;
  code: "ENTRIES_PAUSED" | "ENTRIES_ALLOWED";
  reason: string;
}

/**
 * PM-RISK-05: block a queued intent / new worker while PAUSE_ENTRIES or
 * heavier is active. At NONE it is a passthrough.
 */
export function blockNewEntry(
  level: KillLevel,
  intent: PendingIntentRef,
): IntentBlockResult {
  if (levelAtLeast(level, "PAUSE_ENTRIES")) {
    return {
      block: true,
      level,
      code: "ENTRIES_PAUSED",
      reason: `entry blocked at kill level ${level} (${intent.intentId})`,
    };
  }
  return {
    block: false,
    level,
    code: "ENTRIES_ALLOWED",
    reason: "kill level NONE",
  };
}

/** An open order the switch may try to cancel. */
export interface OpenOrderRef {
  orderId: string;
  venueOrderId?: string;
  marketId: string;
  qtyBase: bigint;
}

export type CancelOutcome =
  | { status: "CANCELED"; orderId: string; venueOrderId?: string }
  | { status: "CANCEL_UNKNOWN"; orderId: string; reason: string }
  | { status: "CANCEL_FAILED"; orderId: string; reason: string }
  | { status: "NOT_CANCELED"; orderId: string; reason: string };

export interface CancelOpenPlan {
  level: KillLevel;
  orders: OpenOrderRef[];
  plan: CancelOutcome[];
  /** True if every planned cancel reached a definitive success state. */
  allCanceled: boolean;
}

/**
 * PM-RISK-05 CANCEL_OPEN: plan cancellation for all open orders. Each entry
 * is independently reportable; failure to get a definitive cancel is
 * `CANCEL_FAILED`, keeping `allCanceled=false` so the operator sees the gap.
 */
export function planCancelOpen(
  level: KillLevel,
  orders: OpenOrderRef[],
): CancelOpenPlan {
  const plan: CancelOutcome[] = orders.map((o) => ({
    status: "CANCEL_UNKNOWN",
    orderId: o.orderId,
    reason: "cancel requested via kill switch, awaiting venue result",
  }));
  return {
    level,
    orders,
    plan,
    allCanceled: plan.every((c) => c.status === "CANCELED"),
  };
}

/**
 * Record the observed venue result for one cancel in a CANCEL_OPEN plan.
 * `allCanceled` only becomes true on definitive CANCELED per order; any
 * failure keeps it false so the operator always sees unrecovered orders.
 */
export function recordCancelOutcome(
  plan: CancelOpenPlan,
  outcome: CancelOutcome,
): CancelOpenPlan {
  const plan2 = plan.plan.map((c) =>
    c.orderId === outcome.orderId ? outcome : c,
  );
  return {
    level: plan.level,
    orders: plan.orders,
    plan: plan2,
    allCanceled: plan2.every((c) => c.status === "CANCELED"),
  };
}

/** A verified position (from ledger) usable to size reduce/exit orders. */
export interface VerifiedPosition {
  marketId: string;
  side: "YES" | "NO";
  qtyBase: bigint;
  avgPriceBase: bigint;
}

/**
 * PM-RISK-05 FLATTEN: the flatten action is SEPARATE from CANCEL_OPEN. It is
 * sized from ACTUAL verified positions only, applies a per-side price cap, and
 * refuses to exit into a cap that could not be honored (noabstain-under-min).
 */
export interface FlattenPlan {
  level: KillLevel;
  positions: VerifiedPosition[];
  /** Reduce orders sized from verified shares, honoring the cap. */
  reduceOrders: Array<{
    marketId: string;
    side: "YES" | "NO";
    qtyBase: bigint;
    limitPriceBase: bigint;
  }>;
  /** Positions that cannot be exited within the cap (surfaced, never dropped). */
  skipped: Array<{ marketId: string; reason: string }>;
}

export function planFlatten(
  level: KillLevel,
  positions: VerifiedPosition[],
  priceCapBase: bigint,
): FlattenPlan {
  const reduceOrders: FlattenPlan["reduceOrders"] = [];
  const skipped: FlattenPlan["skipped"] = [];
  for (const p of positions) {
    if (p.qtyBase <= 0n) continue;
    if (priceCapBase <= 0n || priceCapBase > 1_000_000n) {
      skipped.push({ marketId: p.marketId, reason: "invalid flatten price cap" });
      continue;
    }
    if (p.avgPriceBase > priceCapBase) {
      skipped.push({
        marketId: p.marketId,
        reason: `avg price above flatten cap (${p.avgPriceBase} > ${priceCapBase})`,
      });
      continue;
    }
    reduceOrders.push({
      marketId: p.marketId,
      side: p.side,
      qtyBase: p.qtyBase,
      limitPriceBase: priceCapBase,
    });
  }
  return { level, positions, reduceOrders, skipped };
}

/**
 * PM-RISK-06: how many shares a SELL may use right now.
 * Source of truth = VERIFIED positions + shares confirmed freed by a
 * *definitive* cancel. An uncertain cancel (CANCEL_UNKNOWN / still pending)
 * must NOT free shares; that would double-spend.
 */
export function sellableShares(
  verifiedQtyDeltaBase: bigint,
  definitivelyCanceledQtyBase: bigint,
  _pendingCancelQtyBase: bigint,
): bigint {
  // Negative verified delta means we already owe shares (no short assumption).
  const base = verifiedQtyDeltaBase + definitivelyCanceledQtyBase;
  if (base < 0n) return 0n;
  return base;
}

/**
 * PM-RISK-06: validate a proposed SELL. Never opens a short; refuses when the
 * request exceeds free (verified + definitively released) shares; refuses to
 * credit shares freed only by an uncertain cancel.
 */
export type ReduceCheckResult =
  | { ok: true; allowedQtyBase: bigint; reason: string }
  | { ok: false; code: string; reason: string };

export function checkReduceAllowed(args: {
  requestQtyBase: bigint;
  verifiedQtyDeltaBase: bigint;
  definitivelyCanceledQtyBase: bigint;
  pendingCancelQtyBase: bigint;
}): ReduceCheckResult {
  if (args.requestQtyBase <= 0n) {
    return { ok: false, code: "REDUCE_SIZE", reason: "reduce qty must be positive" };
  }
  const free = sellableShares(
    args.verifiedQtyDeltaBase,
    args.definitivelyCanceledQtyBase,
    args.pendingCancelQtyBase,
  );
  if (args.requestQtyBase > free) {
    return {
      ok: false,
      code: "REDUCE_OVERDRAWN",
      reason: `sell ${args.requestQtyBase} exceeds verified+released ${free}; ` +
        `uncertain cancel of ${args.pendingCancelQtyBase} does not free shares`,
    };
  }
  return {
    ok: true,
    allowedQtyBase: args.requestQtyBase,
    reason: "fits verified shares; no short, no reduce-only-native assumption",
  };
}