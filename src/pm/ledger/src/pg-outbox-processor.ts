/**
 * @polyroot/ledger — PostgreSQL-backed OutboxProcessor (PM-LED-07).
 *
 * The outbox is the event store itself: every event appended to `kernel_events`
 * is a durable job. The processor reads events after its checkpointed sequence,
 * dispatches them to the handler, and only then advances the checkpoint.
 *
 * Restart safety:
 *   - The checkpoint is advanced *after* the handler succeeds.
 *   - If the process dies mid-batch, the next run re-reads the same events.
 *   - The handler must therefore be idempotent (event id is the dedup key).
 *   - At-least-once delivery is guaranteed; never-once is not.
 *
 * The `outbox_checkpoints` table from migration 0005 stores the last
 * checkpointed job id per processor.
 */

import { Pool, type PoolConfig } from "pg";
import { type EventStore, type OutboxJob, type OutboxProcessor, type OutboxResult } from "./index.js";

export class PgOutboxProcessor implements OutboxProcessor {
  private readonly pool: Pool;
  private readonly eventStore: EventStore;

  constructor(config: PoolConfig | string | Pool, eventStore: EventStore) {
    this.pool = config instanceof Pool
      ? config
      : new Pool(typeof config === "string"
          ? { connectionString: config }
          : config);
    this.eventStore = eventStore;
  }

  async getCheckpoint(processorName: string): Promise<string | undefined> {
    const result = await this.pool.query(
      `SELECT last_job_id FROM outbox_checkpoints WHERE processor_name = $1`,
      [processorName],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].last_job_id ?? undefined;
  }

  async resetCheckpoint(processorName: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_checkpoints SET last_job_id = NULL, updated_at = now() WHERE processor_name = $1`,
      [processorName],
    );
  }

  async drain(handler: (job: OutboxJob) => Promise<void>): Promise<OutboxResult> {
    // Read the checkpointed sequence (last processed event id). The event store
    // assigns a monotonically increasing sequence to every event.
    const lastJobId = await this.getCheckpoint("ledger-outbox");
    const cursor = lastJobId
      ? await this.eventStore.replay({ fromSequence: 1n })
      : await this.eventStore.replay({ fromSequence: 1n });

    // We replay from the beginning and skip to the checkpoint. This is safe
    // because events are append-only and the checkpoint is the last fully
    // dispatched event id.
    const events = cursor;
    const start = lastJobId
      ? events.findIndex((e) => e.id === lastJobId)
      : -1;
    const batch = start >= 0 ? events.slice(start + 1) : events;

    let processed = 0;
    let lastSequence = 0n;
    for (const event of batch) {
      const seq = event.metadata?.["sequence"] as bigint | undefined;
      const sequence = seq ?? 0n;
      await handler({
        eventId: event.id,
        topic: event.type,
        payload: event.payload,
        sequence,
      });
      processed += 1;
      lastSequence = sequence;

      // Advance the checkpoint after each successful dispatch.
      await this.pool.query(
        `UPDATE outbox_checkpoints
         SET last_job_id = $2, updated_at = now()
         WHERE processor_name = $1`,
        ["ledger-outbox", event.id],
      );
    }

    return { ok: true, processed, lastSequence };
  }
}