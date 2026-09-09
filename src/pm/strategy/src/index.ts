/**
 * @polyroot/strategy — Strategy engines, quote generation
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { TradeIntent, Forecast, MarketSnapshot } from "@polyroot/domain";

/** Placeholder for EvidenceDirectionalV1 — to be implemented */
export interface EvidenceDirectionalV1 {
  evaluate(evidence: unknown[]): Promise<TradeIntent | null>;
}

/** Placeholder for QuoteEngine — to be implemented */
export interface QuoteEngine {
  price(intent: TradeIntent): Promise<TradeIntent>;
}

/** Placeholder for StrategyRegistry — to be implemented */
export interface StrategyRegistry {
  register(name: string, strategy: EvidenceDirectionalV1): void;
  get(name: string): EvidenceDirectionalV1 | undefined;
}
