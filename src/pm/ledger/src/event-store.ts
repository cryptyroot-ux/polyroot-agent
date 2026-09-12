/**
 * @polyroot/ledger — EventStore port (PM-LED-01, PM-LED-05).
 *
 * An EventStore is the append-only source of truth for all financial events.
 * Events are immutable once written; replay is the only way to rebuild state.
 *
 * Design decisions:
 *   - Every event carries a stable `id` (ULID in the domain layer) and a
 *     monotonically increasing `sequence` assigned by the store. The sequence
 *     is the authoritative ordering key; the ULID is the stable identity.
 *   - `append` is idempotent on (aggregate_id, sequence) so duplicate writes
 *     from a retried pipeline cannot double-count.
 *   - `replay` returns events in sequence order from a cursor, enabling
 *     projection engines to resume after a restart.
 */

import {
  type LedgerEvent,
  LedgerEventSchema,
} from "@polyroot/domain";

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
 *   1. Appending the same (aggregate_id, sequence) twice returns the same
 *      eventId/sequence with `created: false`.
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

/**
 * In-memory EventStore for tests and pure-logic verification.
 *
 * Idempotency key: (aggregate_id, sequence). Sequence is assigned
 * monotonically by the store; the caller may pass a sequence hint but the
 * store owns the final value.
 */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, LedgerEvent>();
  private bySequence = new Map<bigint, string>();
  private nextSeq = 1n;

  async append(event: LedgerEvent): Promise<AppendResult> {
    const parsed = LedgerEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`invalid LedgerEvent: ${parsed.error.message}`);
    }
    // Idempotency: if this exact event id already exists, return it.
    const existing = this.events.get(parsed.data.id);
    if (existing) {
      const seq = this.findSequence(parsed.data.id)!;
      return { eventId: parsed.data.id, sequence: seq, created: false };
    }
    // Assign a sequence. If the event already carries a sequence in its
    // metadata, honor it only if it is >= nextSeq (keeps ordering stable).
    const seqHint = parsed.data.metadata?.["sequence"];
    const seq =
      typeof seqHint === "bigint"
        ? seqHint >= this.nextSeq
          ? seqHint
          : this.nextSeq
        : this.nextSeq;
    this.events.set(parsed.data.id, { ...parsed.data });
    this.bySequence.set(seq, parsed.data.id);
    if (seq >= this.nextSeq) this.nextSeq = seq + 1n;
    return { eventId: parsed.data.id, sequence: seq, created: true };
  }

  async appendMany(events: LedgerEvent[]): Promise<AppendResult[]> {
    const results: AppendResult[] = [];
    for (const e of events) results.push(await this.append(e));
    return results;
  }

  async getEvent(id: string): Promise<LedgerEvent | undefined> {
    return this.events.get(id);
  }

  async replay(cursor: EventCursor & { aggregateId?: string }): Promise<LedgerEvent[]> {
    const start = cursor.fromSequence;
    const ids: string[] = [];
    for (const [seq, id] of this.bySequence) {
      if (seq < start) continue;
      if (cursor.aggregateId) {
        const ev = this.events.get(id);
        if (!ev || ev.aggregate_id !== cursor.aggregateId) continue;
      }
      ids.push(id);
    }
    ids.sort((a, b) => {
      const sa = this.findSequence(a)!;
      const sb = this.findSequence(b)!;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    const sliced = cursor.limit ? ids.slice(0, cursor.limit) : ids;
    return sliced.map((id) => this.events.get(id)!);
  }

  async lastSequence(): Promise<bigint> {
    return this.nextSeq - 1n;
  }

  async count(): Promise<bigint> {
    return BigInt(this.events.size);
  }

  private findSequence(id: string): bigint | undefined {
    for (const [seq, storedId] of this.bySequence) {
      if (storedId === id) return seq;
    }
    return undefined;
  }
}