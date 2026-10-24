/**
 * @polyroot/risk — funder pUSD presence and owner-attested credit.
 *
 * A missing balance row is not zero. Callers must not insert (0, 0) and
 * then treat the account as funded. LIVE startup and `doctor --live`
 * refuse until available + committed is a positive integer.
 *
 * There is no CLOB balance reader in this repo. `planAttestedCredit` /
 * `applyAttestedCredit` record an owner attestation (amount + source
 * text) in `kernel_events`. That is not an on-chain sync. The command
 * refuses non-positive amounts, empty sources, and any decrease.
 */

import { randomUUID } from "node:crypto";

export interface FunderCashBalances {
  availableBase: bigint;
  committedBase: bigint;
}

export type FunderCashAssessment =
  | {
      ok: true;
      availableBase: bigint;
      committedBase: bigint;
      totalBase: bigint;
    }
  | {
      ok: false;
      code: "FUNDER_CASH_MISSING" | "FUNDER_CASH_UNFUNDED";
      detail: string;
    };

const CREDIT_HINT =
  'Credit verified funder pUSD with `polyroot bankroll credit --amount <usd> --source "<where you read the balance>"` before LIVE. This process will not invent a balance.';

/** Missing row and a zero row are both unfunded. Never treats absence as 0. */
export function assessFunderCash(
  entry: FunderCashBalances | null,
): FunderCashAssessment {
  if (!entry) {
    return {
      ok: false,
      code: "FUNDER_CASH_MISSING",
      detail: `no pUSD balance row for the funder. ${CREDIT_HINT}`,
    };
  }
  const total = entry.availableBase + entry.committedBase;
  if (total <= 0n) {
    return {
      ok: false,
      code: "FUNDER_CASH_UNFUNDED",
      detail: `funder pUSD available+committed is 0. ${CREDIT_HINT}`,
    };
  }
  return {
    ok: true,
    availableBase: entry.availableBase,
    committedBase: entry.committedBase,
    totalBase: total,
  };
}

/** Parse a pg numeric / string / bigint base-unit column. Unreadable → null. */
export function parseBaseUnits(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  return null;
}

/** One balance row, or null when the SELECT returned nothing or garbage. */
export function balancesFromRow(
  row: Record<string, unknown> | undefined,
): FunderCashBalances | null {
  if (!row) return null;
  const availableBase = parseBaseUnits(row["available_base"]);
  const committedBase = parseBaseUnits(row["committed_base"]);
  if (availableBase === null || committedBase === null) return null;
  return { availableBase, committedBase };
}

/**
 * USD string → integer base units (1e6). Rejects negatives, scientific
 * notation, and more than 6 fractional digits so the credit cannot round.
 */
export function usdToBase(usd: string): bigint | null {
  const s = usd.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (!whole || whole.length > 18) return null;
  const padded = frac.padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

export type CreditPlan =
  | {
      ok: true;
      amountBase: bigint;
      source: string;
      action: "insert" | "increase" | "noop";
    }
  | { ok: false; code: string; detail: string };

/**
 * Decide a credit without writing. `source` is the operator's note of
 * where the figure was read (UI, statement). It is stored, not trusted
 * as a chain proof. Decreases are refused.
 */
export function planAttestedCredit(input: {
  amountUsd: string;
  source: string;
  existing: FunderCashBalances | null;
}): CreditPlan {
  const source = input.source.trim();
  if (source.length < 8) {
    return {
      ok: false,
      code: "CREDIT_SOURCE_REQUIRED",
      detail:
        "pass --source with where the pUSD figure was verified (at least 8 characters). This command does not read the chain.",
    };
  }
  if (source.length > 500) {
    return {
      ok: false,
      code: "CREDIT_SOURCE_REQUIRED",
      detail: "--source must be at most 500 characters",
    };
  }
  const amountBase = usdToBase(input.amountUsd);
  if (amountBase === null || amountBase <= 0n) {
    return {
      ok: false,
      code: "CREDIT_AMOUNT_INVALID",
      detail:
        "--amount must be a positive USD amount with at most 6 decimal places",
    };
  }
  if (!input.existing) {
    return { ok: true, amountBase, source, action: "insert" };
  }
  const total = input.existing.availableBase + input.existing.committedBase;
  if (amountBase < total) {
    return {
      ok: false,
      code: "CREDIT_WOULD_DECREASE",
      detail: `refusing to lower funder pUSD from ${total} base units to ${amountBase}. Attested credit only inserts or increases.`,
    };
  }
  if (amountBase === total) {
    return { ok: true, amountBase, source, action: "noop" };
  }
  const nextAvailable = amountBase - input.existing.committedBase;
  if (nextAvailable < 0n) {
    return {
      ok: false,
      code: "CREDIT_WOULD_DECREASE",
      detail:
        "refusing to set available below zero while committed cash is still outstanding",
    };
  }
  return { ok: true, amountBase, source, action: "increase" };
}

export interface CashQuery {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export type AttestedCreditResult =
  | {
      ok: true;
      action: "insert" | "increase" | "noop";
      amountBase: bigint;
      totalBase: bigint;
    }
  | { ok: false; code: string; detail: string };

/**
 * Apply an attested credit inside the caller's transaction.
 * Writes `kernel_events` topic `FUNDER_CASH_ATTESTED` for insert and
 * increase. A noop still writes the audit row so a repeated command
 * is visible. Does not commit or roll back.
 */
export async function applyAttestedCredit(
  db: CashQuery,
  input: { account: string; amountUsd: string; source: string },
): Promise<AttestedCreditResult> {
  const account = input.account.trim();
  if (!account) {
    return {
      ok: false,
      code: "CREDIT_ACCOUNT_MISSING",
      detail: "WALLET_FUNDER is required",
    };
  }
  const existing = await db.query(
    `SELECT available_base, committed_base FROM balance_entries
      WHERE account = $1 AND asset = 'pUSD' FOR UPDATE`,
    [account],
  );
  const row = existing.rows[0];
  const balances = balancesFromRow(row);
  if (existing.rows.length > 0 && balances === null) {
    return {
      ok: false,
      code: "CREDIT_BALANCE_UNREADABLE",
      detail: "existing pUSD row is not an integer base-unit balance",
    };
  }
  const plan = planAttestedCredit({
    amountUsd: input.amountUsd,
    source: input.source,
    existing: existing.rows.length === 0 ? null : balances,
  });
  if (!plan.ok) return plan;

  let totalBase = plan.amountBase;
  if (plan.action === "insert") {
    const inserted = await db.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base)
       VALUES ($1, 'pUSD', $2, 0)
       ON CONFLICT (account, asset) DO NOTHING
       RETURNING available_base, committed_base`,
      [account, plan.amountBase.toString()],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      return {
        ok: false,
        code: "CREDIT_CONFLICT",
        detail:
          "a pUSD row appeared during credit; re-run so the increase check can see it",
      };
    }
  } else if (plan.action === "increase") {
    const committed = balances?.committedBase ?? 0n;
    const nextAvailable = plan.amountBase - committed;
    const updated = await db.query(
      `UPDATE balance_entries
          SET available_base = $3, updated_at = now()
        WHERE account = $1 AND asset = 'pUSD'
          AND committed_base = $2
        RETURNING available_base, committed_base`,
      [account, committed.toString(), nextAvailable.toString()],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return {
        ok: false,
        code: "CREDIT_CONFLICT",
        detail: "funder balance changed during credit; nothing was written",
      };
    }
    totalBase = plan.amountBase;
  } else {
    totalBase =
      (balances?.availableBase ?? 0n) + (balances?.committedBase ?? 0n);
  }

  await db.query(
    `INSERT INTO kernel_events (topic, aggregate_type, aggregate_id, payload, metadata, created_at)
     VALUES ('FUNDER_CASH_ATTESTED', 'balance', $1::uuid, $2::jsonb, $3::jsonb, now())`,
    [
      randomUUID(),
      JSON.stringify({
        account,
        asset: "pUSD",
        action: plan.action,
        amountBase: plan.amountBase.toString(),
        totalBase: totalBase.toString(),
        source: plan.source,
        note: "owner attestation, not a chain balance read",
      }),
      JSON.stringify({ source: "polyroot bankroll credit" }),
    ],
  );

  return {
    ok: true,
    action: plan.action,
    amountBase: plan.amountBase,
    totalBase,
  };
}
