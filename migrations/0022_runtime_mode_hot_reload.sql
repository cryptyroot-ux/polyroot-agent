-- Migration 0022: Add runtime_mode and mode_updated_at to live_guard_state for hot-reload
ALTER TABLE live_guard_state
  ADD COLUMN IF NOT EXISTS runtime_mode TEXT NOT NULL DEFAULT 'PAPER',
  ADD COLUMN IF NOT EXISTS mode_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE live_guard_state
  SET runtime_mode = 'PAPER', mode_updated_at = now()
  WHERE key = 'micro-live' AND (runtime_mode IS NULL OR runtime_mode = '');