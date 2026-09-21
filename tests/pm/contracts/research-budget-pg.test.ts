import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool } from "pg";
import { PgResearchBudget } from "@polyroot/intelligence";

const pgConfig = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polyroot_test";

describe("Research Budget PG Persistent", () => {
  let pool: Pool;
  const quota = {
    schema_version: "1.0.0",
    max_tokens: 1000,
    max_cost_usd: 1.0,
    max_duration_s: 60,
    max_sources: 10,
    max_concurrency: 2,
  };

  before(async () => {
    pool = new Pool({ connectionString: pgConfig });
    await pool.query(`TRUNCATE TABLE research_budget`);
    await pool.query(`INSERT INTO research_budget (tokens_used, cost_used_usd_micro) VALUES (0, 0)`);
  });

  after(async () => {
    await pool.end();
  });

  it("tracks cost across restarts; exhaustion blocks new research", async () => {
    const budget1 = new PgResearchBudget(pool, quota);
    await budget1.charge(500, 0.001);
    
    const budget2 = new PgResearchBudget(pool, quota); // New instance
    const check = await budget2.check(600);
    assert.equal(check.ok, false); // 500+600 > 1000 quota
    assert.equal(check.code, "BUDGET_EXHAUSTED");
  });
});