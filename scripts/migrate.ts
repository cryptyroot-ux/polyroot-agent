#!/usr/bin/env node
/**
 * Migration runner for PolyRoot — applies raw SQL files in lexical order.
 * Usage: npx tsx scripts/migrate.ts [latest|status]
 *
 * Rollback is intentionally unsupported: financial migrations are
 * forward-only; incompatible-schema rollback is refused by gate
 * (T-PM-OPS-07). Revert via a new forward migration.
 */

import pg from "pg";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

const { Pool } = pg;

async function main() {
  const command = process.argv[2] || "latest";
  const databaseUrl =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/polyroot_dev";

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = resolve(process.cwd(), "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied = new Set(
      (await pool.query("SELECT filename FROM schema_migrations")).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );
    const pending = files.filter((f) => !applied.has(f));

    switch (command) {
      case "latest":
      case "up": {
        if (pending.length === 0) {
          console.log("No pending migrations.");
          break;
        }
        for (const f of pending) {
          console.log(`Applying ${f}...`);
          const sql = readFileSync(resolve(dir, f), "utf-8");
          await pool.query("BEGIN");
          try {
            await pool.query(sql);
            await pool.query(
              "INSERT INTO schema_migrations (filename) VALUES ($1)",
              [f],
            );
            await pool.query("COMMIT");
          } catch (err) {
            await pool.query("ROLLBACK");
            throw err;
          }
        }
        console.log(`Applied ${pending.length} migration(s).`);
        break;
      }

      case "status": {
        for (const f of files) {
          console.log(`${applied.has(f) ? "APPLIED " : "PENDING "} ${f}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Usage: migrate.ts [latest|status]");
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
