CREATE TABLE IF NOT EXISTS catalyst_outbox (
  event_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key)
);

CREATE TABLE IF NOT EXISTS catalyst_watermarks (
  consumer TEXT PRIMARY KEY,
  last_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalyst_outbox_dedupe ON catalyst_outbox (dedupe_key);