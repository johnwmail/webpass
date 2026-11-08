-- name: ListWebAuthnCredentials :many
SELECT * FROM webauthn_credentials
WHERE fingerprint = ?
ORDER BY created_at;

-- name: CountWebAuthnCredentials :one
SELECT COUNT(*) FROM webauthn_credentials WHERE fingerprint = ?;

-- name: InsertWebAuthnCredential :exec
INSERT INTO webauthn_credentials (fingerprint, credential_id, credential_json, name)
VALUES (?, ?, ?, ?);

-- name: UpdateWebAuthnCredential :exec
UPDATE webauthn_credentials
SET credential_json = ?, last_used_at = CURRENT_TIMESTAMP
WHERE credential_id = ?;

-- name: DeleteWebAuthnCredential :execrows
DELETE FROM webauthn_credentials
WHERE id = ? AND fingerprint = ?;

-- name: DeleteWebAuthnCredentialsForUser :exec
DELETE FROM webauthn_credentials WHERE fingerprint = ?;

-- name: InsertWebAuthnChallenge :exec
INSERT INTO webauthn_challenges (id, fingerprint, purpose, session_json, expires_at)
VALUES (?, ?, ?, ?, ?);

-- name: TakeWebAuthnChallenge :one
DELETE FROM webauthn_challenges
WHERE id = ? AND fingerprint = ? AND purpose = ? AND expires_at > CURRENT_TIMESTAMP
RETURNING session_json;

-- name: DeleteWebAuthnChallengesForUser :exec
DELETE FROM webauthn_challenges WHERE fingerprint = ?;

-- name: DeleteExpiredWebAuthnChallenges :exec
DELETE FROM webauthn_challenges WHERE expires_at <= CURRENT_TIMESTAMP;
