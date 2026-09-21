-- migrations/0015_market_event_graph.sql
CREATE TABLE IF NOT EXISTS graph_edges (
  from_market_id TEXT NOT NULL,
  to_market_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'NATIVE_NEG_RISK','NATIVE_EVENT_MEMBER','COMPLEMENT','MUTUALLY_EXCLUSIVE',
    'SUBSET','SUPERSET','CONDITIONAL','TEMPORAL_DEPENDENCY',
    'SHARED_RESOLUTION_SOURCE','CORRELATED'
  )),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('VERIFIED_PLATFORM','VERIFIED_RULES','INFERRED')),
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  provenance TEXT NOT NULL,
  graph_version TEXT NOT NULL DEFAULT 'v0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_market_id, to_market_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges (to_market_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_provenance ON graph_edges (provenance);