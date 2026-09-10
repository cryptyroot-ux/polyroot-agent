/**
 * @polyroot/risk — Risk engine, EV calculation, sizing, reservations
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
import type {
  TradeIntent,
  RiskDecision,
  RiskPolicy,
  Portfolio,
} from "@polyroot/domain";

export type { TradeIntent, RiskDecision, RiskPolicy, Portfolio };

/** Placeholder for RiskEngine — to be implemented */
export interface RiskEngine {
  evaluate(
    intent: TradeIntent,
    policy: RiskPolicy,
    portfolio: Portfolio,
  ): Promise<RiskDecision>;
}

/** Placeholder for EVCalculator — to be implemented */
export interface EVCalculator {
  calculate(intent: TradeIntent): number;
}

/** Placeholder for SizingEngine — to be implemented */
export interface SizingEngine {
  size(intent: TradeIntent, policy: RiskPolicy, portfolio: Portfolio): number;
}

/** Placeholder for ReservationManager — to be implemented */
export interface ReservationManager {
  reserve(decision: RiskDecision): Promise<string>;
  release(reservationId: string): Promise<void>;
}

/** Placeholder for PolicyStore — to be implemented */
export interface PolicyStore {
  get(): Promise<RiskPolicy>;
  update(policy: Partial<RiskPolicy>): Promise<void>;
}

// Money Kernel (PM-RISK-01..08, Blueprint B9)
export * from "./money-kernel.js";

// PostgreSQL implementations for MoneyKernel ports
export * from "./money-kernel-pg.js";

// Kill switch + reduction paths (PM-RISK-05/06)
export * from "./kill-switch.js";

// Key-compromise response planner (PM-SEC-08)
export * from "./key-compromise.js";

// Loss floors (PM-RISK-03)
export * from "./loss-floor.js";
