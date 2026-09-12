/**
 * @polyroot/venue — Venue mode gate (TABLE 17), capability intersection,
 * error taxonomy, client throttling and in-flight/recovery semantics
 * (PM-VENUE-01..06).
 *
 * These modules are PURE: they compute decisions from observed inputs and never
 * reach the network. The wired VenueAdapter (Phase 9) applies them.
 */

import type { AccountMode, VenueCapability, VenueMode } from "@polyroot/domain";

/* ─── 0. Venue-mode action gate (TABLE 17, PM-VENUE-01) ────────────────── */

/** Venue actions the adapter is responsible for gating (TABLE 17 matrix). */
export type VenueAction = "ORDER_SUBMIT" | "ORDER_CANCEL" | "READ";

export interface VenueDecision {
  allowed: boolean;
  code: string;
  reason: string;
}

/** Fail-closed: any mode that does not explicitly permit an action refuses it. */
const MODE_MATRIX: Record<VenueMode, Record<VenueAction, boolean>> = {
  NORMAL: { ORDER_SUBMIT: true, ORDER_CANCEL: true, READ: true },
  POST_ONLY: { ORDER_SUBMIT: true, ORDER_CANCEL: true, READ: true },
  CANCEL_ONLY: { ORDER_SUBMIT: false, ORDER_CANCEL: true, READ: true },
  READ_ONLY: { ORDER_SUBMIT: false, ORDER_CANCEL: false, READ: true },
  UNAVAILABLE: { ORDER_SUBMIT: false, ORDER_CANCEL: false, READ: true },
  UNKNOWN: { ORDER_SUBMIT: false, ORDER_CANCEL: false, READ: false },
};

/** Pure venue-mode gate — deterministic and fully testable. */
export function venueActionGate(
  mode: VenueMode,
  action: VenueAction,
): VenueDecision {
  const permitted = MODE_MATRIX[mode]?.[action] ?? false;
  if (permitted) {
    return {
      allowed: true,
      code: "ALLOWED",
      reason: `${action} legal in ${mode}`,
    };
  }
  return {
    allowed: false,
    code: "MODE_FORBIDS",
    reason: `${action} not permitted in venue mode ${mode}`,
  };
}

/* ─── 1. Capability intersection (PM-VENUE-02) ─────────────────────────── */

/** Independent gates that all must agree for an action to be legal. */
export interface IntersectionInput {
  venueMode: VenueMode;
  accountMode: AccountMode;
  capability: VenueCapability | null;
  /** True when the commissioned mandate allows the action for this market. */
  mandateAllows: boolean;
  /** True when quotes/market/rules are within TTL (freshness). */
  fresh: boolean;
  /** True when risk state is open for entries (no PAUSE_ENTRIES+ / breach). */
  riskOpen: boolean;
  /** Required style (order type) the caller wants; null = any. */
  requiredStyle?: "LIMIT" | "POST_ONLY" | "FOK" | "IOC" | "REDUCE_ONLY";
}

export type CapabilityDecision =
  | { allowed: true; action: VenueAction; reason: string }
  | { allowed: false; code: string; action: VenueAction; reason: string };

/**
 * Final permission = intersection of venue mode, account mode, protocol
 * capability, mandate, freshness and risk state (PM-VENUE-02). Account
 * CLOSE_ONLY + venue NORMAL still never creates inventory: only a verified
 * REDUCE_ONLY-style intent (reduce) passes.
 */
export function capabilityIntersection(
  action: Exclude<VenueAction, "READ">,
  input: IntersectionInput,
): CapabilityDecision {
  const mode = venueActionGate(input.venueMode, action);
  if (!mode.allowed) {
    return {
      allowed: false,
      code: "VENUE_MODE",
      action,
      reason: mode.reason,
    };
  }

  const readMode = venueActionGate(input.venueMode, "READ");
  if (!readMode.allowed) {
    return {
      allowed: false,
      code: "VENUE_MODE",
      action,
      reason: `no read capability in ${input.venueMode}`,
    };
  }

  if (input.accountMode === "ACCESS_BLOCKED" || input.accountMode === "SUSPENDED") {
    return {
      allowed: false,
      code: "ACCOUNT_BLOCKED",
      action,
      reason: `account ${input.accountMode}`,
    };
  }

  if (action === "ORDER_SUBMIT") {
    if (input.accountMode === "CLOSE_ONLY") {
      if (input.requiredStyle !== "REDUCE_ONLY") {
        return {
          allowed: false,
          code: "ACCOUNT_CLOSE_ONLY",
          action,
          reason: "account close_only: submit only reduce of verified inventory",
        };
      }
      return {
        allowed: true,
        action,
        reason: "close_only + explicit reduce style (verified inventory only)",
      };
    }
    if (input.requiredStyle === "REDUCE_ONLY") {
      if (!input.capability?.supports_reduce_only) {
        return {
          allowed: false,
          code: "NO_REDUCE_ONLY_CAP",
          action,
          reason: "venue protocol does not expose a verified reduce-only order",
        };
      }
    }
  }

  if (action === "ORDER_CANCEL") {
    // Cancels do not consume mandate/freshness/risk entry; they are remedial.
    return { allowed: true, action, reason: "cancel is remedial, not an entry" };
  }

  if (!input.mandateAllows) {
    return {
      allowed: false,
      code: "MANDATE_BLOCK",
      action,
      reason: `mandate does not allow ${action} for this market`,
    };
  }
  if (!input.fresh) {
    return {
      allowed: false,
      code: "STALE_DATA",
      action,
      reason: "quotes/market/rules outside TTL",
    };
  }
  if (!input.riskOpen) {
    return {
      allowed: false,
      code: "RISK_CLOSED",
      action,
      reason: "risk state not open for entries",
    };
  }

  return { allowed: true, action, reason: `intersection passes for ${action}` };
}

/* ─── 2. Error taxonomy (PM-VENUE-04) ──────────────────────────────────── */

export const VenueErrorKind = [
  "RETRYABLE",
  "RECONCILE_REQUIRED",
  "POLICY_BLOCK",
  "VENUE_MODE",
  "PERMANENT_REJECT",
  "AUTH_FAILURE",
  "BALANCE_FAILURE",
  "STALE_DATA",
  "UNKNOWN",
] as const;
export type VenueErrorKind = (typeof VenueErrorKind)[number];

export interface RawVenueError {
  status?: number;
  code?: string;
  message?: string;
  serverBusyHeaders?: boolean;
  queuedDelayMs?: number;
}

export interface NormalizedVenueError {
  kind: VenueErrorKind;
  actionable: boolean;
  retryable: boolean;
  reconcileFirst: boolean;
  reason: string;
  /** Original status/code preserved for triage. */
  rawStatus?: number | undefined;
  rawCode?: string | undefined;
}

/**
 * Normalize a raw venue error into the taxonomy (PM-VENUE-04). A submitted
 * POST that returns an unknown 5xx / timeout is NOT auto-retryable: it is
 * RECONCILE_REQUIRED — the order may have been accepted late. FAK/IOC no-match
 * is a terminal zero-fill, not a retryable submit failure.
 */
export function normalizeVenueError(
  err: RawVenueError,
  context: { arrivedPendingStore: boolean; orderType?: "LIMIT" | "POST_ONLY" | "FOK" | "IOC" },
): NormalizedVenueError {
  const status = err.status;
  const code = (err.code ?? "").toUpperCase();
  const reason = err.message ?? err.code ?? `http ${status ?? "?"}`;

  // Already pending store plain errors are almost never submit-retryable.
  if (context.arrivedPendingStore) {
    return {
      kind: "RECONCILE_REQUIRED",
      actionable: true,
      retryable: false,
      reconcileFirst: true,
      reason: `in-flight uncertainty after submit: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  // Terminal zero-fill for FAK / IOC no-match.
  if ((context.orderType === "FOK" || context.orderType === "IOC") &&
      /NO_MATCH|NO_FILL|FOK_NOT_FILLED|NOT_FILLED|EXPIRED|EXPIRED_BOOK/i.test(code)) {
    return {
      kind: "PERMANENT_REJECT",
      actionable: false,
      retryable: false,
      reconcileFirst: false,
      reason: `FAK/IOC no-match terminal zero-fill: ${code}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (status === 401 || status === 403 || /AUTH|UNAUTHORIZED|FORBIDDEN|INVALID_KEY/i.test(code)) {
    return {
      kind: "AUTH_FAILURE",
      actionable: true,
      retryable: false,
      reconcileFirst: true,
      reason: `auth failure ${status}: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (/INSUFFICIENT|BALANCE|FUNDS|NEGATIVE_AVAILABLE/i.test(code)) {
    return {
      kind: "BALANCE_FAILURE",
      actionable: true,
      retryable: false,
      reconcileFirst: true,
      reason: `balance failure: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (/POLICY|MANDATE|RISK|RESTRICTED|INVALID_STATE|READ_ONLY|CANCEL_ONLY/i.test(code)) {
    return {
      kind: "POLICY_BLOCK",
      actionable: true,
      retryable: false,
      reconcileFirst: false,
      reason: `policy/mode block: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (/STALE|EXPIRED_DATA|PRICE_EXPIRED|BOOK_EXPIRED|TIMEOUT_UNSUBSCRIBE/i.test(code)) {
    return {
      kind: "STALE_DATA",
      actionable: true,
      retryable: true,
      reconcileFirst: false,
      reason: `stale data: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (status === 429 || err.serverBusyHeaders || (err.queuedDelayMs ?? 0) > 0) {
    return {
      kind: "RETRYABLE",
      actionable: true,
      retryable: true,
      reconcileFirst: false,
      reason: `client throttled (headers/queue): ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      kind: "RECONCILE_REQUIRED",
      actionable: true,
      retryable: false,
      reconcileFirst: true,
      reason: `server ${status} — resolve state before further submit: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  if (status === 400 || status === 422 || /INVALID|REJECT/i.test(code)) {
    return {
      kind: "PERMANENT_REJECT",
      actionable: false,
      retryable: false,
      reconcileFirst: false,
      reason: `permanent reject ${status}: ${reason}`,
      rawStatus: status,
      rawCode: err.code,
    };
  }

  return {
    kind: "UNKNOWN",
    actionable: true,
    retryable: false,
    reconcileFirst: true,
    reason: `unclassified venue error: ${reason}`,
    rawStatus: status,
    rawCode: err.code,
  };
}

/* ─── 3. Client throttling (PM-VENUE-05) ───────────────────────────────── */

export interface RateBucketConfig {
  /** Max ops per window for the class. */
  limit: number;
  /** Window length, ms. */
  windowMs: number;
}

const DEFAULT_CLASSES: Record<"submit" | "cancel" | "read" | "heartbeat", RateBucketConfig> = {
  submit: { limit: 20, windowMs: 60_000 },
  cancel: { limit: 40, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
  heartbeat: { limit: 120, windowMs: 60_000 },
};

export interface DeadlineAwareQueueArgs {
  now: number;
  classes?: Partial<typeof DEFAULT_CLASSES>;
  /** Server-observed queue delay hint (ms) — not only HTTP 429 (PM-VENUE-05). */
  serverQueueDelayMs?: Partial<Record<"submit" | "cancel" | "read" | "heartbeat", number>>;
}

/**
 * Deadline-aware per-class token buckets + explicit server-delay backoff.
 * Honors server headers and queued delay, not only `429`. Batch orders are
 * spread so cancel/heartbeat never starve (soft priority). Returns `ok` only
 * when the class has budget and the estimated queue delay keeps the intent
 * before its deadline.
 */
export class RateGovernor {
  private readonly classes: typeof DEFAULT_CLASSES;
  private readonly stamps: Record<string, number[]> = {};
  private readonly serverDelay: Partial<Record<string, number>> = {};
  private readonly clock: () => number;

  constructor(opts?: { classes?: Partial<typeof DEFAULT_CLASSES>; clock?: () => number }) {
    this.classes = { ...DEFAULT_CLASSES, ...(opts?.classes ?? {}) };
    this.clock = opts?.clock ?? (() => Date.now());
  }

  ingestServerHint(kind: "submit" | "cancel" | "read" | "heartbeat", delayMs: number) {
    this.serverDelay[kind] = delayMs;
  }

  private prune(kind: string, now: number) {
    const list = this.stamps[kind];
    if (!list) return;
    const w = this.classes[kind as keyof typeof DEFAULT_CLASSES]?.windowMs ?? 60_000;
    while (list.length > 0 && now - (list[0] ?? 0) > w) list.shift();
  }

  async acquire(kind: "submit" | "cancel" | "read" | "heartbeat", opts?: { deadline?: number; queuedDelayMs?: number }): Promise<{ ok: boolean; code: string; afterMs: number }> {
    const now = this.clock();
    this.prune(kind, now);
    const cfg = this.classes[kind];
    const used = this.stamps[kind]?.length ?? 0;
    if (used >= cfg.limit) {
      return { ok: false, code: "RATE_EXCEEDED", afterMs: cfg.windowMs - (now - (this.stamps[kind]?.[0] ?? now)) };
    }
    if (opts?.queuedDelayMs) this.ingestServerHint(kind, opts.queuedDelayMs);

    // Before admitting, the estimated queue (server hint + our own latency
    // budget) must fit before the deadline.
    if (opts?.deadline !== undefined) {
      const delay = Math.max((this.serverDelay[kind] ?? 0), opts.queuedDelayMs ?? 0);
      if (now + delay > opts.deadline) {
        return { ok: false, code: "INTENT_EXPIRED", afterMs: opts.deadline - now };
      }
    }

    const list = (this.stamps[kind] ??= []);
    list.push(now);
    return { ok: true, code: "OK", afterMs: 0 };
  }

  /** Never starve cancel/heartbeat behind order batches (PM-VENUE-05). */
  canCancel(): boolean {
    const now = this.clock();
    this.prune("cancel", now);
    return (this.stamps["cancel"]?.length ?? 0) < this.classes.cancel.limit;
  }
}

/* ─── 4. In-flight uncertainty & restart recovery (PM-VENUE-03/06) ─────── */

export type InFlightState = "SUBMITTED_UNKNOWN" | "CANCEL_UNKNOWN" | "CANCEL_CERTAIN";

export interface InternalInFlightOrder {
  orderId: string;
  venueOrderId?: string | undefined;
  state: InFlightState;
  pendingSince: number;
  /** True once a venue-sourced transition (fill/reject/cancel) is observed. */
  resolved: boolean;
}

/**
 * Holds orders that were submitted/cancelled-through a deadline or restart.
 * Across a restart these must NOT report "cancelled", and must NOT be
 * auto-resubmitted as a brand-new order (PM-VENUE-03/06 TEST: a late-accepted
 * POST after timeout is still one reconciled order, not a new retry).
 */
export class InternalRecoveryLedger {
  private readonly orders = new Map<string, InternalInFlightOrder>();
  private readonly clock: () => number;

  constructor(opts?: { clock?: () => number }) {
    this.clock = opts?.clock ?? (() => Date.now());
  }

  addSubmittedUnknown(orderId: string, venueOrderId?: string) {
    this.orders.set(orderId, {
      orderId,
      venueOrderId,
      state: "SUBMITTED_UNKNOWN",
      pendingSince: this.clock(),
      resolved: false,
    });
  }

  recordCancelRequested(orderId: string) {
    const o = this.orders.get(orderId);
    if (o && !o.resolved) {
      o.state = "CANCEL_UNKNOWN";
    }
  }

  /** Only a definitive venue-sourced result resolves the order. */
  resolve(orderId: string, fromVenue: boolean) {
    const o = this.orders.get(orderId);
    if (o && fromVenue) {
      o.resolved = true;
      o.state = "CANCEL_CERTAIN";
    }
  }

  /** True when a restart must reconcile this order, not resubmit it. */
  needsReconcile(orderId: string): boolean {
    const o = this.orders.get(orderId);
    return !!o && !o.resolved;
  }

  /** Map current confirmed-cancelled set (only definitively resolved cancels). */
  certainCancels(): string[] {
    const out: string[] = [];
    for (const [id, o] of this.orders) {
      if (o.resolved && o.state === "CANCEL_CERTAIN") out.push(id);
    }
    return out;
  }
}