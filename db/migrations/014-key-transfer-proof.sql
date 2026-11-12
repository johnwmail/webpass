-- Pairing-code proof for device transfer approval.
-- The target device proves it knows the pairing code with an HMAC; the source
-- device verifies it locally. The server only stores the challenge and proof.

ALTER TABLE key_transfers ADD COLUMN challenge TEXT NOT NULL DEFAULT '';
ALTER TABLE key_transfers ADD COLUMN requested_proof TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (014, '014-key-transfer-proof');
