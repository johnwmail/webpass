-- Temporary, client-encrypted PGP key transfer between devices.
-- The server stores only ciphertext for a short window and never learns the
-- pairing code or the PGP passphrase.

CREATE TABLE IF NOT EXISTS key_transfers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint  TEXT NOT NULL,
    token_hash   BLOB NOT NULL,
    envelope     BLOB NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   TIMESTAMP NOT NULL,
    used_at      TIMESTAMP,
    created_ip   TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_key_transfers_token
    ON key_transfers(token_hash);
CREATE INDEX IF NOT EXISTS idx_key_transfers_fingerprint
    ON key_transfers(fingerprint);
CREATE INDEX IF NOT EXISTS idx_key_transfers_expires
    ON key_transfers(expires_at);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (012, '012-key-transfer');
