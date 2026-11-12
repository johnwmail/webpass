-- Approval step for device transfers: the source device must explicitly
-- approve the requesting device (IP / User-Agent are shown to the user).

ALTER TABLE key_transfers ADD COLUMN requested_at TIMESTAMP;
ALTER TABLE key_transfers ADD COLUMN requested_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE key_transfers ADD COLUMN requested_user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE key_transfers ADD COLUMN approved_at TIMESTAMP;
ALTER TABLE key_transfers ADD COLUMN denied_at TIMESTAMP;

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (013, '013-key-transfer-approval');
