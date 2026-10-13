-- Migration 0028: LIVE-only mode.
-- The product no longer has PAPER, SHADOW or MICRO_LIVE runtime modes. The
-- runtime type is LIVE (plus READ_ONLY for fail-closed degradation), and the
-- pre-live 30-day / 100-cluster observation gate no longer blocks startup.
--
-- This migration aligns the persisted state with that type:
--   1. experiments.mode CHECK allowed ('PAPER','SHADOW','MICRO_LIVE') and did
--      NOT include 'LIVE', so the runtime could not write a LIVE experiment.
--   2. live_guard_state.runtime_mode defaulted to 'PAPER'.
--   3. risk_policy.execution_mode allowed RESEARCH/PAPER/SHADOW/LIVE.

-- 1. experiments: accept only LIVE, after rewriting historical rows.
ALTER TABLE experiments DROP CONSTRAINT IF EXISTS experiments_mode_check;
UPDATE experiments SET mode = 'LIVE' WHERE mode IN ('PAPER', 'SHADOW', 'MICRO_LIVE');
ALTER TABLE experiments
  ADD CONSTRAINT experiments_mode_check CHECK (mode IN ('LIVE'));

-- 2. Runtime mode: anything that is not an explicit degraded state is LIVE.
UPDATE live_guard_state
   SET runtime_mode = 'LIVE', mode_updated_at = now()
 WHERE runtime_mode IS NULL
    OR runtime_mode IN ('PAPER', 'SHADOW', 'MICRO_LIVE', 'RESEARCH');

-- 3. risk_policy.execution_mode: LIVE is the only non-research execution mode.
ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_execution_mode_check;
UPDATE risk_policy SET execution_mode = 'LIVE'
 WHERE execution_mode IN ('PAPER', 'SHADOW', 'MICRO_LIVE');
ALTER TABLE risk_policy
  ADD CONSTRAINT risk_policy_execution_mode_check
  CHECK (execution_mode IN ('RESEARCH', 'LIVE'));