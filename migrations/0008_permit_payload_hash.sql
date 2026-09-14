-- Migration 0008: Permit payload hash for integrity (PR-EXE-02, PR-OPS-02)
-- Store a hash of the permit data at time of claim to detect tampering.
-- The hash includes all permit fields including used_at (which is set at claim time).
-- This allows verification that a claimed permit has not been modified after claiming.
-- Created: 2026-09-14

ALTER TABLE execution_permits
    ADD COLUMN IF NOT EXISTS payload_hash TEXT;

-- Update existing rows to have a null payload_hash (they were issued before this column existed)
UPDATE execution_permits SET payload_hash = NULL WHERE payload_hash IS NULL;
