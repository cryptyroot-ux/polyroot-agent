/**
 * @polyroot/observability — Metrics, logging, alerts
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { LedgerEvent } from "@polyroot/domain";

/** Placeholder for Metrics — to be implemented */
export interface Metrics {
  increment(name: string, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
}

/** Placeholder for Logger — to be implemented */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/** Placeholder for AlertManager — to be implemented */
export interface AlertManager {
  addRule(rule: unknown): void;
  check(): Promise<void>;
}

/** Placeholder for HealthCheck — to be implemented */
export interface HealthCheck {
  check(): Promise<{ status: "healthy" | "degraded" | "unhealthy"; details: Record<string, unknown> }>;
}
