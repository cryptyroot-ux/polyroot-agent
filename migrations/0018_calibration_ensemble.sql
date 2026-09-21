-- Migration 0018: Calibration and Ensemble tables
-- Persistent calibration maps and ensemble version storage

CREATE TABLE IF NOT EXISTS calibration_models (
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  category TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,
  regime TEXT NOT NULL DEFAULT 'default',
  isotonic_map JSONB NOT NULL, -- or spline coefficients
  sample_count INTEGER NOT NULL,
  last_trained TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_provider, model_name, category, horizon_sec, regime)
);

CREATE INDEX IF NOT EXISTS idx_calibration_models_lookup 
  ON calibration_models (model_provider, model_name, category, horizon_sec);

CREATE TABLE IF NOT EXISTS ensemble_versions (
  version TEXT PRIMARY KEY,
  event_class TEXT NOT NULL,
  weight_book JSONB NOT NULL, -- familyId -> weight
  components JSONB NOT NULL,  -- list of {p_yes, familyId, weight}
  p_yes NUMERIC(5,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ensemble_versions_event_class 
  ON ensemble_versions (event_class);

CREATE INDEX IF NOT EXISTS idx_ensemble_versions_created_at 
  ON ensemble_versions (created_at);