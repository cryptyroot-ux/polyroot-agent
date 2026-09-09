/**
 * @polyroot/ledger — Event store, projections, outbox
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { LedgerEvent, LedgerEventType } from "@polyroot/domain";

/** Placeholder for EventStore — to be implemented */
export interface EventStore {
  append(event: LedgerEvent): Promise<void>;
  get(aggregateId: string, aggregateType: string): Promise<LedgerEvent[]>;
}

/** Placeholder for ProjectionEngine — to be implemented */
export interface ProjectionEngine {
  project(event: LedgerEvent): Promise<void>;
}

/** Placeholder for OutboxProcessor — to be implemented */
export interface OutboxProcessor {
  process(): Promise<void>;
}

/** Placeholder for LedgerRepository — to be implemented */
export interface LedgerRepository {
  getEvents(filter: unknown): Promise<LedgerEvent[]>;
}
