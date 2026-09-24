-- Migration 0015: Durable live-guard latch (MICRO_LIVE/LIVE loss halt)
-- The loss-cap latch MUST survive restarts: a breach stays engaged until an
-- explicit owner reset. Single row keyed 'micro-live'.

CREATE TABLE IF NOT EXISTS live_guard_state (
    key                 TEXT PRIMARY KEY,
    halted              BOOLEAN NOT NULL DEFAULT FALSE,
    halted_at           TIMESTAMPTZ,
    realized_loss_pusd  NUMERIC NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO live_guard_state (key) VALUES ('micro-live')
ON CONFLICT (key) DO NOTHING;
