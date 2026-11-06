-- name: DeleteRecoveryCodes :exec
DELETE FROM recovery_codes WHERE fingerprint = ?;

-- name: InsertRecoveryCode :exec
INSERT INTO recovery_codes (fingerprint, code_hash) VALUES (?, ?);

-- name: ListUnusedRecoveryCodes :many
SELECT * FROM recovery_codes
WHERE fingerprint = ? AND used_at IS NULL;

-- name: MarkRecoveryCodeUsed :execrows
UPDATE recovery_codes
SET used_at = CURRENT_TIMESTAMP
WHERE id = ? AND used_at IS NULL;
