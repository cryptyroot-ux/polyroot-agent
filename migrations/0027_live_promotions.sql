-- Migration 0027: owner-signed LIVE promotions (append-only, revokable).
-- A promotion moves capital authority from one cap to a higher cap for one
-- strategy/profile. Rows are never updated except revoked_at (owner abort).
-- Admission verifies: signature recovers to the owner address, unexpired,
-- unrevoked, plus policy gates at read time (evaluateLivePromotion).

CREATE TABLE IF NOT EXISTS live_promotions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy        TEXT NOT NULL,
  profile         TEXT NOT NULL,
  from_cap_usd    DOUBLE PRECISION NOT NULL CHECK (from_cap_usd >= 0),
  to_cap_usd      DOUBLE PRECISION NOT NULL CHECK (to_cap_usd > from_cap_usd),
  expires_at      TIMESTAMPTZ NOT NULL,
  owner_address   TEXT NOT NULL,
  signature       TEXT NOT NULL,
  monitoring_json JSONB NOT NULL DEFAULT '{"systemHealth": true, "venueMode": true, "accountMode": true}',
  rollback_json   JSONB NOT NULL DEFAULT '{"triggers": ["drawdown-latch", "kill-switch", "mandate-expiry"], "steps": ["reduce", "flatten"]}',
  created_by      TEXT NOT NULL DEFAULT 'cli',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_live_promotions_lookup
  ON live_promotions (strategy, profile, revoked_at, expires_at DESC);
