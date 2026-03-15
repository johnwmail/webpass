-- Git sync configuration and tracking
--
-- Git configuration per user
-- Note: Git PAT token is PGP-encrypted with user's public key and stored in encrypted_pat column.
-- Server receives plaintext token per-request for git operations (cached 5-min).
CREATE TABLE IF NOT EXISTS git_config (
    fingerprint       TEXT PRIMARY KEY REFERENCES users(fingerprint) ON DELETE CASCADE,
    repo_url          TEXT NOT NULL,           -- HTTPS URL to git repo
    encrypted_pat     TEXT NOT NULL DEFAULT '',-- PGP-encrypted PAT blob
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Git sync operation log
CREATE TABLE IF NOT EXISTS git_sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint     TEXT NOT NULL REFERENCES users(fingerprint) ON DELETE CASCADE,
    operation       TEXT NOT NULL,             -- 'push', 'pull'
    status          TEXT NOT NULL,             -- 'success', 'failed'
    message         TEXT,                      -- Error message or commit message
    entries_changed INTEGER DEFAULT 0,         -- Number of entries affected
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast log queries by user
CREATE INDEX IF NOT EXISTS idx_git_sync_log_fingerprint ON git_sync_log(fingerprint);

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (002, '002-git-sync');
