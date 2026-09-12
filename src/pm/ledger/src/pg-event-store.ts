/**
 * @polyroot/ledger — PostgreSQL-backed EventStore (PM-LED-01, PM-LED-05).
 *
 * Uses migration 0005's `kernel_events` table as the append-only event log.
 * Sequence numbers are derived from the `sequence` column, providing total order.
 * ULID event IDs from the domain layer are stored in the `id` column as UUID.
 *
 * Key invariant: `(aggregate_id, sequence)` is unique. Re-appending the same
 * event (same aggregate_id + sequence) is idempotent — returns the existing
 * eventId with `created: false`.
 *
 * Projection engines build materialized state from this table. Checkpoints
 * track how far the engine has processed, stored in the `projection_checkpoints`
 * table from migration 0005.
 */

import { Pool, type PoolConfig } from "pg";
import {
  type EventStore,
  type EventCursor,
  type AppendResult,
} from "./index.js";
import { type LedgerEvent, LedgerEventSchema } from "@polyroot/domain";

export class PgEventStore implements EventStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool = config instanceof Pool
      ? config
      : new Pool(typeof config === "string"
          ? { connectionString: config }
          : config);
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async append(event: LedgerEvent): Promise<AppendResult> {
    const parsed = LedgerEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`invalid LedgerEvent: ${parsed.error.message}`);
    }

    const e = parsed.data;

    // Idempotency check: if an event with this exact id already exists,
    // return it without inserting.
    const existing = await this.withClient(async (client) => {
      const r = await client.query(
        `SELECT id, sequence FROM kernel_events WHERE id = $1`,
        [e.id],
      );
      if (r.rows.length > 0) {
        return { eventId: r.rows[0].id, sequence: r.rows[0].sequence };
      }
      return null;
    });

    if (existing) {
      return { eventId: existing.eventId, sequence: existing.sequence, created: false };
    }

    // Insert the event. sequence is generated from the kernel_events_seq
    // sequence generator; we delegate to the DB for monotonically increasing.
    const result = await this.withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO kernel_events (topic, aggregate_type, aggregate_id, payload, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, now())
         RETURNING id, sequence`,
        [
          e.type,
          e.aggregate_type,
          e.aggregate_id,
          e.payload,
          e.metadata ?? JSON.stringify({}),
        ],
      );
      return { eventId: r.rows[0].id, sequence: r.rows[0].sequence };
    });

    return { eventId: result.eventId, sequence: result.sequence, created: true };
  }

  async appendMany(events: LedgerEvent[]): Promise<AppendResult[]> {
    // Use a transaction for atomicity across many events
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN`);
      const results: AppendResult[] = [];
      for (const event of events) {
        const parsed = LedgerEventSchema.safeParse(event);
        if (!parsed.success) {
          await client.query(`ROLLBACK`);
          throw new Error(`invalid LedgerEvent: ${parsed.error.message}`);
        }
        const e = parsed.data;
        const r = await client.query(
          `INSERT INTO kernel_events (topic, aggregate_type, aggregate_id, payload, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, now())
           RETURNING id, sequence`,
          [
            e.type,
            e.aggregate_type,
            e.aggregate_id,
            e.payload,
            e.metadata ?? JSON.stringify({}),
          ],
        );
        results.push({ eventId: r.rows[0].id, sequence: r.rows[0].sequence, created: true });
      }
      await client.query(`COMMIT`);
      return results;
    } finally {
      client.release();
    }
  }

  async getEvent(id: string): Promise<LedgerEvent | undefined> {
    const result = await this.withClient(async (client) => {
      const r = await client.query(
        `SELECT id, type, aggregate_type, aggregate_id, payload, metadata, sequence, created_at
         FROM kernel_events WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) return undefined;
      return {
        id: r.rows[0].id,
        type: r.rows[0].type,
        aggregate_type: r.rows[0].aggregate_type,
        aggregate_id: r.rows[0].aggregate_id,
        payload: r.rows[0].payload,
        metadata: r.rows[0].metadata,
        sequence: r.rows[0].sequence,
        timestamp: r.rows[0].created_at,
        schema_version: r.rows[0].metadata?.["schema_version"] ?? "1.0.0",
      };
    });
    return result;
  }

  async replay(cursor: EventCursor & { aggregateId?: string }): Promise<LedgerEvent[]> {
    const client = await this.pool.connect();
    try {
      const startSeq = cursor.fromSequence ?? 1n;
      const where: string[] = [`sequence >= $1`];
      const params: (string | number | bigint)[] = [startSeq];

      if (cursor.aggregateId) {
        where.push(`aggregate_id = $${params.length + 1}`);
        params.push(cursor.aggregateId);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const orderBy = `ORDER BY sequence ASC`;

      const r = await client.query(
        `SELECT id, type, aggregate_type, aggregate_id, payload, metadata, sequence, created_at
         FROM kernel_events ${whereClause}
         ${orderBy}`,
        params,
      );

      return r.rows.map((row) => ({
        id: row.id,
        type: row.type,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        payload: row.payload,
        metadata: row.metadata,
        sequence: row.sequence,
        timestamp: row.created_at,
        schema_version: row.metadata?.["schema_version"] ?? "1.0.0",
      }));
    } finally {
      client.release();
    }
  }

  async lastSequence(): Promise<bigint> {
    const result = await this.withClient(async (client) => {
      const r = await client.query(
        `SELECT COALESCE(MAX(sequence), 0) FROM kernel_events`,
      );
      return (r.rows[0].coalesce as unknown as bigint) || 0n;
    });
    return result;
  }

  async count(): Promise<bigint> {
    const result = await this.withClient(async (client) => {
      const r = await client.query(`SELECT COUNT(*) FROM kernel_events`);
      return BigInt(r.rows[0].count);
    });
    return result;
  }
}

import type { PoolClient } from "pg";