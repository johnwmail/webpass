-- Add branch column to git_config for custom branch support
-- Default value 'HEAD' means use the remote's default branch

ALTER TABLE git_config ADD COLUMN branch TEXT NOT NULL DEFAULT 'HEAD';

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (003, '003-git-config-branch');
