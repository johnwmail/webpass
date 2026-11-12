-- Key transfers are now kept in server memory only (never written to disk).
DROP TABLE IF EXISTS key_transfers;

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (015, '015-drop-key-transfers');
