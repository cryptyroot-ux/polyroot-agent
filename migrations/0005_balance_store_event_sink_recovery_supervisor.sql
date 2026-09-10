-- Migration 0005: Balance Store, Event Sink, Recovery Ledger, Supervisor State
-- PRD v1.1: Money Kernel (PR-RISK-01..08), Ledger (PR-LED-01..08),
--           Supervisor/Recovery (PR-OPS-01..04), Reconciliation (PR-EXE-06)
-- Created: 2026-09-10

-- ─── Balance Store: exact integer base-unit balances (PR-RISK-01, PR-LED-02) ───
-- The single source of truth for available/committed balances per account/asset.
-- All amounts in integer base units (bigint). No float arithmetic ever.

CREATE TABLE IF NOT EXISTS balance_entries (
    account         TEXT NOT NULL,
    asset           TEXT NOT NULL,
    available_base  NUMERIC(38,0) NOT NULL DEFAULT 0,
    committed_base  NUMERIC(38,0) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account, asset)
);

CREATE INDEX IF NOT EXISTS idx_balance_entries_asset
    ON balance_entries (asset);

-- ─── Kernel Event Sink: append-only financial event log (PR-LED-01, PR-RISK-01) ───
-- Every financial state change writes exactly one event here.
-- Source of truth for projections, audit, and reconciliation.

CREATE SEQUENCE IF NOT EXISTS kernel_events_seq;

CREATE TABLE IF NOT EXISTS kernel_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic           TEXT NOT NULL,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    UUID NOT NULL,
    payload         JSONB NOT NULL,
    metadata        JSONB,
    sequence        BIGINT NOT NULL DEFAULT nextval('kernel_events_seq'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kernel_events_aggregate
    ON kernel_events (aggregate_type, aggregate_id);

CREATE INDEX IF NOT EXISTS idx_kernel_events_sequence
    ON kernel_events (sequence);

CREATE INDEX IF NOT EXISTS idx_kernel_events_created
    ON kernel_events (created_at DESC);

-- ─── Recovery Ledger: tracks orders with unknown venue outcome (PR-EXE-04/06) ───
-- Single source of truth for reconciliation. Never blind-retry.
-- State machine: NOT_SEEN -> SUBMITTING -> ACKNOWLEDGED | SUBMISSION_UNKNOWN -> DEFINITIVE_REJECT

CREATE TABLE IF NOT EXISTS recovery_ledger (
    order_id            UUID PRIMARY KEY REFERENCES orders(id),
    venue_order_id      TEXT,
    permit_id           UUID REFERENCES execution_permits(permit_id),
    state               TEXT NOT NULL DEFAULT 'NOT_SEEN' CHECK (state IN ('NOT_SEEN', 'SUBMITTING', 'ACKNOWLEDGED', 'SUBMISSION_UNKNOWN', 'DEFINITIVE_REJECT')),
    submitted_at        TIMESTAMPTZ,
    acknowledged_at     TIMESTAMPTZ,
    last_reconcile_at   TIMESTAMPTZ,
    reconcile_count     INTEGER NOT NULL DEFAULT 0,
    resolved            BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at         TIMESTAMPTZ,
    resolved_state      TEXT CHECK (resolved_state IN ('ACKNOWLEDGED', 'DEFINITIVE_REJECT')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_state
    ON recovery_ledger (state) WHERE state IN ('SUBMITTING', 'SUBMISSION_UNKNOWN');

CREATE INDEX IF NOT EXISTS idx_recovery_permit
    ON recovery_ledger (permit_id);

-- ─── Supervisor State: health counters + unknown-order queue (PR-OPS-01/02) ───
-- Persists supervisor health counters and unknown-order tracking across restarts.

CREATE TABLE IF NOT EXISTS supervisor_state (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_order_count       BIGINT NOT NULL DEFAULT 0,
    unknown_order_count     BIGINT NOT NULL DEFAULT 0,
    unresolved_intent_count BIGINT NOT NULL DEFAULT 0,
    last_health_check       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reconcile_run      TIMESTAMPTZ,
    last_reconcile_count    BIGINT NOT NULL DEFAULT 0,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure exactly one row (singleton pattern)
INSERT INTO supervisor_state (id, total_order_count, unknown_order_count, unresolved_intent_count)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ─── Balance Projections: materialized views for Risk Engine (PR-LED-02) ───
-- Updated by projection engine from kernel_events.

CREATE TABLE IF NOT EXISTS balance_projections (
    account         TEXT NOT NULL,
    asset           TEXT NOT NULL,
    available_base  NUMERIC(38,0) NOT NULL DEFAULT 0,
    committed_base  NUMERIC(38,0) NOT NULL DEFAULT 0,
    last_event_seq  BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account, asset)
);

-- ─── Projection Engine checkpoint (PR-LED-03) ───
-- Tracks how far the projection engine has processed kernel_events.

CREATE TABLE IF NOT EXISTS projection_checkpoints (
    projection_name   TEXT PRIMARY KEY,
    last_event_seq    BIGINT NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO projection_checkpoints (projection_name, last_event_seq)
VALUES ('balance_projections', 0)
ON CONFLICT (projection_name) DO NOTHING;

-- ─── Outbox Processor checkpoint (Blueprint B4) ───
CREATE TABLE IF NOT EXISTS outbox_checkpoints (
    processor_name    TEXT PRIMARY KEY,
    last_job_id       UUID,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Helper: atomic balance commit function (PR-RISK-01, PR-LED-02) ───
-- Used by MoneyKernel to atomically move funds between available/committed.
-- Returns TRUE on success, FALSE if insufficient available balance.

CREATE OR REPLACE FUNCTION balance_commit(
    p_account TEXT,
    p_asset TEXT,
    p_delta_base NUMERIC(38,0)
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_available NUMERIC(38,0);
    v_committed NUMERIC(38,0);
    v_new_available NUMERIC(38,0);
    v_new_committed NUMERIC(38,0);
BEGIN
    LOOP
        SELECT available_base, committed_base
        INTO v_available, v_committed
        FROM balance_entries
        WHERE account = p_account AND asset = p_asset
        FOR UPDATE;

        IF NOT FOUND THEN
            INSERT INTO balance_entries (account, asset, available_base, committed_base, updated_at)
            VALUES (p_account, p_asset, 0, 0, now())
            ON CONFLICT (account, asset) DO NOTHING;
            CONTINUE;
        END IF;

        IF p_delta_base < 0 THEN
            v_new_committed := v_committed + p_delta_base;
            IF v_new_committed < 0 THEN
                RETURN FALSE;
            END IF;
            v_new_available := v_available - p_delta_base;
        ELSE
            IF v_available < p_delta_base THEN
                RETURN FALSE;
            END IF;
            v_new_available := v_available - p_delta_base;
            v_new_committed := v_committed + p_delta_base;
        END IF;

        UPDATE balance_entries
        SET available_base = v_new_available,
            committed_base = v_new_committed,
            updated_at = now()
        WHERE account = p_account AND asset = p_asset;

        RETURN TRUE;
    END LOOP;
END $$;

-- ─── Helper: append kernel event (PR-LED-01) ───
CREATE OR REPLACE FUNCTION kernel_event_append(
    p_topic TEXT,
    p_aggregate_type TEXT,
    p_aggregate_id UUID,
    p_payload JSONB,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO kernel_events (topic, aggregate_type, aggregate_id, payload, metadata, created_at)
    VALUES (p_topic, p_aggregate_type, p_aggregate_id, p_payload, p_metadata, now())
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- ─── Grant permissions (adjust roles as needed) ───
-- GRANT SELECT, INSERT, UPDATE ON balance_entries, kernel_events, recovery_ledger, supervisor_state,
--     balance_projections, projection_checkpoints, outbox_checkpoints
-- TO polyroot_app;

-- COMMENT ON TABLE balance_entries IS 'Single source of truth for account/asset balances (base units).';
-- COMMENT ON TABLE kernel_events IS 'Append-only financial event log -- source of truth for projections and audit.';
-- COMMENT ON TABLE recovery_ledger IS 'Tracks orders with unknown venue outcome -- no blind retry.';
-- COMMENT ON TABLE supervisor_state IS 'Singleton supervisor health counters persisted across restarts.';
-- COMMENT ON TABLE balance_projections IS 'Materialized view for Risk Engine -- rebuilt from kernel_events.';