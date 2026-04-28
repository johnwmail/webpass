-- Session tracking for hard/soft limits
--
-- Add columns for session management:
-- - login_time: when user first logged in (for hard limit check)
-- - last_activity: timestamp of last API call (for soft limit check)

ALTER TABLE users ADD COLUMN login_time DATETIME;
ALTER TABLE users ADD COLUMN last_activity DATETIME;

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_users_login_time ON users(login_time);
CREATE INDEX IF NOT EXISTS idx_users_last_activity ON users(last_activity);

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (005, '005-session-tracking');