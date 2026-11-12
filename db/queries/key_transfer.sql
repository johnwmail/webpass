-- name: InsertKeyTransfer :exec
INSERT INTO key_transfers (fingerprint, token_hash, envelope, expires_at, created_ip, user_agent)
VALUES (?, ?, ?, ?, ?, ?);

-- name: DeleteKeyTransfersForUser :exec
DELETE FROM key_transfers WHERE fingerprint = ?;

-- name: ClaimKeyTransfer :one
UPDATE key_transfers
SET used_at = CURRENT_TIMESTAMP
WHERE token_hash = ? AND fingerprint = ?
  AND used_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP
RETURNING id, envelope;

-- name: ClearKeyTransferEnvelope :exec
UPDATE key_transfers SET envelope = X'' WHERE id = ?;

-- name: GetKeyTransferStatus :one
SELECT id, expires_at, used_at
FROM key_transfers
WHERE fingerprint = ?
ORDER BY id DESC
LIMIT 1;

-- name: DeleteExpiredKeyTransfers :exec
DELETE FROM key_transfers
WHERE expires_at <= CURRENT_TIMESTAMP
   OR (used_at IS NOT NULL AND used_at <= datetime('now', '-1 hour'));
