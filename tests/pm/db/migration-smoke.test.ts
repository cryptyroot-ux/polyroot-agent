/**
 * Migration smoke test: verifies that all migrations can be applied to a fresh database.
 * This test creates a temporary database, runs all migrations, and checks schema integrity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import { resolve } from "path";

const MIGRATIONS_DIR = resolve("migrations");
const EXPECTED_MIGRATION_COUNT = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => /^\d{4}_/.test(f)).length;

const BASE_PG_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://polyroot:polyroot@127.0.0.1:5432/polyroot_dev";

// Skip cleanly if DB is unreachable (CI without Postgres).
function dbAvailable(): boolean {
  try {
    execFileSync("psql", [BASE_PG_URL, "-c", "SELECT 1"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DB_OK = dbAvailable();

describe("Migration smoke test (fresh DB)", { skip: !DB_OK }, () => {
  it("applies all migrations from 0001 to latest without errors", async () => {
    const dbName = `polyroot_test_migration_smoke_${randomUUID().slice(0, 8)}`;
    const dbUrl = BASE_PG_URL.replace(/\/[^\/]+$/, `/${dbName}`);

    // Create database
    try {
      execFileSync("psql", [BASE_PG_URL, "-c", `CREATE DATABASE "${dbName}"`], {
        stdio: "pipe",
      });
    } catch (err) {
      throw new Error(`Failed to create test database: ${err}`);
    }

    try {
      // Run migrations
      const migrateResult = spawnSync(
        "npx",
        ["tsx", "scripts/migrate.ts", "latest"],
        {
          env: { ...process.env, DATABASE_URL: dbUrl },
          stdio: "pipe",
        },
      );

      if (migrateResult.status !== 0) {
        throw new Error(
          `Migration failed: ${migrateResult.stderr.toString()}\nStdout: ${migrateResult.stdout.toString()}`,
        );
      }

      // Verify schema_migrations table exists and has expected rows
      const countResult = execFileSync(
        "psql",
        [dbUrl, "-t", "-c", "SELECT COUNT(*) FROM schema_migrations"],
        { stdio: "pipe" },
      );
      const count = parseInt(countResult.toString().trim(), 10);
      // We expect as many migrations as SQL files in migrations/
      assert.strictEqual(
        count,
        EXPECTED_MIGRATION_COUNT,
        `Expected ${EXPECTED_MIGRATION_COUNT} migrations to be applied`,
      );

      // Optionally, check that a few core tables exist
      const tablesResult = execFileSync(
        "psql",
        [
          dbUrl,
          "-t",
          "-c",
          "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'",
        ],
        { stdio: "pipe" },
      );
      const tableCount = parseInt(tablesResult.toString().trim(), 10);
      assert.ok(tableCount > 0, "Expected at least one table in public schema");

      // Check for specific tables we know should exist after migration 0007
      const requiredTables = [
        "balance_entries",
        "kernel_events",
        "execution_permits",
        "executor_leases",
        "recovery_ledger",
        "supervisor_state",
        "schema_migrations",
      ];
      for (const table of requiredTables) {
        const existsResult = execFileSync(
          "psql",
          [
            dbUrl,
            "-t",
            "-c",
            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${table}')`,
          ],
          { stdio: "pipe" },
        );
        const exists = existsResult.toString().trim() === "t";
        assert.ok(exists, `Expected table ${table} to exist`);
      }
    } finally {
      // Clean up: drop the test database
      try {
        execFileSync("psql", [BASE_PG_URL, "-c", `DROP DATABASE "${dbName}"`], {
          stdio: "pipe",
        });
      } catch (err) {
        console.warn(`Failed to drop test database ${dbName}: ${err}`);
      }
    }
  });
});
