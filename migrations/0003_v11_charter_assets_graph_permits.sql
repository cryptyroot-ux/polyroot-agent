-- Migration 0003: PolyRoot v1.1 extensions
-- PRD v1.1 P9 (96 requirements), Blueprint v1.1 B4/B5/B10/B12
-- Autonomy Charter, wallets/credentials, asset registry, market graph,
-- execution permits, leases, outbox/inbox, settlements, venue trades,
-- costs, gate reports, and v1.1 risk-policy columns.
-- Created: 2026-09-09

-- ─── Autonomy Charters (PR-GOV-03, immutable per version) ───
CREATE TABLE IF NOT EXISTS autonomy_charters (
    charter_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id             UUID NOT NULL,
    release_manifest      TEXT NOT NULL,
    policy_version        TEXT NOT NULL,
    policy_hash           TEXT NOT NULL,
    capital_usd_cap       NUMERIC(18,2),
    strategy_allowlist    JSONB NOT NULL DEFAULT '[]',
    market_class_allowlist TEXT[] NOT NULL DEFAULT '{}',
    allowed_actions       TEXT[] NOT NULL DEFAULT '{}',
    risk_limits           JSONB NOT NULL DEFAULT '{}',
    risk_tiers            JSONB NOT NULL DEFAULT '{}',
    auto_recovery_rules   JSONB NOT NULL DEFAULT '{}',
    effective_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    commissioned_by       TEXT NOT NULL,
    commissioning_proof   TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_charters_wallet
    ON autonomy_charters (wallet_id, effective_at DESC);

-- ─── Wallets: signer / account / funder are distinct (PR-WAL-03) ───
CREATE TABLE IF NOT EXISTS wallets (
    wallet_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_type     TEXT NOT NULL CHECK (wallet_type IN ('DEPOSIT_WALLET', 'EOA', 'LEGACY_PROXY', 'SAFE', 'UNKNOWN')),
    signer_address  TEXT NOT NULL,
    account_wallet  TEXT NOT NULL,
    funder          TEXT NOT NULL,
    chain_id        INTEGER NOT NULL DEFAULT 137,
    verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallets_no_inferred_identity CHECK (signer_address <> '' AND account_wallet <> '' AND funder <> '')
);

-- ─── Credentials: references only, never secret material (PR-WAL-04/05, PR-SEC-04) ───
CREATE TABLE IF NOT EXISTS credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(wallet_id),
    kind            TEXT NOT NULL CHECK (kind IN ('L1_AUTH', 'CLOB_L2', 'RELAYER', 'BUILDER')),
    scope           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    health          TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('HEALTHY', 'DEGRADED', 'REVOKED', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_credentials_wallet
    ON credentials (wallet_id, kind);

-- ─── Asset registry: pUSD, USDC/USDC.e, outcome tokens are distinct (PR-WAL-06) ───
CREATE TABLE IF NOT EXISTS asset_registry (
    chain_id    INTEGER NOT NULL,
    contract    TEXT NOT NULL,
    asset_kind  TEXT NOT NULL CHECK (asset_kind IN ('PUSD', 'USDC', 'USDC_E', 'OUTCOME_TOKEN', 'UNKNOWN')),
    decimals    INTEGER NOT NULL CHECK (decimals >= 0),
    symbol      TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract)
);

-- ─── Approvals / operator allowances (PR-WAL-06) ───
CREATE TABLE IF NOT EXISTS approvals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id   UUID NOT NULL REFERENCES wallets(wallet_id),
    chain_id    INTEGER NOT NULL,
    contract    TEXT NOT NULL,
    operator    TEXT NOT NULL,
    allowance   NUMERIC(38,0),
    unlimited   BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (wallet_id, chain_id, contract, operator)
);

-- ─── Market/Event graph edges (PR-DATA-05/06, PR-RISK-02) ───
CREATE TABLE IF NOT EXISTS graph_edges (
    from_market_id  TEXT NOT NULL,
    to_market_id    TEXT NOT NULL,
    relation_type   TEXT NOT NULL CHECK (relation_type IN (
        'NATIVE_NEG_RISK', 'NATIVE_EVENT_MEMBER', 'COMPLEMENT',
        'MUTUALLY_EXCLUSIVE', 'SUBSET', 'SUPERSET', 'CONDITIONAL',
        'TEMPORAL_DEPENDENCY', 'SHARED_RESOLUTION_SOURCE', 'CORRELATED'
    )),
    trust_level     TEXT NOT NULL CHECK (trust_level IN ('VERIFIED_PLATFORM', 'VERIFIED_RULES', 'INFERRED')),
    confidence      NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    provenance      TEXT NOT NULL,
    graph_version   TEXT NOT NULL DEFAULT 'v0',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (from_market_id, to_market_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_to
    ON graph_edges (to_market_id);

-- ─── Markets: canonical identity + versioning (PR-DATA-01/02) ───
ALTER TABLE markets ADD COLUMN IF NOT EXISTS condition_id TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS token_outcome_map JSONB;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS rules_hash TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS graph_node TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS graph_version TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Evidence: provenance + rights (PR-INT-03/04) ───
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS publisher TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS source_family TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS authority TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS claim TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS relevance NUMERIC(5,4);
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS rights_policy TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS retention_policy TEXT;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS untrusted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Forecasts: ensemble + calibration lineage (PR-INT-05/06/07) ───
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS forecast_id UUID UNIQUE DEFAULT gen_random_uuid();
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS rules_version TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS graph_version TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS components JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS p_raw NUMERIC(5,4);
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS p_calibrated NUMERIC(5,4);
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS p_conservative NUMERIC(5,4);
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS counterevidence_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS assumptions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS invalidators TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS lineage JSONB;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS abstain_reason TEXT;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Intents: dedupe + purpose + refs (PR-EXE-03, Blueprint B4) ───
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES wallets(wallet_id);
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS purpose TEXT CHECK (purpose IN ('ENTRY', 'REDUCE', 'EXIT', 'REBALANCE'));
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS token_id TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS desired_qty NUMERIC(18,8);
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS desired_notional NUMERIC(18,8);
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS limit_price NUMERIC(10,8);
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS quote_ref TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS rules_ref TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS policy_ref TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS strategy_ref TEXT;
ALTER TABLE trade_intents ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- Exactly one active economic order per logical decision (PR-EXE-03).
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_wallet_dedupe
    ON trade_intents (wallet_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ─── Risk decisions: versions + permit linkage (PR-RISK-03) ───
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS decision_id UUID UNIQUE DEFAULT gen_random_uuid();
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS reservation_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS max_qty NUMERIC(18,8);
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS max_cash NUMERIC(18,8);
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS allowed_order_style TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS venue_mode TEXT;
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS ledger_version TEXT;
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS policy_version TEXT;
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS quote_version TEXT;
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS lease_version TEXT;
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS reason_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE risk_decisions ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Execution permits: short-lived, atomic with reservation (PR-RISK-03) ───
CREATE TABLE IF NOT EXISTS execution_permits (
    permit_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id     UUID NOT NULL REFERENCES risk_decisions(id),
    intent_id       UUID NOT NULL REFERENCES trade_intents(id),
    ledger_version  TEXT NOT NULL,
    policy_version  TEXT NOT NULL,
    policy_hash     TEXT NOT NULL,
    quote_id        TEXT NOT NULL,
    lease_epoch     BIGINT NOT NULL,
    reservation_ids UUID[] NOT NULL,
    max_qty         NUMERIC(18,8) NOT NULL CHECK (max_qty >= 0),
    max_cash        NUMERIC(18,8) NOT NULL CHECK (max_cash >= 0),
    allowed_order_style TEXT[] NOT NULL,
    venue_mode      TEXT NOT NULL,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    single_use      BOOLEAN NOT NULL DEFAULT TRUE,
    used_at         TIMESTAMPTZ,
    schema_version  TEXT NOT NULL DEFAULT '1.0.0'
);

CREATE INDEX IF NOT EXISTS idx_permits_decision
    ON execution_permits (decision_id);

CREATE INDEX IF NOT EXISTS idx_permits_expiry
    ON execution_permits (expires_at) WHERE used_at IS NULL;

-- ─── Executor leases: at most one active authority per wallet (PR-OPS-02) ───
CREATE TABLE IF NOT EXISTS executor_leases (
    wallet_id   UUID PRIMARY KEY REFERENCES wallets(wallet_id),
    lease_epoch BIGINT NOT NULL,
    holder      TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Transactional outbox jobs (Blueprint B4/B12) ───
CREATE TABLE IF NOT EXISTS outbox_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  TEXT NOT NULL,
    aggregate_id    UUID NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_jobs_ready
    ON outbox_jobs (next_attempt_at) WHERE status IN ('PENDING', 'FAILED');

-- ─── Inbox dedupe for venue/user-stream events (PR-EXE-06) ───
CREATE TABLE IF NOT EXISTS inbox_events (
    source      TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
    payload     JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (source, event_id)
);

-- ─── Venue trades: raw + monotonic internal status (PR-EXE-06) ───
CREATE TABLE IF NOT EXISTS venue_trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_trade_id  TEXT UNIQUE,
    order_id        UUID REFERENCES orders(id),
    market_id       TEXT NOT NULL,
    side            TEXT NOT NULL,
    price           NUMERIC(10,8) NOT NULL,
    size            NUMERIC(18,8) NOT NULL,
    fee_paid        NUMERIC(18,8) NOT NULL DEFAULT 0,
    rebate_earned   NUMERIC(18,8) NOT NULL DEFAULT 0,
    maker_taker     TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (maker_taker IN ('MAKER', 'TAKER', 'UNKNOWN')),
    raw_status      TEXT,
    internal_status TEXT NOT NULL DEFAULT 'MATCHED' CHECK (internal_status IN ('MATCHED', 'MINED', 'RETRYING', 'CONFIRMED', 'FAILED')),
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw             JSONB
);

-- ─── Settlements / redemptions: finality-gated (PR-EXE-06) ───
CREATE TABLE IF NOT EXISTS settlements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    position_side   TEXT NOT NULL,
    size            NUMERIC(18,8) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
    tx_receipt      TEXT,
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Ledger: corrections reference prior state, never mutate (PR-LED-07) ───
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS correction_of_event_id UUID REFERENCES ledger_events(id);

-- ─── Positions: status + projection version (PR-LED-03) ───
ALTER TABLE positions ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('PENDING', 'SETTLED', 'REDEEMABLE', 'REDEEMED', 'DISPUTED'));
ALTER TABLE positions ADD COLUMN IF NOT EXISTS projected_event_seq BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Orders: raw venue + internal monotonic status (PR-EXE-06) ───
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';

-- ─── Risk policy: v1.1 columns (PRD P8). Old columns retained for compat. ───
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'v0-bootstrap';
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PAPER';
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS capital_usd_cap NUMERIC(18,2);
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS max_order_pct NUMERIC(5,4) NOT NULL DEFAULT 0.005;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS max_market_pct NUMERIC(5,4) NOT NULL DEFAULT 0.02;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS max_event_group_pct NUMERIC(5,4) NOT NULL DEFAULT 0.05;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS max_portfolio_pct NUMERIC(5,4) NOT NULL DEFAULT 0.10;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS daily_loss_stop_pct NUMERIC(5,4) NOT NULL DEFAULT 0.02;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS drawdown_stop_pct NUMERIC(5,4) NOT NULL DEFAULT 0.05;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS min_edge_after_cost NUMERIC(10,8) NOT NULL DEFAULT 0.03;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS book_max_age_ms INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS metadata_max_age_s INTEGER NOT NULL DEFAULT 60;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS forecast_max_age_s INTEGER NOT NULL DEFAULT 900;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS clock_skew_max_ms INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS max_slippage_abs NUMERIC(10,8) NOT NULL DEFAULT 0.01;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS intent_ttl_s INTEGER NOT NULL DEFAULT 30;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS risk_permit_ttl_ms INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE risk_policy ADD COLUMN IF NOT EXISTS reconcile_interval_s INTEGER NOT NULL DEFAULT 15;

-- ─── Operating costs allocation (PR-LED-06): trading PnL vs net economic PnL ───
CREATE TABLE IF NOT EXISTS operating_costs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category    TEXT NOT NULL CHECK (category IN ('MODEL', 'DATA', 'INFRA', 'VENUE_FEE', 'REBATE')),
    experiment  TEXT,
    strategy    TEXT,
    amount      NUMERIC(18,8) NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'pUSD',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata    JSONB
);

CREATE INDEX IF NOT EXISTS idx_costs_recorded
    ON operating_costs (recorded_at DESC);

-- ─── Gate reports (B17.1): requirement/test ID, commit/image/schema, evidence ───
CREATE TABLE IF NOT EXISTS gate_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gate                TEXT NOT NULL,
    requirement_id      TEXT,
    test_id             TEXT,
    commit_sha          TEXT,
    image_digest        TEXT,
    schema_version      TEXT,
    result              JSONB NOT NULL,
    evidence_path       TEXT,
    reviewer            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gate_reports_gate
    ON gate_reports (gate, created_at DESC);
