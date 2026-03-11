-- name: CreateUser :exec
INSERT INTO users (fingerprint, password_hash, public_key)
VALUES (?, ?, ?);

-- name: GetUser :one
SELECT * FROM users WHERE fingerprint = ?;

-- name: ListEntries :many
SELECT id, fingerprint, path, created, updated
FROM entries
WHERE fingerprint = ?
ORDER BY path;

-- name: GetEntry :one
SELECT * FROM entries
WHERE fingerprint = ? AND path = ?;

-- name: UpsertEntry :exec
INSERT INTO entries (fingerprint, path, content, created, updated)
VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (fingerprint, path) DO UPDATE
SET content = excluded.content,
    updated = CURRENT_TIMESTAMP;

-- name: DeleteEntry :exec
DELETE FROM entries
WHERE fingerprint = ? AND path = ?;

-- name: MoveEntry :exec
UPDATE entries
SET path = ?, updated = CURRENT_TIMESTAMP
WHERE fingerprint = ? AND path = ?;

-- name: DeleteUser :exec
DELETE FROM users WHERE fingerprint = ?;

-- name: UpdateUserTOTP :exec
UPDATE users
SET totp_secret = ?, totp_enabled = ?
WHERE fingerprint = ?;

-- name: ListEntriesContent :many
SELECT * FROM entries
WHERE fingerprint = ?
ORDER BY path;
