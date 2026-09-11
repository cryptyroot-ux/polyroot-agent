/**
 * @polyroot/control — Access & compliance state (PR-GOV-06, T-PR-GOV-06, G0-G7).
 *
 * Polymarket geographic/access state is rechecked before LIVE activation and
 * periodically during operation. BLOCKED and CLOSE_ONLY are first-class states.
 * PolyRoot never implements location-bypass behavior: in BLOCKED no financial
 * action is permitted; in CLOSE_ONLY only platform-permitted risk reduction
 * and cancel proceed. Unknown/undefined states fail closed.
 */

export const ACCESS_STATES = [
  "NORMAL",
  "GEO_BLOCKED",
  "ACCESS_BLOCKED",
  "CLOSE_ONLY",
  "UNKNOWN",
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export type AccessAction = "ORDER_SUBMIT" | "ORDER_CANCEL" | "REDUCE_ONLY" | "READ";

export type AccessDecision = { ok: boolean; code?: string; reason?: string };

import type { FinancialGate } from "./state.js";
export type { FinancialGate } from "./state.js";

/**
 * Whether an action is legal in the current geographic/access state.
 * Only READ is allowed under ACCESS_BLOCKED; CLOSE_ONLY permits cancel and
 * explicit REDUCE_ONLY of verified inventory (never a new long).
 */
export function accessAllows(state: AccessState, action: AccessAction): AccessDecision {
  switch (state) {
    case "NORMAL":
      return { ok: true };
    case "GEO_BLOCKED":
    case "ACCESS_BLOCKED":
      return action === "READ"
        ? { ok: true }
        : { ok: false, code: "ACCESS_BLOCKED", reason: `compliance state ${state}: only read allowed` };
    case "CLOSE_ONLY":
      if (action === "ORDER_CANCEL" || action === "REDUCE_ONLY") {
        return { ok: true, reason: "close_only: platform-permitted cancel/reduce only" };
      }
      return { ok: false, code: "ACCESS_CLOSE_ONLY", reason: "close_only: no new entries" };
    case "UNKNOWN":
    default:
      return { ok: false, code: "ACCESS_UNKNOWN", reason: "unknown access state — fail closed" };
  }
}


/** Classify the access state into a financial-gate level. */
export function computeAccessGate(state: AccessState): FinancialGate {
  switch (state) {
    case "NORMAL":
      return "ALLOW";
    case "CLOSE_ONLY":
      return "ENTRY_BLOCKED";
    case "GEO_BLOCKED":
    case "ACCESS_BLOCKED":
    case "UNKNOWN":
    default:
      return "FINANCIAL_BLOCKED";
  }
}