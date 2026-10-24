/**
 * @polyroot/runtime — submit-time LIVE accounting.
 *
 * The venue ACK is not always a fill. This module turns whatever the
 * executor already returned into two honest numbers:
 *
 * - exposure: cash that is reserved or filled, so the next cap check cannot
 *   see a zero portfolio after a successful submit
 * - session PnL: mark-to-model only when `filled_size > 0`. An unfilled
 *   resting order books exposure and pnl 0. Settlement (and any later
 *   reconcile fill) is still outside this step — that residual gap is
 *   intentional, not a mock fill.
 *
 * Formulas (also written into `forecasts.lineage` by step persistence):
 * - exposure FILLED  = fillPrice * filledSize
 * - exposure PARTIAL = fillPrice * filledSize + limitPrice * (orderSize - filledSize)
 * - exposure no fill = limitPrice * orderSize
 * - pnl YES = filledSize * (p - fillPrice) - makerFee - takerFee
 * - pnl NO  = filledSize * (1 - p - fillPrice) - makerFee - takerFee
 * - taker fee, when the ACK omits `fee_paid`:
 *     filledSize * Θ * price * (1 - price), Θ = 0.05
 *   (same per-share fee as `clobTakerFeePerShare` on the edge gate)
 */

import { clobTakerFeePerShare } from "@polyroot/control";
import type { MoneyKernel } from "@polyroot/risk";
import { decimalToBase } from "@polyroot/signer";

/** Θ in the CLOB taker formula. Matches the edge gate in `executeG4Step`. */
export const LIVE_TAKER_FEE_THETA = 0.05;

export interface LiveFillAck {
  filled_size?: number | undefined;
  average_price?: number | undefined;
  fee_paid?: number | undefined;
  maker_taker?: "MAKER" | "TAKER" | "UNKNOWN" | undefined;
}

export interface LiveFill {
  status: "FILLED" | "PARTIAL";
  filledSize: number;
  fillPrice: number;
  makerFee: number;
  takerFee: number;
  /** Unmeasured at submit time. 0 means "not timed", not a sample of 0ms. */
  latencyMs: number;
  /** Where the fee number came from. `theta` is the formula above. */
  feeModel: "venue" | "theta";
}

export interface StepMetricsSnapshot {
  totalOrders: number;
  filledOrders: number;
  totalPnl: number;
  totalFees: number;
  maxDrawdown: number;
  fillRatio: number;
  currentExposureUsd: number;
  maxExposureUsd: number;
}

function positiveFinite(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Venue fill from an executor ACK. Missing or non-positive `filled_size`
 * returns undefined — a resting order is not invented into a fill.
 */
export function deriveLiveFill(
  order: { size: number; price: number },
  ack: LiveFillAck,
): LiveFill | undefined {
  const filledSize = ack.filled_size;
  if (
    typeof filledSize !== "number" ||
    !Number.isFinite(filledSize) ||
    filledSize <= 0
  ) {
    return undefined;
  }
  const average =
    typeof ack.average_price === "number" &&
    Number.isFinite(ack.average_price) &&
    ack.average_price > 0 &&
    ack.average_price <= 1
      ? ack.average_price
      : undefined;
  const limit =
    Number.isFinite(order.price) && order.price > 0 && order.price <= 1
      ? order.price
      : undefined;
  const fillPrice = average ?? limit;
  if (fillPrice === undefined) return undefined;

  let makerFee = 0;
  let takerFee = 0;
  let feeModel: "venue" | "theta";
  if (
    typeof ack.fee_paid === "number" &&
    Number.isFinite(ack.fee_paid) &&
    ack.fee_paid >= 0
  ) {
    feeModel = "venue";
    if (ack.maker_taker === "MAKER") makerFee = ack.fee_paid;
    else takerFee = ack.fee_paid;
  } else {
    feeModel = "theta";
    takerFee =
      filledSize * clobTakerFeePerShare(fillPrice, LIVE_TAKER_FEE_THETA);
  }

  const orderSize = Number.isFinite(order.size) ? order.size : filledSize;
  const status: "FILLED" | "PARTIAL" =
    filledSize + 1e-9 < orderSize ? "PARTIAL" : "FILLED";
  return {
    status,
    filledSize,
    fillPrice,
    makerFee,
    takerFee,
    latencyMs: 0,
    feeModel,
  };
}

/**
 * USD exposure to add for one successful submit (SUBMITTED or
 * NEEDS_RECONCILIATION). Never negative. 0 means "nothing bookable".
 */
export function submitExposureUsd(input: {
  orderSize: number;
  limitPrice: number;
  fill?:
    | {
        status: "FILLED" | "PARTIAL" | "CANCELLED";
        filledSize: number;
        fillPrice: number;
      }
    | undefined;
}): number {
  const orderSize = input.orderSize;
  const limitPrice = input.limitPrice;
  if (!Number.isFinite(orderSize) || orderSize <= 0) return 0;
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice > 1) {
    return 0;
  }
  const fill = input.fill;
  if (!fill || (fill.status !== "FILLED" && fill.status !== "PARTIAL")) {
    return limitPrice * orderSize;
  }
  const filledSize =
    Number.isFinite(fill.filledSize) && fill.filledSize > 0
      ? fill.filledSize
      : 0;
  const fillPrice =
    Number.isFinite(fill.fillPrice) && fill.fillPrice > 0 && fill.fillPrice <= 1
      ? fill.fillPrice
      : limitPrice;
  const remainder = Math.max(0, orderSize - filledSize);
  return fillPrice * filledSize + limitPrice * remainder;
}

/**
 * Mark-to-model session PnL for a real fill. Unfilled / cancelled → 0.
 * Non-finite fees refuse a positive (fee-free) profit and still report a loss.
 */
export function sessionPnlFromFill(input: {
  p: number;
  quotedSide: "YES" | "NO";
  fill: {
    status: "FILLED" | "PARTIAL" | "CANCELLED";
    filledSize: number;
    fillPrice: number;
    makerFee: number;
    takerFee: number;
  };
}): number {
  const { fill, p } = input;
  if (fill.status !== "FILLED" && fill.status !== "PARTIAL") return 0;
  if (
    !Number.isFinite(p) ||
    !Number.isFinite(fill.filledSize) ||
    fill.filledSize <= 0
  ) {
    return 0;
  }
  if (!Number.isFinite(fill.fillPrice)) return 0;
  const fairDiff =
    input.quotedSide === "NO" ? 1 - p - fill.fillPrice : p - fill.fillPrice;
  const gross = fill.filledSize * fairDiff;
  const maker = fill.makerFee;
  const taker = fill.takerFee;
  if (
    !Number.isFinite(maker) ||
    !Number.isFinite(taker) ||
    maker < 0 ||
    taker < 0
  ) {
    return gross < 0 ? gross : 0;
  }
  return gross - maker - taker;
}

/**
 * Operator-facing reason for a post-submit step. A successful ACK is not
 * a failure. Reconciliation is unknown, not a failed execution.
 */
export function liveStepReason(
  outcome: "SUBMITTED" | "NEEDS_RECONCILIATION",
): string | undefined {
  if (outcome === "SUBMITTED") return undefined;
  return "submission outcome unknown — reconcile before treating the order as failed";
}

/** Cap input: the larger of caller-supplied exposure and the in-process tracker. */
export function combineExposure(
  supplied: number | undefined,
  tracked: number,
): number {
  return Math.max(positiveFinite(supplied), positiveFinite(tracked));
}

export function exposureForStep(
  tracker: { total(): number; exposureOf(tokenId: string): number },
  marketId: string,
  suppliedPortfolio: number | undefined,
  suppliedMarket: number | undefined,
): { currentPortfolioExposureUsd: number; currentMarketExposureUsd: number } {
  return {
    currentPortfolioExposureUsd: combineExposure(
      suppliedPortfolio,
      tracker.total(),
    ),
    currentMarketExposureUsd: combineExposure(
      suppliedMarket,
      tracker.exposureOf(marketId),
    ),
  };
}

/** Fold one step into pipeline/loop metrics and the exposure tracker. */
export function accountAfterStep(
  tracker: { add(tokenId: string, notionalUsd: number): void; total(): number },
  metrics: StepMetricsSnapshot,
  marketId: string,
  result: {
    fill?: { status: string; makerFee: number; takerFee: number } | undefined;
    pnl?: number | undefined;
    reservedExposureUsd?: number | undefined;
  },
): void {
  const booked = result.reservedExposureUsd;
  if (typeof booked === "number" && Number.isFinite(booked) && booked > 0) {
    tracker.add(marketId, booked);
  }
  metrics.totalOrders += 1;
  if (
    result.fill &&
    (result.fill.status === "FILLED" || result.fill.status === "PARTIAL")
  ) {
    metrics.filledOrders += 1;
  }
  if (typeof result.pnl === "number" && Number.isFinite(result.pnl)) {
    metrics.totalPnl += result.pnl;
  }
  if (result.fill) {
    const maker = result.fill.makerFee;
    const taker = result.fill.takerFee;
    if (Number.isFinite(maker) && maker >= 0) metrics.totalFees += maker;
    if (Number.isFinite(taker) && taker >= 0) metrics.totalFees += taker;
  }
  metrics.currentExposureUsd = tracker.total();
  if (metrics.currentExposureUsd > metrics.maxExposureUsd) {
    metrics.maxExposureUsd = metrics.currentExposureUsd;
  }
  metrics.fillRatio =
    metrics.totalOrders > 0 ? metrics.filledOrders / metrics.totalOrders : 0;
}

function permitCashBase(permit: {
  max_cash_base?: bigint | null | undefined;
  max_cash?: number | undefined;
}): bigint | undefined {
  if (typeof permit.max_cash_base === "bigint" && permit.max_cash_base > 0n) {
    return permit.max_cash_base;
  }
  if (
    typeof permit.max_cash === "number" &&
    Number.isFinite(permit.max_cash) &&
    permit.max_cash > 0
  ) {
    return decimalToBase(permit.max_cash);
  }
  return undefined;
}

/**
 * Give back a reservation that was created and then not submitted.
 * Prefer `releaseReservation` (production: ReservationManager, which is
 * idempotent on an already-terminal row). Otherwise move the permit cash
 * back through the kernel. A second call must not throw: kernel
 * INSUFFICIENT_COMMITTED means the cash is already back.
 */
export async function releaseUnsubmittedReservation(
  deps: {
    releaseReservation?: ((reservationId: string) => Promise<void>) | undefined;
    kernel: MoneyKernel;
    wallet: { funder: string };
  },
  permit: {
    reservation_ids?: readonly string[] | undefined;
    max_cash_base?: bigint | null | undefined;
    max_cash?: number | undefined;
  },
): Promise<void> {
  const ids = (permit.reservation_ids ?? []).filter((id) => id.length > 0);
  if (deps.releaseReservation && ids.length > 0) {
    for (const id of ids) {
      try {
        await deps.releaseReservation(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[g4] reservation release failed for ${id}: ${message}`);
      }
    }
    return;
  }
  const cash = permitCashBase(permit);
  if (cash === undefined) {
    console.error(
      "[g4] reservation release skipped: permit has no cash amount",
    );
    return;
  }
  try {
    await deps.kernel.release(deps.wallet.funder, "pUSD", cash);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/INSUFFICIENT_COMMITTED/i.test(message)) return;
    console.error(`[g4] kernel reservation release failed: ${message}`);
  }
}
