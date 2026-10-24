/**
 * @polyroot/runtime — durable exposure after submit and across restarts.
 *
 * An unfilled ACK books reserved notional in memory. Later fills and
 * cancels live in `recovery_ledger` + `reservations`. This module turns
 * those rows into a snapshot the PositionTracker can replace itself
 * with, and a session-PnL delta for fills that arrived after the
 * submit-time book.
 *
 * Exposure (USD), per order, never negative:
 *   filled cash (consumed_fill_cash_base / 1e6, else shares × limit)
 *   + remaining reservation ((amount − consumed − released) / 1e6)
 * A terminal cancel/reject with nothing left committed and no fill is 0.
 * A consumed reservation drops the cash leg; the filled notional stays
 * until settlement removes the token.
 *
 * Session PnL on a later fill uses the same mark-to-model formula as
 * `sessionPnlFromFill`, only for the share increment, and only when the
 * row carries a real forecast `p` and a YES/NO side. Unknown `p` → 0.
 * The first successful snapshot of a fresh process restores exposure
 * and does not replay historical PnL into the session counter (that
 * counter is process-local). The durable loss latch is not cleared.
 */

import { clobTakerFeePerShare } from "@polyroot/control";
import type { StepMetricsSnapshot } from "./live-accounting.js";
import { LIVE_TAKER_FEE_THETA, sessionPnlFromFill } from "./live-accounting.js";

export interface DurableOpenOrder {
  marketId: string;
  orderId: string;
  limitPrice: number;
  orderSize: number;
  /** Cumulative filled shares (human units, not base). */
  filledShares: number;
  /** Cumulative filled cash in USD. */
  filledCashUsd: number;
  /**
   * Unfilled reservation still committed, in USD.
   * `reservationKnown` false means the JOIN found no reservation row,
   * so a still-open order falls back to the limit notional.
   */
  remainingReservedUsd: number;
  reservationKnown: boolean;
  /** Venue or reservation is finished. Exposure is filled + any cash still committed. */
  terminal: boolean;
  /** Forecast probability when the intent stored one. Absent → no PnL. */
  p?: number;
  quotedSide?: "YES" | "NO";
}

export interface DurableOrderRow {
  market_id?: unknown;
  quoted_side?: unknown;
  limit_price?: unknown;
  order_size?: unknown;
  order_id?: unknown;
  resolved?: unknown;
  resolved_state?: unknown;
  consumed_fill_shares_base?: unknown;
  consumed_fill_cash_base?: unknown;
  reservation_status?: unknown;
  reserved_amount?: unknown;
  consumed_amount?: unknown;
  released_amount?: unknown;
  probability_yes?: unknown;
}

/**
 * Open risk the tracker must see after a restart: unresolved ledger
 * rows, plus any resolved row that still has a consumed fill (the
 * position remains until settlement).
 */
export const DURABLE_OPEN_ORDERS_SQL = `
SELECT
  ti.market_id,
  ti.side AS quoted_side,
  ti.price::text AS limit_price,
  ti.size::text AS order_size,
  rl.order_id::text AS order_id,
  rl.resolved,
  rl.resolved_state,
  rl.consumed_fill_shares_base,
  rl.consumed_fill_cash_base,
  r.status AS reservation_status,
  r.amount::text AS reserved_amount,
  r.consumed_amount::text AS consumed_amount,
  r.released_amount::text AS released_amount,
  f.probability_yes::text AS probability_yes
FROM recovery_ledger rl
JOIN execution_permits ep ON ep.permit_id = rl.permit_id
JOIN trade_intents ti ON ti.id = ep.intent_id
LEFT JOIN reservations r ON r.permit_id = ep.permit_id
LEFT JOIN forecasts f ON f.id = ti.forecast_id
WHERE rl.resolved = false
   OR COALESCE(NULLIF(rl.consumed_fill_shares_base, ''), '0')::numeric > 0
`;

function baseToUnits(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const text = String(raw).trim();
  if (!text) return 0;
  const whole = text.split(".")[0] ?? "";
  if (!/^-?\d+$/.test(whole)) return 0;
  try {
    const n = BigInt(whole);
    const sign = n < 0n ? -1 : 1;
    const abs = n < 0n ? -n : n;
    const dollars = abs / 1_000_000n;
    const frac = abs % 1_000_000n;
    return sign * (Number(dollars) + Number(frac) / 1_000_000);
  } catch {
    return 0;
  }
}

function finiteNumber(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isResolved(raw: unknown): boolean {
  return raw === true || raw === "t" || raw === "true";
}

/** One SQL row → one order. Null when the market or order id is missing. */
export function durableOrderFromRow(
  row: DurableOrderRow,
): DurableOpenOrder | null {
  const marketId = typeof row.market_id === "string" ? row.market_id : "";
  const orderId =
    row.order_id === null || row.order_id === undefined
      ? ""
      : String(row.order_id);
  if (!marketId || !orderId) return null;
  const reservationKnown =
    row.reserved_amount !== null && row.reserved_amount !== undefined;
  const amount = reservationKnown ? baseToUnits(row.reserved_amount) : 0;
  const consumed = baseToUnits(row.consumed_amount);
  const released = baseToUnits(row.released_amount);
  const status =
    typeof row.reservation_status === "string" ? row.reservation_status : "";
  const resolvedState =
    typeof row.resolved_state === "string" ? row.resolved_state : "";
  const terminal =
    (isResolved(row.resolved) && resolvedState === "DEFINITIVE_REJECT") ||
    status === "RELEASED" ||
    status === "EXPIRED" ||
    status === "CONSUMED";
  const pRaw = row.probability_yes;
  const pNum =
    pRaw === null || pRaw === undefined || pRaw === ""
      ? undefined
      : Number(pRaw);
  const side =
    row.quoted_side === "YES" || row.quoted_side === "NO"
      ? row.quoted_side
      : undefined;
  return {
    marketId,
    orderId,
    limitPrice: finiteNumber(row.limit_price),
    orderSize: finiteNumber(row.order_size),
    filledShares: baseToUnits(row.consumed_fill_shares_base),
    filledCashUsd: baseToUnits(row.consumed_fill_cash_base),
    remainingReservedUsd: Math.max(0, amount - consumed - released),
    reservationKnown,
    terminal,
    ...(typeof pNum === "number" && Number.isFinite(pNum) ? { p: pNum } : {}),
    ...(side ? { quotedSide: side } : {}),
  };
}

/** Sum reservation legs that share an order id. Fills stay per order. */
export function collapseDurableOrders(
  rows: readonly DurableOrderRow[],
): DurableOpenOrder[] {
  const byId = new Map<string, DurableOpenOrder>();
  for (const row of rows) {
    const parsed = durableOrderFromRow(row);
    if (!parsed) continue;
    const prev = byId.get(parsed.orderId);
    if (!prev) {
      byId.set(parsed.orderId, parsed);
      continue;
    }
    prev.remainingReservedUsd += parsed.remainingReservedUsd;
    prev.reservationKnown = prev.reservationKnown || parsed.reservationKnown;
    if (parsed.filledShares > prev.filledShares) {
      prev.filledShares = parsed.filledShares;
    }
    if (parsed.filledCashUsd > prev.filledCashUsd) {
      prev.filledCashUsd = parsed.filledCashUsd;
    }
    if (parsed.terminal) prev.terminal = true;
  }
  return [...byId.values()];
}

function filledNotionalUsd(order: DurableOpenOrder): number {
  if (Number.isFinite(order.filledCashUsd) && order.filledCashUsd > 0) {
    return order.filledCashUsd;
  }
  if (
    Number.isFinite(order.filledShares) &&
    order.filledShares > 0 &&
    Number.isFinite(order.limitPrice) &&
    order.limitPrice > 0 &&
    order.limitPrice <= 1
  ) {
    return order.filledShares * order.limitPrice;
  }
  return 0;
}

/** USD still at risk for one order. 0 means nothing to track. */
export function orderExposureUsd(order: DurableOpenOrder): number {
  const filled = filledNotionalUsd(order);
  const reserved =
    Number.isFinite(order.remainingReservedUsd) &&
    order.remainingReservedUsd > 0
      ? order.remainingReservedUsd
      : 0;
  if (order.terminal) return Math.max(0, filled + reserved);
  if (reserved > 0 || filled > 0) return filled + reserved;
  if (
    !order.reservationKnown &&
    order.orderSize > 0 &&
    order.limitPrice > 0 &&
    order.limitPrice <= 1
  ) {
    return order.limitPrice * order.orderSize;
  }
  return 0;
}

export function exposureByMarket(
  orders: readonly DurableOpenOrder[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const order of orders) {
    if (!order.marketId) continue;
    const usd = orderExposureUsd(order);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    out.set(order.marketId, (out.get(order.marketId) ?? 0) + usd);
  }
  return out;
}

/**
 * Mark-to-model PnL for shares filled since `previousFilledShares`.
 * No forecast `p`, or a non-finite one, returns 0 — profit is not invented.
 */
export function incrementalFillPnl(input: {
  previousFilledShares: number;
  order: DurableOpenOrder;
}): number {
  const prev =
    Number.isFinite(input.previousFilledShares) &&
    input.previousFilledShares > 0
      ? input.previousFilledShares
      : 0;
  const now =
    Number.isFinite(input.order.filledShares) && input.order.filledShares > 0
      ? input.order.filledShares
      : 0;
  const deltaShares = now - prev;
  if (deltaShares <= 0) return 0;
  const p = input.order.p;
  const side = input.order.quotedSide;
  if (
    typeof p !== "number" ||
    !Number.isFinite(p) ||
    p <= 0 ||
    p >= 1 ||
    (side !== "YES" && side !== "NO")
  ) {
    return 0;
  }
  let fillPrice: number;
  if (now > 0 && input.order.filledCashUsd > 0) {
    fillPrice = input.order.filledCashUsd / now;
  } else if (input.order.limitPrice > 0 && input.order.limitPrice <= 1) {
    fillPrice = input.order.limitPrice;
  } else {
    return 0;
  }
  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || fillPrice > 1) return 0;
  const takerFee =
    deltaShares * clobTakerFeePerShare(fillPrice, LIVE_TAKER_FEE_THETA);
  return sessionPnlFromFill({
    p,
    quotedSide: side,
    fill: {
      status: "PARTIAL",
      filledSize: deltaShares,
      fillPrice,
      makerFee: 0,
      takerFee,
    },
  });
}

export interface ExposureBook {
  bookedFillShares: Map<string, number>;
  /** True after the first successful snapshot this process. */
  baselined: boolean;
  /** True after this process has run a trading step. */
  sawStep: boolean;
}

export interface ExposureTracker {
  replaceAll(entries: Iterable<readonly [string, number]>): void;
  total(): number;
}

/**
 * Replace tracker exposure from `orders`. On a cold start (no step yet)
 * this does not copy historical mark-to-model PnL into the session
 * counter. After a step, only the share increment moves `totalPnl`.
 */
export function applyDurableExposure(
  book: ExposureBook,
  tracker: ExposureTracker,
  metrics: Pick<
    StepMetricsSnapshot,
    "totalPnl" | "currentExposureUsd" | "maxExposureUsd"
  >,
  orders: readonly DurableOpenOrder[],
): { pnlDelta: number } {
  let pnlDelta = 0;
  const coldStart = !book.baselined && !book.sawStep;
  if (coldStart) {
    for (const order of orders) {
      if (order.filledShares > 0) {
        book.bookedFillShares.set(order.orderId, order.filledShares);
      }
    }
  } else {
    for (const order of orders) {
      const prev = book.bookedFillShares.get(order.orderId) ?? 0;
      const delta = incrementalFillPnl({
        previousFilledShares: prev,
        order,
      });
      if (Number.isFinite(delta) && delta !== 0) pnlDelta += delta;
      if (order.filledShares > prev) {
        book.bookedFillShares.set(order.orderId, order.filledShares);
      }
    }
    if (pnlDelta !== 0) metrics.totalPnl += pnlDelta;
  }
  book.baselined = true;
  tracker.replaceAll(exposureByMarket(orders));
  metrics.currentExposureUsd = tracker.total();
  if (metrics.currentExposureUsd > metrics.maxExposureUsd) {
    metrics.maxExposureUsd = metrics.currentExposureUsd;
  }
  return { pnlDelta: coldStart ? 0 : pnlDelta };
}

export async function queryDurableOpenOrders(
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: DurableOrderRow[] }>,
): Promise<DurableOpenOrder[]> {
  const res = await query(DURABLE_OPEN_ORDERS_SQL);
  return collapseDurableOrders(res.rows ?? []);
}

export interface ExposureSyncDeps {
  reconcileOpenOrders?: (() => Promise<void>) | undefined;
  loadDurableOrders?: (() => Promise<DurableOpenOrder[] | null>) | undefined;
  observability?:
    | { emitMetrics?: ((metrics: StepMetricsSnapshot) => void) | undefined }
    | undefined;
}

/**
 * Reconcile venue state, then replace the tracker from the durable
 * snapshot. `null` or a throw keeps the in-memory book (does not zero
 * it). An empty array means the read succeeded and nothing is open.
 */
export async function syncDurableExposure(
  deps: ExposureSyncDeps,
  book: ExposureBook,
  tracker: ExposureTracker,
  metrics: StepMetricsSnapshot,
): Promise<void> {
  if (deps.reconcileOpenOrders) {
    try {
      await deps.reconcileOpenOrders();
    } catch (err) {
      console.error(
        `[g4] open-order reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!deps.loadDurableOrders) return;
  let orders: DurableOpenOrder[] | null;
  try {
    orders = await deps.loadDurableOrders();
  } catch (err) {
    console.error(
      `[g4] durable exposure load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (orders === null) return;
  applyDurableExposure(book, tracker, metrics, orders);
  deps.observability?.emitMetrics?.({ ...metrics });
}
