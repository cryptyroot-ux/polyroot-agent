/**
 * @polyroot/runtime — LIVE preflight (`polyroot doctor --live`).
 *
 * Proves production infrastructure BEFORE real money moves. Every check is
 * fail-closed: any failure refuses the whole preflight with a named check
 * and an actionable detail. This is evidence, not a promotion — passing
 * preflight does not authorize trading (owner sign-off still required).
 */

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface LivePreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

interface DbRows {
  rows: Record<string, unknown>[];
}

export interface LivePreflightDeps {
  queryDb: (text: string, params?: unknown[]) => Promise<DbRows>;
  readBounds: () => Promise<{ capUsd?: number; lossCapPusd?: number }>;
  readUniverse: () => Promise<string[]>;
  verifyWallet: () => Promise<{ ok: boolean; detail: string }>;
  venueCredsPresent: () => Promise<boolean>;
  fetchBook: (marketId: string) => Promise<{ bid: number; ask: number } | null>;
  metricsKeyPresent: () => Promise<boolean>;
}

const REQUIRED_TABLES = [
  "execution_permits",
  "reservations",
  "recovery_ledger",
  "seen_orders",
  "live_guard_state",
  "balance_entries",
];

function fail(name: string, detail: string): PreflightCheck {
  return { name, ok: false, detail };
}

function pass(name: string, detail: string): PreflightCheck {
  return { name, ok: true, detail };
}

/** Prove every infrastructure dependency. Never throws. */
export async function runLivePreflight(
  deps: LivePreflightDeps,
): Promise<LivePreflightResult> {
  const checks: PreflightCheck[] = [];

  // 1. Database reachable.
  try {
    await deps.queryDb("SELECT 1");
    checks.push(pass("db-connect", "database reachable"));
  } catch (err) {
    checks.push(
      fail(
        "db-connect",
        `database unreachable: ${(err as Error).message} — check DATABASE_URL and that PostgreSQL is running`,
      ),
    );
    return { ok: false, checks };
  }

  // 2. Required schema (migrations applied).
  try {
    const res = await deps.queryDb(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const present = new Set(res.rows.map((r) => String(r["table_name"])));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      checks.push(
        fail(
          "db-schema",
          `missing tables: ${missing.join(", ")} — run pending migrations before live trading`,
        ),
      );
    } else {
      checks.push(pass("db-schema", "all required tables present"));
    }
  } catch (err) {
    checks.push(
      fail("db-schema", `schema check failed: ${(err as Error).message}`),
    );
  }

  // 3. Owner bounds (explicit cap + loss cap).
  try {
    const bounds = await deps.readBounds();
    if (bounds.lossCapPusd === undefined || bounds.capUsd === undefined) {
      checks.push(
        fail(
          "bounds",
          "POLYROOT_MICRO_LIVE_CAP_USD and POLYROOT_MICRO_LIVE_LOSS_CAP_USD must both be set — run `polyroot setup`",
        ),
      );
    } else {
      checks.push(
        pass(
          "bounds",
          `cap $${bounds.capUsd}, loss cap $${bounds.lossCapPusd}`,
        ),
      );
    }
  } catch (err) {
    checks.push(
      fail("bounds", `bounds check failed: ${(err as Error).message}`),
    );
  }

  // 4. Market universe (explicit, never mock data).
  let universe: string[] = [];
  try {
    universe = await deps.readUniverse();
    if (universe.length === 0) {
      checks.push(
        fail(
          "universe",
          "market universe is empty — set POLYROOT_MARKET_IDS to owner-curated CLOB token ids",
        ),
      );
    } else {
      checks.push(pass("universe", `${universe.length} market(s) curated`));
    }
  } catch (err) {
    checks.push(
      fail("universe", `universe check failed: ${(err as Error).message}`),
    );
  }

  // 5. Wallet: three distinct identities (WAL-03).
  try {
    const wallet = await deps.verifyWallet();
    checks.push(
      wallet.ok
        ? pass("wallet", wallet.detail)
        : fail("wallet", `${wallet.detail} — run \`polyroot wallet verify\``),
    );
  } catch (err) {
    checks.push(
      fail("wallet", `wallet check failed: ${(err as Error).message}`),
    );
  }

  // 6. Venue credentials present.
  try {
    const creds = await deps.venueCredsPresent();
    checks.push(
      creds
        ? pass("venue-creds", "Polymarket API credentials present")
        : fail(
            "venue-creds",
            "POLYMARKET_API_KEY/SECRET/PASSPHRASE incomplete — live submission is impossible without them",
          ),
    );
  } catch (err) {
    checks.push(
      fail(
        "venue-creds",
        `venue creds check failed: ${(err as Error).message}`,
      ),
    );
  }

  // 7. Venue read: prove live market data on the first curated market.
  try {
    if (universe.length === 0) {
      checks.push(fail("venue-read", "no market to probe (universe empty)"));
    } else {
      const book = await deps.fetchBook(universe[0] as string);
      if (!book || !Number.isFinite(book.bid) || !Number.isFinite(book.ask)) {
        checks.push(
          fail(
            "venue-read",
            `order book unreadable for ${universe[0]} — venue unreachable or market dead (refusing: never trade blind)`,
          ),
        );
      } else {
        checks.push(
          pass(
            "venue-read",
            `live book ${universe[0]}: bid ${book.bid} / ask ${book.ask}`,
          ),
        );
      }
    }
  } catch (err) {
    checks.push(
      fail("venue-read", `venue read failed: ${(err as Error).message}`),
    );
  }

  // 8. Metrics owner key (live without observability is flying blind).
  try {
    const key = await deps.metricsKeyPresent();
    checks.push(
      key
        ? pass("metrics-key", "/metrics endpoint secured")
        : fail(
            "metrics-key",
            "POLYROOT_METRICS_OWNER_KEY unset — /metrics disabled; live ops require observability",
          ),
    );
  } catch (err) {
    checks.push(
      fail("metrics-key", `metrics check failed: ${(err as Error).message}`),
    );
  }

  // 9. Loss latch state: an engaged latch BLOCKS (needs owner reset), it is
  // never a misconfiguration and never auto-clears.
  try {
    const res = await deps.queryDb(
      `SELECT halted, realized_loss_pusd FROM live_guard_state WHERE key = 'micro-live'`,
    );
    const row = res.rows[0];
    if (row && row["halted"] === true) {
      checks.push(
        fail(
          "loss-latch",
          `loss latch ENGAGED (realized loss ${String(row["realized_loss_pusd"])}) — run \`polyroot guard reset\` after loss is back under cap; preflight BLOCKED until cleared`,
        ),
      );
    } else {
      checks.push(pass("loss-latch", "loss latch clear"));
    }
  } catch (err) {
    checks.push(
      fail("loss-latch", `latch check failed: ${(err as Error).message}`),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
