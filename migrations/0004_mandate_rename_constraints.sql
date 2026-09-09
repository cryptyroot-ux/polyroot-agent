-- Migration 0004: v1.1 terminology + canonical constraints
-- R1: rename autonomy_charters -> mandates (PM-GOV-03 "Mandat otonomi")
-- R2: wallet_type CHECK aligned to WalletTypeSchema (PM-WALLET-01)
-- R3: risk_policy.execution_mode CHECK aligned to OperationModeSchema (PM-GOV-02)
-- R4: policy_version bootstrap guards
-- Created: 2026-09-09. Forward-only. See scripts/migrate.ts (T-PM-OPS-07).

-- ─── R1: autonomy_charters -> mandates ───
ALTER TABLE IF EXISTS autonomy_charters RENAME TO mandates;
ALTER TABLE mandates RENAME COLUMN charter_id TO mandate_id;

ALTER INDEX IF EXISTS idx_charters_wallet RENAME TO idx_mandates_wallet;

ALTER TABLE mandates RENAME CONSTRAINT autonomy_charters_pkey TO mandates_pkey;

-- ─── R2: wallets.wallet_type aligned (PM-WALLET-01) ───
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_type_check;

ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_type_check
    CHECK (wallet_type IN (
        'DEPOSIT_WALLET', 'EOA', 'POLY_PROXY', 'GNOSIS_SAFE',
        'POLY_1271', 'LEGACY_PROXY', 'SAFE', 'UNKNOWN'
    ));

-- ─── R3: execution_mode aligned (PM-GOV-02) ───
ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_execution_mode_check;

UPDATE risk_policy SET execution_mode = 'PAPER' WHERE execution_mode IS NULL;

ALTER TABLE risk_policy ADD CONSTRAINT risk_policy_execution_mode_check
    CHECK (execution_mode IN ('RESEARCH', 'PAPER', 'SHADOW', 'LIVE'));

-- ─── R4: pandemic-conservative bootstrap metadata (PM-GOV-03) ───
ALTER TABLE mandates
    ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0.0';