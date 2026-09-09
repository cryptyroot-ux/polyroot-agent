/**
 * @polyroot/ledger — Event store, projections, outbox
 *
 * Exports:
 * - EventStore: append-only event log
 * - ProjectionEngine: materialized views (positions, PnL, portfolio)
 * - OutboxProcessor: reliable event publishing
 * - LedgerRepository: query helpers
 */

export { EventStore } from "./stores/event";
export { ProjectionEngine } from "./projections/engine";
export { OutboxProcessor } from "./outbox/processor";
export { LedgerRepository } from "./repositories/ledger";
