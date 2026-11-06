-- name: InsertAuditLog :exec
INSERT INTO audit_log (fingerprint, event, ip, user_agent, detail)
VALUES (?, ?, ?, ?, ?);

-- name: ListAuditLog :many
SELECT * FROM audit_log
WHERE fingerprint = ?
ORDER BY created_at DESC, id DESC
LIMIT ?;

-- name: DeleteAuditLog :exec
DELETE FROM audit_log WHERE fingerprint = ?;
