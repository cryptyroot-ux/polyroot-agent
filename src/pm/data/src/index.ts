/**
 * @polyroot/data — Market data adapters, provider adapters, PostgreSQL models
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
import type { MarketSnapshot, EvidenceItem } from "@polyroot/domain";

export type { MarketSnapshot, EvidenceItem };

/** Placeholder for MarketDataAdapter — to be implemented */
export interface MarketDataAdapter {
  getSnapshot(marketId: string): Promise<MarketSnapshot>;
  subscribe(marketIds: string[]): AsyncIterable<MarketSnapshot>;
}

/** Placeholder for ProviderAdapter — to be implemented */
export interface ProviderAdapter {
  normalize(response: unknown): unknown;
}

/** Placeholder for Database — to be implemented */
export interface Database {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** Placeholder for Repositories — to be implemented */
export interface Repositories {
  evidence: unknown;
  forecasts: unknown;
  intents: unknown;
  positions: unknown;
}
