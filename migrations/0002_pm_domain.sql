-- Migration 0002: PolyRoot domain tables (markets, events, snapshots)
-- Created: 2026-09-09

-- ─── Events (Polymarket events = groups of markets) ───
CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    start_date      TIMESTAMPTZ,
    end_date        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'RESOLVED')),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Markets (individual binary markets within events) ───
CREATE TABLE markets (
    id              TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES events(id),
    question        TEXT NOT NULL,
    outcomes        TEXT[] NOT NULL,           -- ['Yes', 'No'] or similar
    outcome_prices  NUMERIC(5,4)[] NOT NULL,   -- [yesPrice, noPrice]
    min_price       NUMERIC(5,4) NOT NULL DEFAULT 0.001,
    max_price       NUMERIC(5,4) NOT NULL DEFAULT 0.999,
    tick_size       NUMERIC(5,4) NOT NULL DEFAULT 0.001,
    fee_maker_bps   INTEGER NOT NULL DEFAULT 0,
    fee_taker_bps   INTEGER NOT NULL DEFAULT 2,
    is_neg_risk     BOOLEAN NOT NULL DEFAULT FALSE,
    clob_token_id   TEXT,                      -- CLOB token ID for YES
    neg_risk_token_id TEXT,                    -- CLOB token ID for NO (negRisk)
    volume_24h      NUMERIC(18,8) NOT NULL DEFAULT 0,
    open_interest   NUMERIC(18,8) NOT NULL DEFAULT 0,
    liquidity       NUMERIC(18,8) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'RESOLVED')),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_markets_event
    ON markets (event_id);

CREATE INDEX idx_markets_status
    ON markets (status);

-- ─── Market Snapshots (time-series from data adapter) ───
CREATE TABLE market_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id           TEXT NOT NULL REFERENCES markets(id),
    yes_price           NUMERIC(5,4) NOT NULL CHECK (yes_price >= 0 AND yes_price <= 1),
    no_price            NUMERIC(5,4) NOT NULL CHECK (no_price >= 0 AND no_price <= 1),
    yes_size            NUMERIC(18,8) NOT NULL DEFAULT 0,
    no_size             NUMERIC(18,8) NOT NULL DEFAULT 0,
    spread              NUMERIC(5,4) NOT NULL DEFAULT 0,
    volume_24h          NUMERIC(18,8) NOT NULL DEFAULT 0,
    open_interest       NUMERIC(18,8) NOT NULL DEFAULT 0,
    last_trade_price    NUMERIC(5,4),
    last_trade_time     TIMESTAMPTZ,
    order_book_json     JSONB,                 -- full order book snapshot
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_snapshots_market_time
    ON market_snapshots (market_id, captured_at DESC);

-- Retention policy: keep last 30 days of snapshots (configured via pg_cron or app)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('delete-old-snapshots', '0 3 * * *',
--     'DELETE FROM market_snapshots WHERE captured_at < now() - interval ''30 days''');

-- ─── Funding Rates (for perpetual-style markets if applicable) ───
CREATE TABLE funding_rates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL REFERENCES markets(id),
    rate            NUMERIC(10,8) NOT NULL,    -- 8-hour rate
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (market_id, timestamp)
);

CREATE INDEX idx_funding_rates_market_time
    ON funding_rates (market_id, timestamp DESC);

-- ─── View: Active markets with latest snapshot ───
CREATE VIEW active_markets_latest AS
SELECT
    m.id,
    m.event_id,
    m.question,
    m.outcomes,
    m.fee_maker_bps,
    m.fee_taker_bps,
    m.is_neg_risk,
    m.volume_24h,
    m.open_interest,
    ms.yes_price,
    ms.no_price,
    ms.spread,
    ms.captured_at
FROM markets m
LEFT JOIN LATERAL (
    SELECT yes_price, no_price, spread, captured_at
    FROM market_snapshots
    WHERE market_id = m.id
    ORDER BY captured_at DESC
    LIMIT 1
) ms ON true
WHERE m.status = 'ACTIVE';

-- ─── View: Portfolio summary with positions ───
CREATE VIEW portfolio_summary AS
SELECT
    COALESCE(SUM(p.size * p.avg_price), 0) + COALESCE((
        SELECT cash FROM portfolio_snapshots
        ORDER BY created_at DESC LIMIT 1
    ), 0) AS total_value,
    COALESCE((
        SELECT cash FROM portfolio_snapshots
        ORDER BY created_at DESC LIMIT 1
    ), 0) AS cash,
    COALESCE(SUM(p.size * p.avg_price), 0) AS positions_value,
    COALESCE(SUM(p.unrealized_pnl), 0) AS unrealized_pnl,
    COALESCE(SUM(p.realized_pnl), 0) AS realized_pnl
FROM positions p
WHERE p.size != 0;

-- ─── Function: Update portfolio snapshot ───
CREATE OR REPLACE FUNCTION refresh_portfolio_snapshot()
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_total NUMERIC;
    v_cash NUMERIC;
    v_positions NUMERIC;
    v_unrealized NUMERIC;
    v_realized_24h NUMERIC;
    v_daily_loss NUMERIC;
    v_drawdown NUMERIC;
BEGIN
    SELECT COALESCE(SUM(size * avg_price), 0) INTO v_positions
    FROM positions WHERE size != 0;

    SELECT COALESCE(cash, 0) INTO v_cash
    FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1;

    SELECT COALESCE(SUM(unrealized_pnl), 0) INTO v_unrealized
    FROM positions;

    SELECT COALESCE(SUM(realized_pnl), 0) INTO v_realized_24h
    FROM positions
    WHERE updated_at > now() - interval '24 hours';

    v_total := v_cash + v_positions;
    v_daily_loss := GREATEST(0, -v_realized_24h);
    v_drawdown := CASE WHEN v_total > 0 THEN v_daily_loss / v_total ELSE 0 END;

    INSERT INTO portfolio_snapshots (total_value, cash, positions_value, unrealized_pnl, realized_pnl_24h, daily_loss, drawdown)
    VALUES (v_total, v_cash, v_positions, v_unrealized, v_realized_24h, v_daily_loss, v_drawdown);
END $$;