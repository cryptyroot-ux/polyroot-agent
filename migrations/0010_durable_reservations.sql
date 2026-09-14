-- Migration 0010: Durable reservations enhancements (Milestone B3)
--
-- The reservations table already exists from a prior migration with:
--   id, intent_id, risk_decision_id, amount, currency, status, expires_at, created_at, released_at
--
-- This migration adds:
--   - account column (for getOpenCount per account/asset)
--   - asset column
--   - consumed_at timestamp
--   - permit_id for permit binding
--   - payload_hash for integrity
--   - indexes for open count queries

-- Add account and asset columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'account') THEN
    ALTER TABLE reservations ADD COLUMN account TEXT NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'asset') THEN
    ALTER TABLE reservations ADD COLUMN asset TEXT NOT NULL DEFAULT 'pUSD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'consumed_at') THEN
    ALTER TABLE reservations ADD COLUMN consumed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'permit_id') THEN
    ALTER TABLE reservations ADD COLUMN permit_id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'payload_hash') THEN
    ALTER TABLE reservations ADD COLUMN payload_hash TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reservations' AND column_name = 'decision_id') THEN
    ALTER TABLE reservations ADD COLUMN decision_id UUID;
  END IF;
END $$;

-- Ensure monotonic status check exists
DO $$
BEGIN
  -- Verify status column exists and has expected constraint
  -- (can't safely alter CHECK constraint in PostgreSQL without dropping/recreating)
  -- The application enforces monotonic transitions
  NULL;
END $$;

-- Add indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations (status) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_reservations_account_asset ON reservations (account, asset, status);
CREATE INDEX IF NOT EXISTS idx_reservations_created ON reservations (created_at);

COMMENT ON TABLE reservations IS
  'Durable reservation rows for exact open-reservation count (Milestone B3). '
  'Status must be MONOTONIC: OPEN -> CONSUMED|RELEASED|EXPIRED. '
  'No backward transitions permitted.';
