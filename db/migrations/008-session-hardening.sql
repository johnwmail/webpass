-- Session revocation and TOTP replay protection
--
-- session_version is embedded in JWTs. Bumping it invalidates every existing
-- token for that account (password change, 2FA change, "log out everywhere").
--
-- last_totp_step stores the most recent accepted TOTP time step so the same
-- 6-digit code cannot be replayed within (or just after) its validity window.

ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_totp_step INTEGER NOT NULL DEFAULT 0;

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (008, '008-session-hardening');
