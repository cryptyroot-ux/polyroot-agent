-- Migration 0020: SHADOW G5 Infrastructure
-- Adds SHADOW decision log and resolved cluster tracking for G5 gate
-- Created: 2026-09-22

-- ─── SHADOW decision log (G5): every SHADOW-mode decision ───────────────
-- Mirrors paper_log but for SHADOW mode (live data, no financial I/O)
CREATE TABLE IF NOT EXISTS shadow_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'NO_TRADE', 'ABSTAIN')),
    forecast_p      NUMERIC(10,8),
    size            NUMERIC(18,8) NOT NULL DEFAULT 0,
    -- No fill simulation in SHADOW; these are always NULL/default
    fill_status     TEXT NOT NULL DEFAULT 'NONE' CHECK (fill_status IN ('NONE')),
    filled_size     NUMERIC(18,8) NOT NULL DEFAULT 0,
    fill_price      NUMERIC(10,8),
    maker_fee       NUMERIC(18,8) NOT NULL DEFAULT 0,
    taker_fee       NUMERIC(18,8) NOT NULL DEFAULT 0,
    pnl_latency_ms  INTEGER NOT NULL DEFAULT 0,
    uncertainty     NUMERIC(5,4) NOT NULL DEFAULT 0,
    experiment_id   UUID,
    loop_epoch      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_log_market_time
    ON shadow_log (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shadow_log_experiment
    ON shadow_log (experiment_id);

-- ─── Resolved cluster tracking (G5: 100 independent resolved clusters) ──
-- Tracks resolved independent event clusters for G5 gate
CREATE TABLE IF NOT EXISTS resolved_clusters (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id          TEXT NOT NULL,        -- Independent cluster identifier
    event_id            TEXT NOT NULL,        -- Polymarket event ID
    market_ids          TEXT[] NOT NULL,      -- All market IDs in this cluster
    resolution_outcome  TEXT NOT NULL,        -- Which market resolved YES
    resolved_at         TIMESTAMPTZ NOT NULL,
    is_independent      BOOLEAN NOT NULL DEFAULT TRUE,  -- Independent cluster flag
    cluster_hash        TEXT NOT NULL,        -- Hash for deduplication
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_hash)
);

CREATE INDEX IF NOT EXISTS idx_resolved_clusters_resolved_at
    ON resolved_clusters (resolved_at DESC);

CREATE INDEX IF NOT EXISTS idx_resolved_clusters_hash
    ON resolved_clusters (cluster_hash);

-- ─── SHADOW baseline enhancement: track preregistered versions ───────────
-- Already in migration 0006, just ensuring the table has all needed columns
ALTER TABLE shadow_baseline
    ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS gate_evaluated_at TIMESTAMPTZ;

-- ─── SHADOW gate evaluation log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shadow_gate_evaluations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    observed_days       NUMERIC(10,2) NOT NULL,
    resolved_clusters   INTEGER NOT NULL,
    gate_passed         BOOLEAN NOT NULL,
    snapshot            JSONB NOT NULL,  -- Full snapshot at evaluation
    account             TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX IF NOT EXISTS idx_shadow_gate_evaluations_account_time
    ON shadow_gate_evaluations (account, evaluated_at DESC);

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- GRANT ALL ON shadow_log, resolved_clusters, shadow_gate_evaluations TO polyroot;