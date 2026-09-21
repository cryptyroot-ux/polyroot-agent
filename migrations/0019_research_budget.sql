-- 0019_research_budget.sql
CREATE TABLE IF NOT EXISTS research_budget (
  quota_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tokens_used BIGINT NOT NULL DEFAULT 0,
  cost_used_usd_micro BIGINT NOT NULL DEFAULT 0,
  last_reset TIMESTAMPTZ NOT NULL DEFAULT now()
);
