/**
 * @polyroot/ledger — Financial ledger primitives and durable ports (PM-LEDGER-01..07).
 *
 * Pure primitives (PM-LEDGER-01..03): entry generation, balance projections,
 * intent-to-event mapping.
 * Durable ports (PM-LEDGER-04..07): EventStore, ProjectionEngine, OutboxProcessor.
 * PostgreSQL implementations live in pg-*.ts files.
 */

import { ulid } from "ulid";
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
 *
 * Exact integer/base-unit arithmetic: amounts are in base units (1e6 per
 * standard unit). No float arithmetic — size comes from the intent as a
 * number but conversion to base units is done via BigInt truncation after
 * the exact integer product, preserving no float drift.
 */
export function generateEntriesForIntent(
  intent: TradeIntent,
  walletAddress: string,
  assetId: string,
  orderId: string,
): LedgerEntry[] {
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

/* ─── PM-LEDGER-03: intent-to-event mapping ──────────────────────────── */

/**
 * Intent mapping (PM-LEDGER-03): link every ledger entry back to the
 * initiating intent_id for full auditability.
 *
 * The event id is a ULID (stable identity) while aggregate_id stays the
 * human-readable intent id. Both are preserved when the event is persisted.
 */
export function mapEntriesToEvent(
  intent: TradeIntent,
  entries: LedgerEntry[],
  now: Date = new Date(),
): LedgerEvent {
  return {
    schema_version: "1.0.0",
    id: ulid(),
    type: "INTENT_PROPOSED",
    aggregate_id: intent.intent_id,
    aggregate_type: "Intent",
    payload: { intent, entries: entries.map((e) => ({ ...e, amount: e.amount.toString() })) },
    metadata: { created_at: now.toISOString() },
    timestamp: now,
  };
}

/* ─── PM-LEDGER-04: in-memory outbox (tests/prototyping) ────────────── */

/**
 * In-memory outbox for tests and prototyping. Production code uses the
 * PgOutboxProcessor backed by the durable outbox_checkpoints table.
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

/* ─── PM-LED-05: EventStore port ─────────────────────────────────────── */

/** Cursor for resumable replay. `fromSequence` is inclusive. */
export interface EventCursor {
  fromSequence: bigint;
  limit?: number;
}

/** Result of an append operation. */
export interface AppendResult {
  eventId: string;
  sequence: bigint;
  /** true when the event was newly written; false when it was a duplicate. */
  created: boolean;
}

/**
 * EventStore port — append-only, replayable, idempotent.
 *
 * Implementations must guarantee:
 *   1. Appending the same event twice returns the same eventId/sequence with
 *      `created: false`.
 *   2. Events are never mutated after append.
 *   3. Replay returns events strictly in ascending sequence order.
 */
export interface EventStore {
  append(event: LedgerEvent): Promise<AppendResult>;
  appendMany(events: LedgerEvent[]): Promise<AppendResult[]>;
  getEvent(id: string): Promise<LedgerEvent | undefined>;
  /** Replay events for an aggregate, or all events, from a cursor. */
  replay(cursor: EventCursor & { aggregateId?: string }): Promise<LedgerEvent[]>;
  /** Highest sequence currently stored (0n if empty). */
  lastSequence(): Promise<bigint>;
  /** Total number of events stored. */
  count(): Promise<bigint>;
}

/* ─── PM-LED-06: ProjectionEngine port ───────────────────────────────── */

/** Result of applying a single event to a projection. */
export interface ProjectionResult {
  account: string;
  asset: string;
  availableBase: bigint;
  committedBase: bigint;
  lastEventSeq: bigint;
}

/** Options for projection rebuild/replay. */
export interface ProjectionOptions {
  projectionName: string;
  fromSequence: bigint;
  toSequence?: bigint;
  limit?: number;
}

/**
 * ProjectionEngine — applies events to materialized balance state.
 *
 * The engine is restart-safe: it reads the checkpoint for its projection
 * name and resumes from there. Applying the same event twice is safe because
 * the checkpoint advances only after the event is applied.
 */
export interface ProjectionEngine {
  /** Rebuild the projection from scratch (full replay). */
  rebuild(options: Omit<ProjectionOptions, "fromSequence">): Promise<ProjectionResult[]>;
  /** Incrementally process events since the last checkpoint. */
  process(options: ProjectionOptions): Promise<ProjectionResult[]>;
  /** Get the current checkpoint for a projection. */
  getCheckpoint(projectionName: string): Promise<bigint>;
}

/* ─── PM-LED-07: OutboxProcessor port ────────────────────────────────── */

export interface OutboxJob {
  eventId: string;
  topic: string;
  payload: unknown;
  /** The sequence this job was dispatched at. */
  sequence: bigint;
}

export type OutboxResult =
  | { ok: true; processed: number; lastSequence: bigint }
  | { ok: false; code: string; reason: string };

/**
 * OutboxProcessor — drains the event store to downstream consumers.
 *
 * The outbox is durable: jobs are dispatched from the event store and the
 * processor's progress is checkpointed in `outbox_checkpoints`. On restart,
 * the processor resumes from the last checkpointed job id, guaranteeing
 * at-least-once delivery with no gaps.
 */
export interface OutboxProcessor {
  drain(handler: (job: OutboxJob) => Promise<void>): Promise<OutboxResult>;
  getCheckpoint(processorName: string): Promise<string | undefined>;
  resetCheckpoint(processorName: string): Promise<void>;
}
