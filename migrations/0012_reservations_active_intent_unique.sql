-- 0012: enforce duplicate-economic-intent guard at the DB layer.
--
-- A trade intent must map to AT MOST ONE active (unspent) reservation.
-- This is the authoritative concurrency-safe idempotency boundary for the
-- Money Authority: re-reserving the same intent must be a deterministic
-- DUPLICATE_INTENT rejection, never a second authorization.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_active_intent
    ON reservations (intent_id)
    WHERE status = 'ACTIVE' AND intent_id IS NOT NULL;