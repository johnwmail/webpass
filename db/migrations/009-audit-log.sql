-- Authentication / security audit log
--
-- Stores security-relevant events per account. It intentionally has no foreign
-- key so a deleted account's final deletion event can still be recorded, while
-- the rest of the account's rows are purged on deletion.

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL DEFAULT '',
    event       TEXT NOT NULL,
    ip          TEXT NOT NULL DEFAULT '',
    user_agent  TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_fingerprint_created
    ON audit_log(fingerprint, created_at DESC);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (009, '009-audit-log');
