/**
 * @polyroot/intelligence — LLM provider adapters, forecast service
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { EvidenceItem, Forecast, MarketSnapshot } from "@polyroot/domain";

/** Placeholder for AnthropicAdapter — to be implemented */
export interface AnthropicAdapter {
  complete(prompt: string): Promise<string>;
}

/** Placeholder for OpenAIAdapter — to be implemented */
export interface OpenAIAdapter {
  complete(prompt: string): Promise<string>;
}

/** Placeholder for ForecastService — to be implemented */
export interface ForecastService {
  generate(evidence: EvidenceItem[]): Promise<Forecast>;
}

/** Placeholder for CalibrationService — to be implemented */
export interface CalibrationService {
  track(forecast: Forecast, outcome: boolean): Promise<void>;
}

/** Placeholder for EvidenceStore — to be implemented */
export interface EvidenceStore {
  add(item: EvidenceItem): Promise<void>;
  getRecent(limit: number): Promise<EvidenceItem[]>;
}
