# WebPass Improvements

## High Priority

### 1. Backend: Structured Error Types
Replace string-based errors with typed error types for consistent API responses.
- [x] DONE - Created srv/errors.go with APIError type and error codes

### 2. Backend: Graceful Shutdown
Add `os.Signal` handling to close DB connections and HTTP listener cleanly.
- [x] DONE - Added signal handling in cmd/srv/main.go

### 3. Backend: Request Validation
Use validation library instead of manual JSON field checking.
- [ ] SKIPPED - Manual validation is already consistent; library adds complexity

## Medium Priority

### 5. Database: Add Indexes
Add indexes on `entries.path` column for query performance with large datasets.
- [x] DONE - Created migration 004-indexes-perf.sql with idx_entries_fingerprint_path and idx_entries_fingerprint

### 6. Database: Foreign Keys
Add FK constraint on `git_config.fingerprint` referencing users table.
- [x] ALREADY DONE - FK exists in 002-git-sync.sql

## Low Priority

### 10. Testing Coverage
Add unit tests for backend utilities and frontend edge cases.
- [x] DONE - Added srv/errors_test.go for APIError type tests

### 12. Frontend State: Preact Signals
Consider using Preact Signals for better state management.
- [ ] TODO - Current pub/sub pattern works well; needs discussion before changing

### 13. Accessibility: ARIA Labels
Add ARIA labels to icon-only buttons and custom components.
- [x] DONE - Added aria-label to password/notes toggle buttons in EntryDetail and OTPDisplay

## Next Step - Needs Discussion

### A1. Session: Refresh Tokens (IMPLEMENTED)
Implement refresh token mechanism for sessions longer than 5 minutes.
- [x] DONE - Implemented with DB columns login_time and last_activity:
  - Hard limit: 30 min (configurable via SESSION_DURATION_MINUTES)
  - Soft limit: 5 min (browser close detection)
  - Auto-rotate: Updates last_activity on each API call