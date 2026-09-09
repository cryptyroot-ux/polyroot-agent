/**
 * @polyroot/data — Market data adapters, provider adapters, PostgreSQL models
 *
 * Exports:
 * - MarketDataAdapter: reads from Polymarket SDK / WS
 * - ProviderAdapter: normalizes LLM provider outputs
 * - Database: Drizzle ORM setup + migrations
 * - Repositories: evidence, forecast, intent, position, etc.
 */

export { MarketDataAdapter } from "./adapters/market-data";
export { ProviderAdapter } from "./adapters/provider";
export { db, schema } from "./db";
export * from "./repositories";
