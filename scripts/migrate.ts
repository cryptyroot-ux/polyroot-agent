#!/usr/bin/env node
/**
 * Migration runner for Polyroot
 * Usage: npx tsx scripts/migrate.ts [latest|rollback|status]
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });

const { Pool } = pg;

async function main() {
  const command = process.argv[2] || "latest";
  const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/polyroot_dev";

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);

  try {
    switch (command) {
      case "latest":
        console.log("Running migrations up...");
        await migrate(db, { migrationsFolder: resolve(process.cwd(), "migrations") });
        console.log("Migrations complete.");
        break;

      case "rollback":
        console.log("Rollback not yet implemented — use manual SQL for now.");
        break;

      case "status":
        const result = await pool.query(`
          SELECT * FROM drizzle_migrations ORDER BY created_at DESC
        `);
        console.table(result.rows);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Usage: migrate.ts [latest|rollback|status]");
        process.exit(1);
    }
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();