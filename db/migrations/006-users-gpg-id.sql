-- Store .gpg-id from password-store repos in users table (single source of truth)
ALTER TABLE users ADD COLUMN gpg_id TEXT DEFAULT '';

-- Backfill existing accounts: set gpg_id to fingerprint so they work with pass CLI
UPDATE users SET gpg_id = fingerprint WHERE gpg_id = '' OR gpg_id IS NULL;

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (006, '006-users-gpg-id');
