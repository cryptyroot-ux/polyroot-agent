/**
 * Test setup helper — runs before all tests
 * Sets up test database, mocks, and global utilities
 */

import { config } from "dotenv";
import { resolve } from "path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Load test env
config({ path: resolve(process.cwd(), ".env.test") });

// Global test pool (shared across test files)
const testPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/polyroot_test",
  max: 5,
});

export const testDb = drizzle(testPool);

// Run migrations once before tests
let migrated = false;
export async function setupTestDb() {
  if (!migrated) {
    await migrate(testDb, { migrationsFolder: resolve(process.cwd(), "migrations") });
    migrated = true;
  }
}

// Clean all tables between test suites
export async function cleanTestDb() {
  const tables = [
    "audit_log",
    "portfolio_snapshots",
    "positions",
    "orders",
    "reservations",
    "risk_decisions",
    "trade_intents",
    "forecasts",
    "evidence_items",
    "outbox",
    "ledger_events",
    "market_snapshots",
    "funding_rates",
    "markets",
    "events",
    "risk_policy",
  ];

  for (const table of tables) {
    await testPool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
  }

  // Re-insert default risk policy
  await testPool.query(`
    INSERT INTO risk_policy (order_cap_share, market_cap_share, event_group_cap_share,
                             portfolio_cap_share, daily_loss_stop_share, drawdown_stop_share,
                             min_edge_per_share)
    VALUES (0.005, 0.02, 0.05, 0.10, 0.02, 0.05, 0.03)
  `);
}

// Teardown
export async function teardownTestDb() {
  await testPool.end();
}

// Helper: create test market
export async function createTestMarket(overrides = {}) {
  const id = `test-market-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const eventId = `test-event-${Date.now()}`;

  await testPool.query(`
    INSERT INTO events (id, title, status)
    VALUES ($1, 'Test Event', 'ACTIVE')
    ON CONFLICT DO NOTHING
  `, [eventId]);

  const market = {
    id,
    event_id: eventId,
    question: "Will test pass?",
    outcomes: ["Yes", "No"],
    outcome_prices: [0.55, 0.45],
    fee_maker_bps: 0,
    fee_taker_bps: 2,
    is_neg_risk: false,
    volume_24h: 10000,
    open_interest: 5000,
    status: "ACTIVE",
    ...overrides,
  };

  await testPool.query(`
    INSERT INTO markets (id, event_id, question, outcomes, outcome_prices,
                         fee_maker_bps, fee_taker_bps, is_neg_risk,
                         volume_24h, open_interest, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    market.id, market.event_id, market.question, market.outcomes, market.outcome_prices,
    market.fee_maker_bps, market.fee_taker_bps, market.is_neg_risk,
    market.volume_24h, market.open_interest, market.status,
  ]);

  return market;
}

// Helper: create test intent
export async function createTestIntent(marketId: string, overrides = {}) {
  const intent = {
    id: `test-intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    market_id: marketId,
    side: "YES",
    price: 0.55,
    size: 100,
    order_type: "LIMIT",
    expiration_sec: 3600,
    strategy: "test",
    status: "PROPOSED",
    ...overrides,
  };

  await testPool.query(`
    INSERT INTO trade_intents (id, market_id, side, price, size, order_type,
                               expiration_sec, strategy, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    intent.id, intent.market_id, intent.side, intent.price, intent.size,
    intent.order_type, intent.expiration_sec, intent.strategy, intent.status,
  ]);

  return intent;
}

// Mock LLM response
export const mockForecast = {
  id: "test-forecast-" + Date.now(),
  marketId: "test-market",
  horizonSec: 3600,
  probabilityYes: 0.6,
  confidence: 0.8,
  model: "test-model",
  features: {},
  evidenceIds: [],
  createdAt: new Date(),
};