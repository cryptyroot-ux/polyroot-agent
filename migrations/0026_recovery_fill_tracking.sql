-- Migration 0026: per-order consumed-fill tracking on recovery_ledger.
-- A resting (LIVE) or partially filled (PARTIAL) order accrues fills across
-- polls. The reconciler consumes only the not-yet-consumed delta, so a fill
-- is never double-counted and a later cancel releases exactly the remainder
-- (reserved - consumed). Cumulative base-unit counters, TEXT like the
-- reservation amounts. Monotonic: writers only ever raise them.
-- P0: closes the partial-fill/reservation accounting lifecycle gap.

ALTER TABLE recovery_ledger
  ADD COLUMN IF NOT EXISTS consumed_fill_shares_base TEXT NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS consumed_fill_cash_base   TEXT NOT NULL DEFAULT '0';
