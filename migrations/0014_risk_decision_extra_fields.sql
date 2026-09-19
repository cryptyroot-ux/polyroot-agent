-- 0014: Add missing columns to risk_decisions for PgMoneyAuthority
--
-- Adds fields required by PgMoneyAuthority.reserve() for execution_permits creation.

ALTER TABLE risk_decisions
  ADD COLUMN IF NOT EXISTS ledger_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS allowed_order_style TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS venue_mode TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';
