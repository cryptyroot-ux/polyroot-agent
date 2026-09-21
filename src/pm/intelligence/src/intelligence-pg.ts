/**
 * @polyroot/intelligence-pg — PostgreSQL-wired Intelligence plane.
 *
 * Wires the Intelligence plane with PostgreSQL-backed implementations:
 * - PgSourceRegistry (persistent source records with syndication folding)
 * - PgCatalystBus (durable outbox + watermark for catalyst events)
 * - PgResearchBudget (persistent token/cost tracking)
 *
 * These implementations share interfaces with their in-memory counterparts
 * but persist state across restarts.
 */

import { Pool, type PoolConfig } from "pg";
import {
  type SourceRecord,
  type CatalystEvent,
  type ResearchQuota,
} from "@polyroot/domain";
import {
  type SourceRegistryInterface,
  type CatalystBusInterface,
  type ResearchBudgetInterface,
  type DurableOutboxResult,
} from "./index.js";

/**
 * PostgreSQL-backed Intelligence plane wiring.
 * Provides factory functions to create PG-backed implementations.
 */
export type IntelligencePgDeps = {
  pgConfig: PoolConfig | string;
};

export type IntelligencePgStores = {
  sourceRegistry: SourceRegistryInterface;
  catalystBus: CatalystBusInterface;
  researchBudget: ResearchBudgetInterface;
};

/**
 * Create all PG-backed Intelligence stores from a single connection pool.
 */
export async function createIntelligencePgStores(
  deps: IntelligencePgDeps,
): Promise<IntelligencePgStores> {
  const pool = new Pool(
    typeof deps.pgConfig === "string" ? { connectionString: deps.pgConfig } : deps.pgConfig,
  );

  const { PgSourceRegistry } = await import("./index.js");
  const { PgCatalystBus } = await import("./index.js");
  const { PgResearchBudget } = await import("./index.js");

  const sourceRegistry = new PgSourceRegistry(pool);
  const catalystBus = new PgCatalystBus(pool);
  const researchBudget = new PgResearchBudget(
    pool,
    { max_tokens: 1_000_000, max_cost_usd: 100 } as any,
  );

  return {
    sourceRegistry,
    catalystBus,
    researchBudget,
  };
}
