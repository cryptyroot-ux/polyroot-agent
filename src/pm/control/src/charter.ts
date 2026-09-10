/**
 * @polyroot/control — Persistent Autonomy Charter (PR-GOV-03, T-PR-GOV-03, G0-G7)
 * and hard-policy-can-not-self-weaken guard (PR-GOV-05, T-PR-GOV-05, G1-G3).
 *
 * One-time commissioning creates an immutable, versioned charter binding the
 * wallet, qualified strategies, market classes, capital ceiling, loss limits,
 * allowed actions and expiry. Routine trades require no human approval, but
 * governance mutations (promote, raise capital, change signer, extend life)
 * are refused — no LLM/strategy/plugin/recovered process can weaken hard policy.
 */

import { z } from "zod";
import { ulid } from "ulid";

export const CharterSchema = z.object({
  charter_id: z.string().default(() => ulid()),
  wallet_id: z.string().min(1),
  capital_usd_cap: z.number().positive(),
  daily_loss_stop_pct: z.number().min(0).max(1),
  qualified_strategy_ids: z.array(z.string()).min(1),
  market_class_allowlist: z.array(z.string()).min(1),
  expires_at: z.date(),
  release_ref: z.string().min(1),
  commissioned_at: z.date().default(() => new Date()),
});
export type Charter = z.infer<typeof CharterSchema>;

/** Routine financial actions + governance-only actions (PR-GOV-04, PR-GOV-07). */
export type CharterAction =
  | "SUBMIT"
  | "CANCEL"
  | "REDUCE"
  | "EXIT"
  | "REDEEM"
  | "PROMOTE_STRATEGY"
  | "INCREASE_CAPITAL"
  | "CHANGE_SIGNER"
  | "EXTEND_CHARTER";

export interface CharterRequestCtx {
  action: CharterAction;
  strategyId?: string;
  exposureUsd?: number;
  marketClass?: string;
}

export type CharterResult = { ok: true } | { ok: false; code: string; reason: string };

const ROUTINE_ACTIONS: ReadonlySet<CharterAction> = new Set(["SUBMIT", "CANCEL", "REDUCE", "EXIT", "REDEEM"]);
const GOVERNANCE_ACTIONS: ReadonlySet<CharterAction> = new Set([
  "PROMOTE_STRATEGY",
  "INCREASE_CAPITAL",
  "CHANGE_SIGNER",
  "EXTEND_CHARTER",
]);

export type CharterInput = {
  walletId: string;
  capitalUsdCap: number;
  dailyLossStopPct: number;
  qualifiedStrategyIds: string[];
  marketClassAllowlist: string[];
  expiresAt: Date;
  releaseRef: string;
};

export function commissionCharter(input: CharterInput): Charter {
  return CharterSchema.parse({
    wallet_id: input.walletId,
    capital_usd_cap: input.capitalUsdCap,
    daily_loss_stop_pct: input.dailyLossStopPct,
    qualified_strategy_ids: input.qualifiedStrategyIds,
    market_class_allowlist: input.marketClassAllowlist,
    expires_at: input.expiresAt,
    release_ref: input.releaseRef,
  });
}

/**
 * Routine autonomy runs without human approval; governance mutations fail.
 * Strategy/class/exposure constraints are hard-binding and non-self-weakening.
 */
export function charterAllows(c: Charter, req: CharterRequestCtx): CharterResult {
  if (new Date() > c.expires_at) {
    return { ok: false, code: "CHARTER_EXPIRED", reason: "autonomy charter expired" };
  }
  if (GOVERNANCE_ACTIONS.has(req.action)) {
    return { ok: false, code: "GOVERNANCE_ONLY", reason: `${req.action} is owner governance; routine autonomy cannot perform it` };
  }
  if (!ROUTINE_ACTIONS.has(req.action)) {
    return { ok: false, code: "UNKNOWN_ACTION", reason: `unknown charter action ${req.action}` };
  }
  if (req.strategyId && !c.qualified_strategy_ids.includes(req.strategyId)) {
    return { ok: false, code: "STRATEGY_NOT_QUALIFIED", reason: `${req.strategyId} is not charter-qualified` };
  }
  if (req.marketClass && !c.market_class_allowlist.includes(req.marketClass)) {
    return { ok: false, code: "MARKET_CLASS_FORBIDDEN", reason: `${req.marketClass} not in charter allowlist` };
  }
  if (req.exposureUsd !== undefined && req.exposureUsd > c.capital_usd_cap) {
    return { ok: false, code: "CAPITAL_CAP_EXCEEDED", reason: `exposure ${req.exposureUsd} > cap ${c.capital_usd_cap}` };
  }
  return { ok: true };
}