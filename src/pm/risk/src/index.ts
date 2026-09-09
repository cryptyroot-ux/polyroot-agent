/**
 * @polyroot/risk — Risk engine, EV calculation, sizing, reservations
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { TradeIntent, RiskDecision, RiskPolicy, Portfolio } from "@polyroot/domain";

/** Placeholder for RiskEngine — to be implemented */
export interface RiskEngine {
  evaluate(intent: TradeIntent, policy: RiskPolicy, portfolio: Portfolio): Promise<RiskDecision>;
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
