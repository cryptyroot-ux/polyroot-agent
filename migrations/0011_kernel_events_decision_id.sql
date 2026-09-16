-- Migration 0011: Add decision_id to kernel_events for audit traceability
-- Required by PgMoneyAuthority to correlate events with decisions.

ALTER TABLE kernel_events
    ADD COLUMN IF NOT EXISTS decision_id UUID;

CREATE INDEX IF NOT EXISTS idx_kernel_events_decision
    ON kernel_events (decision_id);
