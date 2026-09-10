/**
 * @polyroot/control — Operational state model (PRD P3.2 / Blueprint B3.2).
 *
 * Four orthogonal axes: operation mode, runtime health, venue mode, risk tier.
 * Only LIVE can send financial orders; mode is not health; venue mode is not
 * health. Hard-blocking health states (RECOVERING, ACCESS_BLOCKED,
 * EMERGENCY_HALT, STOPPED) never self-bypass.
 */

export type OperationMode = "RESEARCH" | "PAPER" | "SHADOW" | "LIVE";

export type RuntimeHealth =
  | "STOPPED"
  | "BOOTSTRAPPING"
  | "RECOVERING"
  | "ACTIVE"
  | "DEGRADED"
  | "PROTECTIVE_PAUSE"
  | "ACCESS_BLOCKED"
  | "EMERGENCY_HALT";

export type VenueMode =
  | "NORMAL"
  | "POST_ONLY"
  | "CANCEL_ONLY"
  | "RESTARTING"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type RiskTier = "NORMAL" | "CAUTIOUS" | "PROTECTIVE";

/** Financial gate classification. */
export type FinancialGate = "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED";

const FINANCIAL_BLOCK_HEALTH: ReadonlySet<RuntimeHealth> = new Set([
  "STOPPED",
  "RECOVERING",
  "ACCESS_BLOCKED",
  "EMERGENCY_HALT",
]);

const ENTRY_BLOCK_HEALTH: ReadonlySet<RuntimeHealth> = new Set([
  "BOOTSTRAPPING",
  "DEGRADED",
  "PROTECTIVE_PAUSE",
]);

const FINANCIAL_BLOCK_VENUE: ReadonlySet<VenueMode> = new Set(["UNAVAILABLE", "UNKNOWN"]);

const ENTRY_BLOCK_VENUE: ReadonlySet<VenueMode> = new Set([
  "POST_ONLY",
  "CANCEL_ONLY",
  "RESTARTING",
]);

/**
 * Classify whether financial activity is allowed right now.
 *  - mode !== LIVE → no financial orders (PAPER/SHADOW never spend real money).
 *  - hard-blocking health/venue → all financial activity blocked (fail closed).
 *  - degraded/cautious venue+health → new entries blocked, cancels/reductions intact.
 *  - otherwise → ALLOW (routine autonomy, no human approval).
 */
export function computeGate(
  mode: OperationMode,
  health: RuntimeHealth,
  venueMode: VenueMode,
): FinancialGate {
  if (mode !== "LIVE") return "FINANCIAL_BLOCKED";
  if (FINANCIAL_BLOCK_HEALTH.has(health) || FINANCIAL_BLOCK_VENUE.has(venueMode)) {
    return "FINANCIAL_BLOCKED";
  }
  if (ENTRY_BLOCK_HEALTH.has(health) || ENTRY_BLOCK_VENUE.has(venueMode)) {
    return "ENTRY_BLOCKED";
  }
  return "ALLOW";
}