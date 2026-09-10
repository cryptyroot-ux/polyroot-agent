-- Migration 0006: Paper/Shadow runtime + experiment tracking (G4-G6)
-- PR-VAL-04..08, G4 (PAPER), G5 (SHADOW), G6 (micro-LIVE harness)
-- Created: 2026-09-11

-- ─── Paper execution log (G4): every simulated decision, no financial I/O ───
CREATE TABLE IF NOT EXISTS paper_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'NO_TRADE', 'ABSTAIN')),
    forecast_p      NUMERIC(10,8),
    size            NUMERIC(18,8) NOT NULL DEFAULT 0,
    fill_status     TEXT NOT NULL DEFAULT 'CANCELLED' CHECK (fill_status IN ('FILLED', 'PARTIAL', 'CANCELLED')),
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

CREATE INDEX IF NOT EXISTS idx_paper_log_market_time
    ON paper_log (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_log_experiment
    ON paper_log (experiment_id);

-- ─── Experiment registry (append-only; PR-VAL-08, no cherry-picking) ───────
CREATE TABLE IF NOT EXISTS experiments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    version             TEXT NOT NULL,
    description         TEXT,
    preregistered_rule  TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PREREGISTERED'
                        CHECK (status IN ('PREREGISTERED', 'RUNNING', 'CONCLUDED', 'WITHDRAWN')),
    mode                TEXT NOT NULL CHECK (mode IN ('PAPER', 'SHADOW', 'MICRO_LIVE')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    concluded_at        TIMESTAMPTZ
);

-- ─── Experiment result (metrics snapshot at conclusion) ─────────────────────
CREATE TABLE IF NOT EXISTS experiment_results (
    experiment_id       UUID PRIMARY KEY REFERENCES experiments(id),
    brier               NUMERIC(10,8),
    log_loss            NUMERIC(10,8),
    calibration_error   NUMERIC(10,8),
    sharpness           NUMERIC(10,8),
    coverage            NUMERIC(10,8),
    abstention_rate     NUMERIC(10,8),
    n                   INTEGER NOT NULL DEFAULT 0,
    net_pnl             NUMERIC(18,8),
    max_drawdown_pct    NUMERIC(10,8),
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── SHADOW prospective baseline tracker (G5) ───────────────────────────────
-- Tracks calendar days observed + resolved independent event clusters.
-- The G5 gate is NOT_RUN until observed_days >= 30 and resolved_clusters >= 100.
CREATE TABLE IF NOT EXISTS shadow_baseline (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account             TEXT NOT NULL DEFAULT 'default',
    observed_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    observed_days       NUMERIC(10,2) NOT NULL DEFAULT 0,
    resolved_clusters   INTEGER NOT NULL DEFAULT 0,
    versions_frozen_sha TEXT,
    preregistered       BOOLEAN NOT NULL DEFAULT FALSE,
    pr_stopping_rule    TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shadow_baseline (id, observed_started_at, observed_days, resolved_clusters)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, now(), 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- GRANT ALL ON paper_log, experiments, experiment_results, shadow_baseline TO polyroot;