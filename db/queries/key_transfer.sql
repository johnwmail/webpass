-- name: InsertKeyTransfer :exec
INSERT INTO key_transfers (fingerprint, token_hash, envelope, challenge, expires_at, created_ip, user_agent)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: DeleteKeyTransfersForUser :exec
DELETE FROM key_transfers WHERE fingerprint = ?;

-- name: RequestKeyTransfer :one
UPDATE key_transfers
SET requested_at = CURRENT_TIMESTAMP,
    requested_ip = ?,
    requested_user_agent = ?,
    requested_proof = ?
WHERE token_hash = ? AND fingerprint = ?
  AND used_at IS NULL
  AND approved_at IS NULL
  AND denied_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP
RETURNING id;

-- name: ApproveKeyTransfer :one
UPDATE key_transfers
SET approved_at = CURRENT_TIMESTAMP
WHERE fingerprint = ?
  AND used_at IS NULL
  AND denied_at IS NULL
  AND requested_at IS NOT NULL
  AND requested_proof != ''
  AND expires_at > CURRENT_TIMESTAMP
RETURNING id;

-- name: DenyKeyTransfer :one
UPDATE key_transfers
SET denied_at = CURRENT_TIMESTAMP, envelope = X''
WHERE fingerprint = ?
  AND used_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP
RETURNING id;

-- name: ClaimKeyTransfer :one
UPDATE key_transfers
SET used_at = CURRENT_TIMESTAMP
WHERE token_hash = ? AND fingerprint = ?
  AND used_at IS NULL
  AND approved_at IS NOT NULL
  AND denied_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP
RETURNING id, envelope;

-- name: ClearKeyTransferEnvelope :exec
UPDATE key_transfers SET envelope = X'' WHERE id = ?;

-- name: GetKeyTransferStatus :one
SELECT id, expires_at, used_at, requested_at, requested_ip, requested_user_agent,
       requested_proof, challenge, approved_at, denied_at
FROM key_transfers
WHERE fingerprint = ?
ORDER BY id DESC
LIMIT 1;

-- name: GetKeyTransferEnvelope :one
SELECT envelope, challenge
FROM key_transfers
WHERE fingerprint = ?
  AND used_at IS NULL
  AND denied_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP
ORDER BY id DESC
LIMIT 1;

-- name: DeleteExpiredKeyTransfers :exec
DELETE FROM key_transfers
WHERE expires_at <= CURRENT_TIMESTAMP
   OR (used_at IS NOT NULL AND used_at <= datetime('now', '-1 hour'));
