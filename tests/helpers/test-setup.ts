/**
 * Test setup helper — Phase 12 scaffolding.
 *
 * This session implements the durable ledger abstractions (EventStore,
 * ProjectionEngine, OutboxProcessor) backed by PostgreSQL migration 0005 tables.
 * See each package's tsdoc for detailed invariants.
 *
 * Lifecycle hooks are still no-ops until Sprint 2 (repositories/migrations).
 */

export async function setupTestDb(): Promise<void> {
  // No-op: durable abstractions are pure-Ports interfaces. Integration
  // tests that touch PostgreSQL are added in Sprint 2 alongside the
  // Drizzle repositories (T-PM-LED-01…04).
}

export async function cleanTestDb(): Promise<void> {
  // No-op until Sprint 2.
}

export async function teardownTestDb(): Promise<void> {
  // No-op until Sprint 2.
}

// DB-backed factories arrive with the repositories (Sprint 2).
export async function createTestMarket(
  _overrides: Record<string, unknown> = {},
): Promise<never> {
  throw new Error("createTestMarket: not implemented until Sprint 2");
}

export async function createTestIntent(
  _marketId: string,
  _overrides: Record<string, unknown> = {},
): Promise<never> {
  throw new Error("createTestIntent: not implemented until Sprint 2");
}

// Deterministic mock forecast for placeholder suites.
export const mockForecast = {
  id: "test-forecast-bootstrap",
  marketId: "test-market",
  horizonSec: 3600,
  probabilityYes: 0.6,
  confidence: 0.8,
  model: "test-model",
  features: {},
  evidenceIds: [],
  createdAt: new Date("2026-09-09T00:00:00Z"),
};