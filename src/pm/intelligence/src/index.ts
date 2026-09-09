/**
 * @polyroot/intelligence — LLM provider adapters, forecast service
 *
 * Exports:
 * - AnthropicAdapter: Claude API integration
 * - OpenAIAdapter: GPT API integration
 * - ForecastService: orchestrates evidence → forecast
 * - CalibrationService: tracks forecast accuracy over time
 */

export { AnthropicAdapter } from "./adapters/anthropic";
export { OpenAIAdapter } from "./adapters/openai";
export { ForecastService } from "./services/forecast";
export { CalibrationService } from "./services/calibration";
export { EvidenceStore } from "./stores/evidence";
