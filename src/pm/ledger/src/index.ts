/**
 * @polyroot/ledger — Financial ledger and event store (PM-LEDGER-01..04).
 * Pure primitives: entry generation, balance projections, intent-to-entry
 * mapping. No I/O.
 */
import {
  type LedgerEvent,
  type TradeIntent,
} from "@polyroot/domain";

/* ─── PM-LEDGER-01: atomic entry generation ──────────────────────────── */

export type LedgerSide = "DEBIT" | "CREDIT";

export interface LedgerEntry {
  account: string;
  side: LedgerSide;
  amount: bigint;
  asset: string;
}

/**
 * Ledger entry (PM-LEDGER-01): double-entry bookkeeping for every intent.
 * An order submit generates two entries: a credit to available and a debit
 * to reserved.
 */
export function generateEntriesForIntent(
  intent: TradeIntent,
  walletAddress: string,
  assetId: string,
  orderId: string
): LedgerEntry[] {
  // Use size if available, otherwise fall back to desired_qty or default to 0
  const size = intent.size ?? intent.desired_qty ?? 0;
  const amount = BigInt(Math.round(size * 1e6)); // base units
  
  return [
    { account: `available:${walletAddress}`, side: "CREDIT", amount, asset: assetId },
    { account: `reserved:${walletAddress}:${orderId}`, side: "DEBIT", amount, asset: assetId },
  ];
}

/* ─── PM-LEDGER-02: balance projections ──────────────────────────────── */

/**
 * Balance projection (PM-LEDGER-02): calculate effective balance by summing
 * all settled entries. This is the source of truth for the Risk plane.
 */
export function projectBalance(entries: LedgerEntry[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const e of entries) {
    const key = `${e.account}:${e.asset}`;
    const current = balances.get(key) ?? 0n;
    balances.set(key, e.side === "CREDIT" ? current + e.amount : current - e.amount);
  }
  return balances;
}

/* ─── PM-LEDGER-03: intent-to-entry mapping ──────────────────────────── */

/**
 * Intent mapping (PM-LEDGER-03): link every ledger entry back to the
 * initiating intent_id for full auditability.
 */
export function mapEntriesToEvent(
  intent: TradeIntent,
  entries: LedgerEntry[],
  now: Date
): LedgerEvent {
  return {
    schema_version: "1.0.0",
    id: `ev_${intent.intent_id}`,
    type: "INTENT_PROPOSED",
    aggregate_id: intent.intent_id,
    aggregate_type: "Intent",
    payload: { intent, entries: entries.map(e => ({ ...e, amount: e.amount.toString() })) },
    metadata: { created_at: now.toISOString() },
    timestamp: now,
  };
}

/* ─── PM-LEDGER-04: outbox pattern ───────────────────────────────────── */

/**
 * Outbox (PM-LEDGER-04): entries are staged for persistence. In-memory staged
 * entries are the source for the Reconciler to ensure ledger/venue parity.
 */
export class LedgerOutbox {
  private staged: LedgerEvent[] = [];

  stage(event: LedgerEvent): void {
    this.staged.push(event);
  }

  flush(): LedgerEvent[] {
    const out = [...this.staged];
    this.staged = [];
    return out;
  }

  get pendingCount(): number {
    return this.staged.length;
  }
}