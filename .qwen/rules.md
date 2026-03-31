# Project Rules for WebPass

## Documentation Files - DO NOT DELETE

**Never delete any `.md` files without explicit user consent.**

Protected files:
- `README.md`
- `GITSYNC.md`
- `PLAN.md`
- `AGENTS.md`
- `SECURITY.md`
- `DEPLOY.md`
- `DEVELOPMENT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `IMPORT.md`
- Any other `*.md` documentation files

**Rule:** If a task involves removing double encryption or refactoring, update the content of `.md` files but do NOT delete them unless the user explicitly says "delete this file".

## Git Operations - DO NOT PUSH WITHOUT CONSENT

**Never run `git push` or push to remote repositories without explicit user consent.**

Allowed without consent:
- `git status`
- `git diff`
- `git log`
- `git add`
- `git commit`

**Rule:** After making commits, always ask the user "Would you like me to push these changes?" before executing any push command.

## Git Sync PAT Encryption

PAT uses **PGP-only encryption** (single layer):
- Encrypt: `PAT → PGP encrypt (public key) → stored`
- Decrypt: `stored blob → PGP decrypt (private key) → PAT`

No password-based AES-GCM layer. This is consistent with how password entries are encrypted.

## Entry Encryption

**Creating new entries**: Only requires **public key** - NO passphrase prompt needed.
**Editing existing entries**: Requires **private key** - passphrase prompt needed to decrypt.

**Public key storage**: Stored in IndexedDB `KEYS_STORE` table (armored plaintext format).
**Private key storage**: Stored in IndexedDB `KEYS_STORE` table (armored, passphrase-protected by PGP).

## Code Changes Require Docs & Tests Review

**After every code change**, automatically review and update:

1. **Documentation** - Check all `.md` files for references to the changed code
   - Update if docs describe outdated behavior or UI flows
   - Keep screenshots/descriptions in sync with actual implementation

2. **Unit Tests** - Check all `.test.ts`, `.test.tsx`, `.test.go` files
   - Update tests that reference changed functions/components
   - Add new tests for new functionality
   - Remove or update tests for removed/changed behavior

**Rule:** Never leave docs or tests referencing old code patterns. After modifying code:
- Search for references in docs/tests
- Update them to match the new implementation
- Verify build and tests still pass

**Go Code Verification:** After any Go code changes, always run before committing:
```bash
# Format all Go files
go fmt ./...

# Vet for suspicious constructs
go vet ./...

# Run linter (if golangci-lint is installed)
golangci-lint run

# Run tests
go test ./...

# Verify build
go build -o webpass-server ./cmd/srv
```

**Rule:** Do not commit Go code without running `go fmt`, `go vet`, and `go test` at minimum.

## Playwright E2E Tests

**Always use the wrapper script** to run Playwright E2E tests:

```bash
# Preferred: Use the wrapper script (handles server setup, env vars, cleanup)
./frontend/playwright-e2e-test.sh

# With options
./frontend/playwright-e2e-test.sh --mode protected
./frontend/playwright-e2e-test.sh --mode open
./frontend/playwright-e2e-test.sh --mode all
```

**Do NOT run `npx playwright test` directly** unless explicitly instructed, because:
- The wrapper script sets up required environment variables (JWT_SECRET, DB_PATH, REGISTRATION_*, etc.)
- The wrapper script manages server lifecycle (start/stop/cleanup)
- The wrapper script handles multiple test modes (protected, open, disabled)
- Direct `npx playwright test` will fail without proper server setup

**Rule:** When asked to run E2E tests, always use `./frontend/playwright-e2e-test.sh` without parameters unless a specific mode is requested.
