-- Migration 0001: Initial schema for PolyRoot ledger and core tables
-- Created: 2026-09-09

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Ledger Events (append-only) ───
CREATE TABLE ledger_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type         TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    aggregate_type TEXT NOT NULL,
    payload      JSONB NOT NULL,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_events_aggregate
    ON ledger_events (aggregate_type, aggregate_id);

CREATE INDEX idx_ledger_events_created_at
    ON ledger_events (created_at DESC);

-- ─── Outbox for reliable event publishing ───
CREATE TABLE outbox (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unpublished
    ON outbox (created_at) WHERE published_at IS NULL;

-- ─── Evidence Store ───
CREATE TABLE evidence_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type         TEXT NOT NULL,
    source       TEXT NOT NULL,
    payload      JSONB NOT NULL,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_created_at
    ON evidence_items (created_at DESC);

CREATE INDEX idx_evidence_type
    ON evidence_items (type);

-- ─── Forecasts ───
CREATE TABLE forecasts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id      TEXT NOT NULL,
    horizon_sec    INTEGER NOT NULL,
    probability_yes NUMERIC(5,4) NOT NULL CHECK (probability_yes >= 0 AND probability_yes <= 1),
    confidence     NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    model          TEXT NOT NULL,
    features       JSONB,
    evidence_ids   UUID[] NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_forecasts_market
    ON forecasts (market_id, created_at DESC);

-- ─── Trade Intents ───
CREATE TABLE trade_intents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    price           NUMERIC(5,4) NOT NULL CHECK (price >= 0 AND price <= 1),
    size            NUMERIC(18,8) NOT NULL CHECK (size > 0),
    order_type      TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'POST_ONLY', 'FOK', 'IOC')),
    expiration_sec  INTEGER NOT NULL,
    forecast_id     UUID REFERENCES forecasts(id),
    evidence_ids    UUID[] NOT NULL DEFAULT '{}',
    strategy        TEXT NOT NULL,
    metadata        JSONB,
    status          TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'MODIFIED', 'EXPIRED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at      TIMESTAMPTZ
);

CREATE INDEX idx_intents_status
    ON trade_intents (status, created_at DESC);

-- ─── Risk Decisions ───
CREATE TABLE risk_decisions (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id              UUID NOT NULL REFERENCES trade_intents(id),
    status                 TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED', 'MODIFIED')),
    reservation_id         UUID,
    allowed_size           NUMERIC(18,8),
    allowed_price_min      NUMERIC(5,4),
    allowed_price_max      NUMERIC(5,4),
    rejection_reason       TEXT,
    ev_per_share           NUMERIC(10,8),
    edge_after_fees        NUMERIC(10,8),
    portfolio_impact       NUMERIC(10,8),
    market_impact          NUMERIC(10,8),
    decided_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_risk_decisions_intent
    ON risk_decisions (intent_id);

-- ─── Capital Reservations ───
CREATE TABLE reservations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id       UUID REFERENCES trade_intents(id),
    risk_decision_id UUID REFERENCES risk_decisions(id),
    amount          NUMERIC(18,8) NOT NULL CHECK (amount >= 0),
    currency        TEXT NOT NULL DEFAULT 'pUSD',
    status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONSUMED')),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at     TIMESTAMPTZ
);

CREATE INDEX idx_reservations_status
    ON reservations (status, expires_at);

-- ─── Orders (signed, submitted, filled) ───
CREATE TABLE orders (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id             UUID REFERENCES trade_intents(id),
    risk_decision_id      UUID REFERENCES risk_decisions(id),
    reservation_id        UUID REFERENCES reservations(id),
    venue_order_id        TEXT,
    market_id             TEXT NOT NULL,
    side                  TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    price                 NUMERIC(5,4) NOT NULL CHECK (price >= 0 AND price <= 1),
    size                  NUMERIC(18,8) NOT NULL CHECK (size > 0),
    fee_rate_bps          INTEGER NOT NULL CHECK (fee_rate_bps >= 0),
    nonce                 BIGINT NOT NULL,
    expiration            BIGINT NOT NULL,
    signature             TEXT,
    signer                TEXT,
    signed_at             TIMESTAMPTZ,
    submitted_at          TIMESTAMPTZ,
    filled_size           NUMERIC(18,8) NOT NULL DEFAULT 0,
    average_price         NUMERIC(5,4),
    status                TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN')),
    error                 TEXT,
    transaction_hash      TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_status
    ON orders (status, updated_at DESC);

CREATE INDEX idx_orders_intent
    ON orders (intent_id);

-- ─── Positions ───
CREATE TABLE positions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    size            NUMERIC(18,8) NOT NULL DEFAULT 0,
    avg_price       NUMERIC(5,4),
    unrealized_pnl  NUMERIC(18,8) NOT NULL DEFAULT 0,
    realized_pnl    NUMERIC(18,8) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (market_id, side)
);

-- ─── Portfolio Snapshots ───
CREATE TABLE portfolio_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_value     NUMERIC(18,8) NOT NULL,
    cash            NUMERIC(18,8) NOT NULL,
    positions_value NUMERIC(18,8) NOT NULL,
    unrealized_pnl  NUMERIC(18,8) NOT NULL,
    realized_pnl_24h NUMERIC(18,8) NOT NULL,
    daily_loss      NUMERIC(18,8) NOT NULL,
    drawdown        NUMERIC(10,8) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_portfolio_snapshots_created
    ON portfolio_snapshots (created_at DESC);

-- ─── Risk Policy (single row, owner-managed) ───
CREATE TABLE risk_policy (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_cap_share         NUMERIC(5,4) NOT NULL CHECK (order_cap_share >= 0 AND order_cap_share <= 1),
    market_cap_share        NUMERIC(5,4) NOT NULL CHECK (market_cap_share >= 0 AND market_cap_share <= 1),
    event_group_cap_share   NUMERIC(5,4) NOT NULL CHECK (event_group_cap_share >= 0 AND event_group_cap_share <= 1),
    portfolio_cap_share     NUMERIC(5,4) NOT NULL CHECK (portfolio_cap_share >= 0 AND portfolio_cap_share <= 1),
    daily_loss_stop_share   NUMERIC(5,4) NOT NULL CHECK (daily_loss_stop_share >= 0 AND daily_loss_stop_share <= 1),
    drawdown_stop_share     NUMERIC(5,4) NOT NULL CHECK (drawdown_stop_share >= 0 AND drawdown_stop_share <= 1),
    min_edge_per_share      NUMERIC(10,8) NOT NULL CHECK (min_edge_per_share >= 0),
    max_order_size          NUMERIC(18,8),
    max_open_orders         INTEGER,
    allowed_markets         TEXT[],
    blocked_markets         TEXT[],
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by              TEXT
);

-- Insert default conservative policy (placeholders — owner MUST override)
INSERT INTO risk_policy (order_cap_share, market_cap_share, event_group_cap_share,
                         portfolio_cap_share, daily_loss_stop_share, drawdown_stop_share,
                         min_edge_per_share)
VALUES (0.005, 0.02, 0.05, 0.10, 0.02, 0.05, 0.03);

-- ─── Audit Log ───
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor           TEXT NOT NULL,
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     UUID,
    payload         JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_actor
    ON audit_log (actor, created_at DESC);

CREATE INDEX idx_audit_log_resource
    ON audit_log (resource_type, resource_id);