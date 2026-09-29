-- Migration 0016: Source records persistence for PgSourceRegistry
-- Created: 2026-09-21

CREATE TABLE IF NOT EXISTS source_records (
  source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  epistemic_class TEXT NOT NULL CHECK (epistemic_class IN ('PRIMARY','SECONDARY','AGGREGATOR','UNKNOWN')),
  domain TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('FUNDAMENTAL','MARKET','PARTICIPANT','STRUCTURAL','ALTERNATIVE','CROSS_MARKET')),
  reliability_score NUMERIC(5,4) NOT NULL CHECK (reliability_score >= 0 AND reliability_score <= 1),
  reliability_sample_count INTEGER NOT NULL DEFAULT 0,
  reliability_window TEXT NOT NULL DEFAULT '90d',
  correction_history JSONB NOT NULL DEFAULT '[]',
  syndication_parent TEXT,
  latency_sec NUMERIC(10,3),
  specialization TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url)
);
