-- One-time 2FA recovery codes
--
-- Codes are stored as SHA-256 hashes; plaintext is returned to the user once
-- when 2FA is configured. No FK: rows are purged when 2FA is regenerated or
-- the account is deleted.

CREATE TABLE IF NOT EXISTS recovery_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    used_at     TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_fingerprint
    ON recovery_codes(fingerprint);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (010, '010-recovery-codes');
