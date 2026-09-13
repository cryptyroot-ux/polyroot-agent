-- Migration 0007: Permit→order durable binding (PR-EXE-02, PR-OPS-02)
-- The single-use claim must be bound to the exact order that consumes it.
-- Without this column a permit could be claimed once for order A and then
-- reused for order B (the used_at flag alone only says "claimed", not "by
-- whom"). The claim is now atomic and order-specific.
-- Created: 2026-09-13

ALTER TABLE execution_permits
    ADD COLUMN IF NOT EXISTS claimed_order_id UUID;

-- Atomic, order-specific single-use claim. Only the first matching UPDATE
-- wins; concurrent claims for the same permit (any order) are serialized by
-- the row lock and exactly one succeeds.
CREATE OR REPLACE FUNCTION claim_permit(
    p_permit_id UUID,
    p_order_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    UPDATE execution_permits
       SET used_at = now(),
           claimed_order_id = p_order_id
     WHERE permit_id = p_permit_id
       AND used_at IS NULL
       AND expires_at > now();
    RETURN FOUND;
END $$;

-- One active lease epoch holder per wallet at a time (PR-OPS-02).
-- Acquired atomically; a stale holder can never fence itself.
CREATE OR REPLACE FUNCTION acquire_executor_lease(
    p_wallet_id UUID,
    p_holder TEXT,
    p_lease_epoch BIGINT,
    p_ttl_seconds INTEGER
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO executor_leases (wallet_id, lease_epoch, holder, expires_at)
    VALUES (p_wallet_id, p_lease_epoch, p_holder, now() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (wallet_id) DO UPDATE
      SET lease_epoch = EXCLUDED.lease_epoch,
          holder     = EXCLUDED.holder,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
    WHERE executor_leases.lease_epoch < EXCLUDED.lease_epoch
       OR executor_leases.expires_at < now();
    RETURN FOUND;
END $$;

-- Release a lease only if the caller is the current holder (prevents a
-- malicious/buggy worker from stealing another holder's epoch).
CREATE OR REPLACE FUNCTION release_executor_lease(
    p_wallet_id UUID,
    p_holder TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM executor_leases
     WHERE wallet_id = p_wallet_id
       AND holder = p_holder;
    RETURN FOUND;
END $$;
