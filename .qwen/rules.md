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
