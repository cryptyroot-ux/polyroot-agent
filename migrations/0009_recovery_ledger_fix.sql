-- Migration 0009 — enforcement of R10 fixes:
-- Remove CANCEL_CERTAIN from recovery_ledger state and resolved_state to eliminate misclassification of timeouts and ACKs.
-- This migration adds no functional changes but documents the new constraints.

-- Note: The CHECK constraint on resolved_state already only allows ACKNOWLEDGED/DEFINITIVE_REJECT.
-- This migration does not modify the SQL schema because the existing CHECK constraints already enforce the desired behavior.
-- The fix is in the application code (PgRecoveryLedger.resolve, InternalRecoveryLedger.resolve) which now never sets CANCEL_CERTAIN.

-- If a schema-only migration is still desired to drop the CANCEL_CERTAIN option from resolved_state enum,
-- we must alter the ENUM, which PostgreSQL does not support easily. Instead we rely on application code enforcement.

-- No direct schema changes in this migration.
