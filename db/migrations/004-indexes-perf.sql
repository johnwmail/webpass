-- Improve query performance with indexes
--

-- Index for fast entry lookups by fingerprint and path (used in GetEntry, DeleteEntry, MoveEntry)
CREATE INDEX IF NOT EXISTS idx_entries_fingerprint_path ON entries(fingerprint, path);

-- Index for fast entry listing by fingerprint (used in ListEntries, DeleteAccount)
CREATE INDEX IF NOT EXISTS idx_entries_fingerprint ON entries(fingerprint);

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (004, '004-indexes-perf');