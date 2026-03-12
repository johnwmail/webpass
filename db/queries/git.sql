-- name: UpsertGitConfig :exec
INSERT INTO git_config (fingerprint, repo_url, encrypted_pat, updated_at)
VALUES (?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT (fingerprint) DO UPDATE
SET repo_url = excluded.repo_url,
    encrypted_pat = excluded.encrypted_pat,
    updated_at = CURRENT_TIMESTAMP;

-- name: GetGitConfig :one
SELECT * FROM git_config WHERE fingerprint = ?;

-- name: UpdateGitEncryptedPat :exec
UPDATE git_config
SET encrypted_pat = ?, updated_at = CURRENT_TIMESTAMP
WHERE fingerprint = ?;

-- name: DeleteGitConfig :exec
DELETE FROM git_config WHERE fingerprint = ?;

-- name: LogGitSync :exec
INSERT INTO git_sync_log (fingerprint, operation, status, message, entries_changed)
VALUES (?, ?, ?, ?, ?);

-- name: ListGitSyncLog :many
SELECT * FROM git_sync_log
WHERE fingerprint = ?
ORDER BY created_at DESC
LIMIT 50;

-- name: GetGitSyncStatus :one
SELECT
    gc.fingerprint,
    gc.repo_url,
    gc.encrypted_pat,
    gc.created_at as config_created_at,
    (SELECT COUNT(*) FROM git_sync_log WHERE fingerprint = gc.fingerprint AND status = 'success') as success_count,
    (SELECT COUNT(*) FROM git_sync_log WHERE fingerprint = gc.fingerprint AND status = 'failed') as failed_count
FROM git_config gc
WHERE gc.fingerprint = ?;
