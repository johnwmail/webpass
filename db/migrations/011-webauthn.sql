-- WebAuthn / passkey support (second factor)

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint     TEXT NOT NULL,
    credential_id   BLOB NOT NULL,
    credential_json BLOB NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at    TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credential_id
    ON webauthn_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_fingerprint
    ON webauthn_credentials(fingerprint);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id           TEXT PRIMARY KEY,
    fingerprint  TEXT NOT NULL,
    purpose      TEXT NOT NULL,
    session_json BLOB NOT NULL,
    expires_at   TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
    ON webauthn_challenges(expires_at);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (011, '011-webauthn');
