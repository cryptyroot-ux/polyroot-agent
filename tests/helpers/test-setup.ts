/**
 * Test setup helper — Phase 1 scaffolding.
 *
 * Lifecycle hooks are intentionally dependency-free no-ops: current
 * contract/property suites assert structural invariants only and must run
 * in CI without a live database. DB-backed fixtures (migrations applied,
 * table truncation, market/intent factories) land in Sprint 2 together
 * with the Drizzle repositories (T-PM-LED-01…04).
 */

export async function setupTestDb(): Promise<void> {
  // No-op until Sprint 2 (see note above).
}

export async function cleanTestDb(): Promise<void> {
  // No-op until Sprint 2 (see note above).
}

export async function teardownTestDb(): Promise<void> {
  // No-op until Sprint 2 (see note above).
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
