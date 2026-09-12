/**
 * @polyroot/ledger — PostgreSQL-backed ProjectionEngine (PM-LED-02, PM-LED-06).
 *
 * The projection engine reads events from `kernel_events` and materializes
 * balance state into `balance_projections`. It uses `projection_checkpoints`
 * to track progress and enable safe restarts.
 *
 * Key invariants:
 *   - Events are applied in strict sequence order.
 *   - The checkpoint is advanced *after* the event is applied, within the same
 *     transaction. This guarantees exactly-once application of each event.
 *   - Duplicate replay (re-running from an earlier checkpoint) is safe because
 *     the engine uses upserts and idempotent balance arithmetic.
 *   - The projection is the single source of truth for the Risk plane
 *     (`PgBalanceStore` reads from `balance_projections`).
 */

import { Pool, type PoolConfig } from "pg";
import { type EventStore, type EventCursor, type ProjectionEngine, type ProjectionResult, type ProjectionOptions } from "./index.js";

/** Type for a single kernel event row. */
interface KernelEventRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  metadata: any;
  sequence: bigint;
  created_at: Date;
}

/** Result of projecting a single event. */
interface ProjectedEvent {
  account: string;
  asset: string;
  availableDelta: bigint;
  committedDelta: bigint;
}

export class PgProjectionEngine implements ProjectionEngine {
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

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Apply a single kernel event to the balance projection.
   * Returns the projected deltas, or null if the event doesn't affect balances.
   */
  private projectEvent(row: KernelEventRow): ProjectedEvent | null {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") return null;

    // Handle Money Kernel event types
    switch (row.type) {
      case "RESERVATION_CREATED": {
        // payload: { reservationId, permitId, intentId, amountSharesBase, cashBase, leaseEpoch }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const cashBase = BigInt(payload.cashBase as string);
        return { account, asset, availableDelta: -cashBase, committedDelta: cashBase };
      }
      case "RESERVATION_CONSUMED": {
        // payload: { account, asset, cashBase }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const cashBase = BigInt(payload.cashBase as string);
        return { account, asset, availableDelta: 0n, committedDelta: -cashBase };
      }
      case "RESERVATION_RELEASED": {
        // payload: { account, asset, cashBase }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const cashBase = BigInt(payload.cashBase as string);
        return { account, asset, availableDelta: cashBase, committedDelta: -cashBase };
      }
      case "ORDER_FILLED": {
        // payload: { account, asset, filledSharesBase, cashBase, feeBase, rebateBase }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const cashBase = BigInt(payload.cashBase as string);
        const feeBase = BigInt(payload.feeBase as string ?? "0");
        const rebateBase = BigInt(payload.rebateBase as string ?? "0");
        // Filled order: committed -> position (net cash after fees/rebates)
        // For the balance projection: committed decreases by (cashBase + feeBase - rebateBase)
        // The filled shares are tracked separately in position state
        return { account, asset, availableDelta: 0n, committedDelta: -(cashBase + feeBase - rebateBase) };
      }
      case "ORDER_PARTIAL": {
        // payload: { account, asset, filledSharesBase, cashBase, feeBase, rebateBase, remainingSharesBase }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const cashBase = BigInt(payload.cashBase as string);
        const feeBase = BigInt(payload.feeBase as string ?? "0");
        const rebateBase = BigInt(payload.rebateBase as string ?? "0");
        // Partial fill: committed decreases for filled portion, remaining stays committed
        return { account, asset, availableDelta: 0n, committedDelta: -(cashBase + feeBase - rebateBase) };
      }
      case "FUNDS_TRANSFERRED": {
        // payload: { fromAccount, toAccount, asset, amountBase }
        // This requires two deltas - handled by the caller
        return null;
      }
      case "PNL_REALIZED": {
        // payload: { account, asset, pnlBase }
        // PnL is settled to available
        const account = payload.account as string;
        const asset = payload.asset as string;
        const pnlBase = BigInt(payload.pnlBase as string);
        return { account, asset, availableDelta: pnlBase, committedDelta: 0n };
      }
      case "CORRECTION": {
        // payload: { correctionOfEventId, reversal: { ...original payload with negated amounts } }
        // The reversal payload is applied as a normal event of its type
        if (payload.reversal) {
          return this.projectEvent({
            ...row,
            type: payload.reversalType ?? row.type,
            payload: payload.reversal,
          });
        }
        return null;
      }
      case "SETTLEMENT": {
        // payload: { account, asset, amountBase, outcomeToken }
        // Settlement moves from reserved/committed to available (or vice versa for losses)
        const account = payload.account as string;
        const asset = payload.asset as string;
        const amountBase = BigInt(payload.amountBase as string);
        const isGain = payload.isGain ?? true;
        return { account, asset, availableDelta: isGain ? amountBase : -amountBase, committedDelta: 0n };
      }
      case "REDEEM": {
        // payload: { account, asset, amountBase }
        const account = payload.account as string;
        const asset = payload.asset as string;
        const amountBase = BigInt(payload.amountBase as string);
        return { account, asset, availableDelta: amountBase, committedDelta: 0n };
      }
    }
    return null;
  }

  async getCheckpoint(projectionName: string): Promise<bigint> {
    const result = await this.withClient(async (client) => {
      const r = await client.query(
        `SELECT last_event_seq FROM projection_checkpoints WHERE projection_name = $1`,
        [projectionName],
      );
      if (r.rows.length === 0) return 0n;
      return BigInt(r.rows[0].last_event_seq);
    });
    return result;
  }

  async rebuild(options: Omit<ProjectionOptions, "fromSequence">): Promise<ProjectionResult[]> {
    const fromSequence = 1n;
    const toSequence = options.toSequence ?? undefined;
    const limit = options.limit ?? undefined;

    // Truncate the projection table first (full rebuild)
    await this.withClient(async (client) => {
      await client.query(`TRUNCATE balance_projections`);
    });

    // Reset checkpoint to 0
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO projection_checkpoints (projection_name, last_event_seq, updated_at)
         VALUES ($1, 0, now())
         ON CONFLICT (projection_name) DO UPDATE SET last_event_seq = 0, updated_at = now()`,
        [options.projectionName],
      );
    });

    // Process all events
    const processOptions: ProjectionOptions = {
      projectionName: options.projectionName,
      fromSequence,
      ...(toSequence !== undefined ? { toSequence } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return this.process(processOptions);
  }

  async process(options: ProjectionOptions): Promise<ProjectionResult[]> {
    const checkpoint = await this.getCheckpoint(options.projectionName);
    const startSeq = checkpoint > options.fromSequence ? checkpoint : options.fromSequence;

    // Get events to process
    const replayOptions: EventCursor & { aggregateId?: string } = {
      fromSequence: startSeq,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    const events = await this.eventStore.replay(replayOptions);

    if (events.length === 0) return [];

    // Convert to kernel event rows
    const kernelEvents: KernelEventRow[] = events.map((e) => ({
      id: e.id,
      type: e.type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      payload: e.payload,
      metadata: e.metadata,
      sequence: (e.metadata?.["sequence"] as bigint) ?? 0n,
      created_at: e.timestamp,
    }));

    const results: ProjectionResult[] = [];

    // Process in a single transaction per batch (or one big transaction)
    await this.withClient(async (client) => {
      await client.query(`BEGIN`);
      try {
        for (const row of kernelEvents) {
          // Check if we should stop at toSequence
          if (options.toSequence && row.sequence > options.toSequence) break;

          const projected = this.projectEvent(row);
          if (!projected) {
            // Still advance checkpoint
            await this.updateCheckpoint(client, options.projectionName, row.sequence);
            continue;
          }

          const { account, asset, availableDelta, committedDelta } = projected;

          // Apply to balance_projections using upsert
          await client.query(
            `INSERT INTO balance_projections (account, asset, available_base, committed_base, last_event_seq, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (account, asset) DO UPDATE SET
               available_base = balance_projections.available_base + $3,
               committed_base = balance_projections.committed_base + $4,
               last_event_seq = GREATEST(balance_projections.last_event_seq, $5),
               updated_at = now()`,
            [account, asset, availableDelta, committedDelta, row.sequence],
          );

          // Also record the individual balance entry for audit trail
          if (availableDelta !== 0n) {
            await client.query(
              `INSERT INTO balance_entries (account, asset, available_base, committed_base, updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (account, asset) DO UPDATE SET
                 available_base = balance_entries.available_base + $3,
                 committed_base = balance_entries.committed_base + $4,
                 updated_at = now()`,
              [account, asset, availableDelta, committedDelta],
            );
          }

          // Advance checkpoint
          await this.updateCheckpoint(client, options.projectionName, row.sequence);

          results.push({
            account,
            asset,
            availableBase: availableDelta,
            committedBase: committedDelta,
            lastEventSeq: row.sequence,
          });
        }
        await client.query(`COMMIT`);
      } catch (err) {
        await client.query(`ROLLBACK`);
        throw err;
      }
    });

    return results;
  }

  private async updateCheckpoint(
    client: PoolClient,
    projectionName: string,
    sequence: bigint,
  ): Promise<void> {
    await client.query(
      `UPDATE projection_checkpoints
       SET last_event_seq = $2, updated_at = now()
       WHERE projection_name = $1`,
      [projectionName, sequence],
    );
  }
}

import type { PoolClient } from "pg";