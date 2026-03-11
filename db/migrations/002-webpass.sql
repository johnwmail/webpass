CREATE TABLE IF NOT EXISTS users (
    fingerprint   TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    totp_secret   TEXT,
    totp_enabled  INTEGER DEFAULT 0,
    created       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL REFERENCES users(fingerprint),
    path        TEXT NOT NULL,
    content     BLOB NOT NULL,
    created     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(fingerprint, path)
);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (002, '002-webpass');
