-- 0013: Reservation lifecycle accounting + status vocabulary.
--
-- Fixes:
--   * P0-3 partial-fill accounting: reservations now track consumed_amount and
--     released_amount so a partial fill does not mark the whole reservation
--     CONSUMED.
--   * P0-4 expire is a distinct terminal state: EXPIRED (not RELEASED) with
--     expired_at timestamp.
--   * Reservation status vocabulary consistency: the partial index used a
--     legacy 'OPEN' status that never existed; align it with 'ACTIVE'.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS consumed_amount NUMERIC(18,8) NOT NULL DEFAULT 0;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS released_amount NUMERIC(18,8) NOT NULL DEFAULT 0;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

-- Extend the status check to include PARTIALLY_CONSUMED.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations
  ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('ACTIVE', 'PARTIALLY_CONSUMED', 'CONSUMED', 'RELEASED', 'EXPIRED'));

-- Align the partial index with the real active status.
DROP INDEX IF EXISTS idx_reservations_status;
CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations (status, expires_at)
  WHERE status = 'ACTIVE';

-- Invariant guard: consumed + released can never exceed the reserved amount.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_amount_conservation_check;
ALTER TABLE reservations
  ADD CONSTRAINT reservations_amount_conservation_check
  CHECK (consumed_amount + released_amount <= amount);