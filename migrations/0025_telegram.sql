-- Migration 0025: Telegram pairing + audit log.
-- DM pairing requests (code stored as sha256, never plaintext) and an
-- append-only audit trail of every Telegram command (allowed or denied).
-- No secrets are ever stored here: only user ids, command names and
-- redacted results.

CREATE TABLE IF NOT EXISTS telegram_pairing (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    username        TEXT NOT NULL DEFAULT '',
    code_hash       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'revoked', 'expired')),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_pairing_user
    ON telegram_pairing (user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_pairing_status
    ON telegram_pairing (status);

CREATE TABLE IF NOT EXISTS telegram_allowlist (
    user_id         TEXT PRIMARY KEY,
    username        TEXT NOT NULL DEFAULT '',
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,
    command         TEXT NOT NULL,
    args_redacted   TEXT NOT NULL DEFAULT '',
    result          TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_audit_time
    ON telegram_audit (created_at DESC);
