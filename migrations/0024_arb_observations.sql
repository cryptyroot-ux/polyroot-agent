-- Migration 0023: Arb observations (multi-outcome sum!=1 evidence base)
-- Records detected cross-token mispricings for research. Observation ONLY:
-- no fills are ever placed from these rows. A future promotion may wire
-- entries after shadow validation; until then this table is the evidence.

CREATE TABLE IF NOT EXISTS arb_observations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('BUY_ALL_YES', 'BUY_ALL_NO')),
    legs                JSONB NOT NULL,
    total_cost          NUMERIC(10,8) NOT NULL,
    guaranteed_payout   NUMERIC(10,8) NOT NULL,
    edge                NUMERIC(10,8) NOT NULL,
    observed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arb_observations_event_time
    ON arb_observations (event_id, observed_at DESC);
