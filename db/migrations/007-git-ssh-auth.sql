-- SSH authentication support for Git sync
--
-- Adds auth_type and encrypted_ssh_key columns to git_config
-- Creates git_known_hosts table for TOFU host key verification

ALTER TABLE git_config ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'https';
ALTER TABLE git_config ADD COLUMN encrypted_ssh_key TEXT NOT NULL DEFAULT '';

-- Known hosts table for SSH TOFU (Trust On First Use)
CREATE TABLE IF NOT EXISTS git_known_hosts (
    fingerprint          TEXT NOT NULL REFERENCES users(fingerprint) ON DELETE CASCADE,
    hostname             TEXT NOT NULL,
    host_key_fingerprint TEXT NOT NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fingerprint, hostname)
);

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (007, '007-git-ssh-auth');
