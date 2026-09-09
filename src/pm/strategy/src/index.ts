/**
 * @polyroot/strategy — Strategy engines, quote generation
 *
 * Exports:
 * - EvidenceDirectionalV1: main strategy (evidence → forecast → intent)
 * - QuoteEngine: prices intents with sizing
 * - StrategyRegistry: manages available strategies
 */

export { EvidenceDirectionalV1 } from "./strategies/evidence-directional-v1";
export { QuoteEngine } from "./engines/quote";
export { StrategyRegistry } from "./registry";
