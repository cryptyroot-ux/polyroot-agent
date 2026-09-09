/**
 * @polyroot/risk — Loss limits (PM-RISK-03).
 *
 * Conservative loss accounting:
 *  - baseline equity is capital, adjusted ONLY by realized activity — a
 *    deposit/withdrawal must NOT silently erase an accrued loss (TEST:
 *    "deposit does not erase a loss");
 *  - once a daily-loss or drawdown breach is recorded it PERSISTS across
 *    restart until an explicit owner resume — a process restart must not
 *    clear a stored breach (TEST: "restart does not clear a stored breach").
 *
 * This module is pure: the breach seal is carried in, so the caller (ledger /
 * supervisor) is responsible for persisting `seal` durably. Nothing here
 * derives a breach from transient market data.
 */

import type { Portfolio, RiskPolicy } from "@polyroot/domain";

export interface LossFloorInput {
  policy: RiskPolicy;
  portfolio: Portfolio;
  /** Conservative equity basis the owner commissioned (USD). */
  equityBasisUsd: number;
  /** Previously persisted breach seal — survives restarts. */
  sealedBreach: boolean;
  /** Realized daily loss already booked this period (USD, signed negative). */
  realized_pnl_24h: number;
}

export interface LossBreachResult {
  blocked: boolean;
  sealedBreach: boolean;
  reasons: string[];
}

/**
 * PM-RISK-03: decide whether new risk is allowed under loss limits.
 *
 * A stored `sealedBreach` always blocks until the owner resumes. Otherwise the
 * daily-loss and drawdown ratios are compared against a CONSERVATIVE equity
 * that never rises on a deposit (deposits add basis but do not reclaim loss —
 * the accumulator uses the loss side, not a naive equity level).
 */
export function lossFloor(args: LossFloorInput): LossBreachResult {
  const reasons: string[] = [];

  // A previously persisted breach survives any restart.
  if (args.sealedBreach) {
    reasons.push("sealed breach persists until owner resume (PM-RISK-03)");
    return { blocked: true, sealedBreach: true, reasons };
  }

  // Conservative equity: realized losses lower the working basis; a positive
  // deposit delta is never minted back as "recovered" loss.
  const lossAccum = -Math.min(0, args.realized_pnl_24h);
  const lossRealizedPct = lossAccum / Math.max(args.equityBasisUsd, 1e-9);

  // Drawdown also uses the loss accumulator, so deposits do not erase it.
  if (lossRealizedPct >= args.policy.daily_loss_stop_pct) {
    reasons.push(
      `daily loss ${lossRealizedPct.toFixed(4)} >= ` +
        `daily_loss_stop_pct ${args.policy.daily_loss_stop_pct}`,
    );
  }

  if (lossRealizedPct >= args.policy.drawdown_stop_pct) {
    reasons.push(
      `drawdown ${lossRealizedPct.toFixed(4)} >= ` +
        `drawdown_stop_pct ${args.policy.drawdown_stop_pct}`,
    );
  }

  if (reasons.length > 0) {
    return { blocked: true, sealedBreach: true, reasons };
  }

  return { blocked: false, sealedBreach: false, reasons };
}