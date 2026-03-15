# 🔄 Git Sync Feature

Sync encrypted password entries to a private Git repository, compatible with the original `pass` CLI.

---

## Overview

Git sync allows users to backup and synchronize their encrypted password store to any Git hosting service (GitHub, GitLab, Gitea, etc.). The server maintains a `.password-store/` directory that mirrors the SQLite database.

**Sync Model**: Manual push/pull with PGP-encrypted PAT storage.

- **No auto-sync on CRUD** — users explicitly control when to push/pull
- **Manual sync only** — user clicks Push/Pull buttons in Settings
- **Per-user configuration** — each user has their own repo URL
- **PGP-encrypted PAT** — encrypted with user's PGP public key (same as password entries)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (SPA)                                  │
│  + Preact UI (Git Sync settings, Push/Pull btn) │
│  + PGP encrypt/decrypt (PAT blob)               │
└──────────────┬──────────────────────────────────┘
               │ HTTPS + JWT
               │ POST /git/config { encrypted_pat }
               │ POST /git/push { token } (plaintext, per-request)
┌──────────────▼──────────────────────────────────┐
│  Go API Server                                  │
│  + Git service (commit, push, pull)             │
│  + Session token cache (5-min)                  │
│  + .git-repos/:fingerprint/                     │
│  + git_config.encrypted_pat (PGP-encrypted)     │
└──────────────┬──────────────────────────────────┘
               │ HTTPS + PAT (plaintext)
┌──────────────▼──────────────────────────────────┐
│  Remote Git Repo (GitHub/GitLab/etc.)           │
│  └── .password-store/                           │
│      ├── Email/gmail.com.gpg                    │
│      ├── Social/github.com.gpg                  │
│      └── Finance/chase.gpg                      │
└─────────────────────────────────────────────────┘
```

### PAT Encryption Flow (PGP Only)

```
Setup:
1. User enters PAT (plaintext)
2. Client: PAT → PGP encrypt (public key) → encrypted blob
3. POST /git/config { repo_url, encrypted_pat: "<blob>" }
4. Server: store in git_config.encrypted_pat

Manual Pull/Push:
1. User clicks "Pull" button
2. Client: fetch encrypted_pat from server
3. Client: blob → PGP decrypt (private key) → PAT (plaintext)
4. POST /git/pull { token: "ghp_..." } (plaintext over HTTPS)
5. Server: cache token 5 min, execute git pull
6. Server: NEVER store plaintext token persistently
```

### Security Model

| Data | Encryption | Storage |
|------|------------|---------|
| **PAT (client, memory)** | Plaintext (briefly) | JS memory only during sync |
| **PAT blob (client/server)** | PGP | `git_config.encrypted_pat` |
| **PAT in transit** | HTTPS | Never stored |
| **Password entries** | PGP | `entries.content` |

**Zero-Knowledge Guarantee:**
- Server stores PGP-encrypted PAT blob (same as password entries)
- Server never sees plaintext PAT except during active sync request
- Only client (with PGP private key) can decrypt

---

## Security Model

### Token Storage

| Location          | State           | Encryption                    |
|-------------------|-----------------|-------------------------------|
| **Server DB**     | At rest         | PGP                           |
| **In transit**    | Network request | HTTPS                         |
| **Server memory** | Session cache   | Plaintext (5-min expiry)      |
| **Server disk**   | Never stored    | N/A                           |

### Zero-Knowledge Guarantee

- Server **never stores** the git PAT token persistently
- Token is encrypted client-side with user's PGP public key
- Server only receives token per-request (or cached for 5-min session)
- If server is compromised, attacker cannot decrypt PAT (needs PGP private key)

---

## Tech Stack

| Component         | Technology                        |
|-------------------|-----------------------------------|
| Backend (Git)     | `os/exec` (git CLI)               |
| Backend (Cache)   | In-memory map with TTL            |
| Frontend (Crypto) | OpenPGP.js (PGP encryption)       |
| Frontend (Storage)| Server SQLite database            |

---

## Data Model (SQLite)

```sql
-- Git configuration per user
CREATE TABLE git_config (
    fingerprint       TEXT PRIMARY KEY REFERENCES users(fingerprint) ON DELETE CASCADE,
    repo_url          TEXT NOT NULL,               -- HTTPS URL to git repo
    encrypted_pat     TEXT NOT NULL,               -- PGP-encrypted PAT blob
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sync operation log
CREATE TABLE git_sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint     TEXT NOT NULL REFERENCES users(fingerprint) ON DELETE CASCADE,
    operation       TEXT NOT NULL,                 -- 'push', 'pull'
    status          TEXT NOT NULL,                 -- 'success', 'failed'
    message         TEXT,                          -- Error or commit message
    entries_changed INTEGER DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Notes on `encrypted_pat`

- **PGP-encrypted**: PAT → PGP encrypt (public key) → stored
- **Same as password entries**: Stored in server DB, but server can't decrypt
- **Client decrypts**: PGP decrypt (private key) → plaintext PAT
- **Sent per-request**: Plaintext PAT sent to server only during push/pull (over HTTPS)
- **Server caches**: 5-minute session cache (avoids repeated decryption)

---

## API Endpoints

All endpoints require JWT authentication.

| Method | Path                          | Body                                      | Description                              |
|--------|-------------------------------|-------------------------------------------|------------------------------------------|
| GET    | `/api/users/:fp/git/status`   | —                                         | Get sync status (repo URL, has encrypted PAT) |
| POST   | `/api/users/:fp/git/config`   | `{ repo_url, encrypted_pat }`             | Configure git sync (PGP-encrypted PAT) |
| POST   | `/api/users/:fp/git/session`  | `{ token }`                               | Set plaintext git token for current session |
| POST   | `/api/users/:fp/git/push`     | `{ token? }`                              | Manual push to remote                    |
| POST   | `/api/users/:fp/git/pull`     | `{ token? }`                              | Manual pull from remote + merge          |
| GET    | `/api/users/:fp/git/log`      | —                                         | Get sync operation history (last 50)     |

### Token Delivery

Git token can be provided in two ways:

1. **Per-request body**: `POST /git/push { "token": "ghp_..." }`
2. **Session cache**: Call `POST /git/session` once after decrypting, then omit token from subsequent requests

### Response Formats

**GET `/git/status`:**
```json
{
  "repo_url": "https://github.com/user/pass-store.git",
  "has_encrypted_pat": true,
  "last_sync_at": "2026-03-12T10:30:00Z"
}
```

**POST `/git/push` or `/git/pull`:**
```json
{
  "status": "success",
  "operation": "pull",
  "entries_changed": 5,
  "message": "Pulled 5 entries from remote"
}
```

**Error response:**
```json
{
  "status": "failed",
  "operation": "pull",
  "error": "CONFLICT: 2 entries have local changes that conflict with remote",
  "conflicts": [
    {"path": "Email/gmail.com.gpg", "local_modified": true, "remote_modified": true}
  ]
}
```

---

## Frontend Pages

| Page/Modal        | Description                                         |
|-------------------|-----------------------------------------------------|
| **Settings → Git Sync** | Configure repo URL, PAT, view sync status, manual push/pull buttons |

### Git Sync UI Components

**Settings Page:**
- Repo URL input (for initial setup)
- PAT input (for initial setup)
- **Push** button (disabled during operation)
- **Pull** button (disabled during operation)
- Sync status: "Last synced: 3 hours ago" or "Never synced"
- Sync log viewer (last 10 operations, expandable)

**Setup Flow:**
```
1. User enters repo URL + PAT
2. Client: PAT → PGP encrypt (public key) → blob
3. POST /git/config { repo_url, encrypted_pat }
4. Done — ready for manual push/pull
```

**Manual Sync Flow:**
```
1. User clicks "Pull" or "Push"
2. Client: blob → PGP decrypt (private key) → plaintext PAT
3. POST /git/pull or /git/push { token }
4. Show toast: success or error
```

---

## Git Repository Structure

```
.password-store/
├── .git/
├── Email/
│   ├── gmail.com.gpg
│   └── outlook.com.gpg
├── Social/
│   ├── twitter.com.gpg
│   └── github.com.gpg
└── Finance/
    └── chase.com.gpg
```

- All files are `.gpg` encrypted blobs (client-side PGP encryption)
- Directory structure mirrors `pass` CLI convention
- Compatible with standard `pass` commands after cloning

---

## Auth & Session Flow

## Auth & Session Flow

### Initial Setup (Git Sync Configuration)

```
1. User opens Settings → Git Sync (already logged in)
2. Enters repo URL + PAT (Personal Access Token)
3. Client: PAT → PGP encrypt (public key) → encrypted blob
4. POST /git/config { repo_url, encrypted_pat: "<blob>" }
5. Server: store encrypted_pat in git_config table
6. Server: git clone <repo_url> → .git-repos/:fingerprint/
7. Done — ready for manual push/pull
```

### Manual Pull/Push (Decryption Flow)

```
User clicks "Pull" or "Push" button
       │
       ▼
1. Client: fetch encrypted_pat from server
       │
       ▼
2. Client: blob → PGP decrypt (private key + passphrase) → PAT (plaintext)
       │
       ▼
3. POST /git/pull or /git/push { token: "ghp_..." }
   (plaintext PAT over HTTPS)
       │
       ▼
4. Server: cache token for 5-min session (optional)
       │
       ▼
5. Server: execute git pull/push
       │
       ├── Success → return status
       │
       └── Fail → return error (conflict, auth, network)
       │
       ▼
6. UI: show toast (success/error)
```

**Note on PGP passphrase:** User must enter PGP private key passphrase to decrypt the PAT.

### Session Caching (Optional Optimization)

```
After first decrypt + sync:
1. Client: POST /git/session { token } (plaintext)
2. Server: cache token for 5 minutes
3. Subsequent push/pull within 5 min: omit token from request
4. Server: use cached token (if valid)

Benefit: User only enters password once per session
```

---

## Build Phases

| #   | Phase               | Deliverable                                          |
| --- | ------------------- | ---------------------------------------------------- |
| 1   | Database schema     | `git_config` (with `encrypted_pat`), `git_sync_log`  |
| 2   | Backend Git service | `srv/git.go` — push, pull, conflict detection        |
| 3   | Session token cache | In-memory map with 5-min TTL                         |
| 4   | API endpoints       | Config, status, push, pull, session, log             |
| 5   | Frontend crypto     | OpenPGP.js for PAT encryption/decryption             |
| 6   | Frontend UI         | Git Sync settings with push/pull buttons             |
| 7   | Conflict UI         | Dialog for resolving conflicts (if any)              |
| 8   | Polish              | Error toasts, loading states, logs viewer            |

---

## Decisions Made

### PAT Storage: PGP-Only Encryption

**Decision**: PAT → PGP encrypt (public key) → stored in `git_config.encrypted_pat`.

**Rationale**:
- Consistent with password entries (same encryption model)
- Server stores blob but can't decrypt (zero-knowledge)
- Simpler than double encryption, equally secure

**Trade-offs**:
- User must enter PGP passphrase to decrypt PAT (each session)
- No additional password layer needed

### Manual Sync (No Auto-Sync on CRUD)

**Decision**: Users explicitly click Push/Pull buttons; no automatic sync on entry changes.

**Rationale**:
- Simpler architecture — no background sync logic
- User has full control over when data leaves their device
- Easier to reason about sync state and conflicts

**Trade-offs**:
- User must remember to push changes
- Risk of data loss if user forgets to push before device failure
- Mitigation: Show "Last synced" timestamp prominently

### Conflict Resolution: Manual

**Decision**: Detect conflicts and show UI dialog; do NOT auto-merge.

**Rationale**:
- Password data is sensitive — user should explicitly resolve conflicts
- Auto-merge strategies (`--strategy-option=ours`) can cause data loss
- Clear visibility into what changed on remote vs local

**Trade-offs**:
- More complex UI (conflict dialog with keep-local/keep-remote/skip)
- User must intervene to complete sync
- Safer — no accidental overwrites

### Session Token Cache

**Decision**: Server caches plaintext PAT for 5 minutes after first decrypt.

**Rationale**:
- User only enters password once per session
- Avoids repeated decryption for multiple sync operations
- Token cleared automatically on expiry

**Trade-offs**:
- Plaintext token exists in server memory (brief window)
- Requires HTTPS to protect in transit
- Alternative: send token with every request (more secure, more bandwidth)

---

## Open Questions

### [✓] Token Decryption UX

**Decision**: User enters PGP passphrase to decrypt PAT when needed.

**Implementation**:
- User clicks Push/Pull → prompt for PGP passphrase
- Decrypt PAT blob (PGP) → plaintext PAT
- Send to server for sync operation

---

### [✓] Conflict Resolution

**Decision**: Manual resolution via UI dialog.

**Implementation**:
- Detect conflicts by comparing file hashes (local SQLite vs remote `.gpg`)
- Show conflict list with paths and modification times
- User chooses: keep local, keep remote, or skip
- After resolution, user can pull again (or push if they chose keep-local)

---

### [ ] Multi-Device Sync

**Current**: Single device → server → git.

**Future**: Multiple devices → server → git (bidirectional sync).

**Questions**:
- How to handle concurrent edits from multiple devices?
- Should server detect conflicts before committing to git?
- Last-write-wins or vector clocks?

**Recommendation**: Defer to Phase 3 — get single-device working first.

---

### [ ] Git Repository Initialization

**Current**: Server clones existing repo or creates new one.

**Question**: What if user wants to import existing `.password-store` directory?

**Options**:
1. **Upload tar.gz** — user exports from `pass`, uploads to server
2. **Manual clone** — user clones repo, copies files, server detects
3. **Server-side import** — add `/api/users/:fp/git/import` endpoint

**Recommendation**: Option 1 for now (use existing `/import` endpoint).

---

### [ ] SSH Key Authentication

**Current**: HTTPS with PAT only.

**Future**: SSH with deploy key.

**Questions**:
- Where to store SSH private key? (server-side, encrypted?)
- How to manage `known_hosts`?
- Support both HTTPS and SSH?

**Recommendation**: Defer to Phase 2 — HTTPS PAT is sufficient for MVP.

---

### [✓] Auto-Sync Debouncing

**Decision**: Not applicable — removed auto-sync on CRUD.

Users manually push when ready. No debouncing needed.

---

### [✓] Git Error Handling

**Decision**:
- Show errors in UI toast (manual operations) — show exact error message
- Log all errors to `git_sync_log` table
- No automatic retry (user can click Pull/Push again)
- Conflict errors: show dialog with resolution options

---

## Implementation Checklist

- [ ] Database schema (`git_config` with `encrypted_pat`, `git_sync_log`)
- [ ] sqlc queries
- [ ] Git service layer (`srv/git.go`)
- [ ] Session token cache
- [ ] API endpoints
- [ ] Frontend crypto (OpenPGP.js for PAT encryption/decryption)
- [ ] Frontend Git Sync UI (push/pull buttons, PGP passphrase prompt)
- [ ] Conflict detection and UI dialog
- [ ] Error toasts in UI (show exact error messages)
- [ ] Write tests (`srv/git_test.go`)
- [ ] Update README.md (document git sync feature)

---

## Environment Variables

| Variable        | Default       | Description                          |
|-----------------|---------------|--------------------------------------|
| `GIT_REPO_ROOT` | `.git-repos`  | Base directory for cloned repos      |

---

## Security Considerations

1. **HTTPS Required**: Git operations must use HTTPS (never HTTP)
2. **Token Scope**: PAT should have minimal scope (repo access only)
3. **Token Expiry**: Recommend using expirable tokens (GitHub PATs can be revoked)
4. **Audit Log**: All git operations logged in `git_sync_log` table
5. **Rate Limiting**: Consider rate-limiting push/pull endpoints (prevent abuse)

---

## Future Enhancements (Phase 2+)

1. **SSH Key Support**: Store encrypted SSH key, use for git auth
2. **Conflict UI**: Show conflicts in browser, let user resolve manually
3. **Multi-Device Sync**: Detect and merge concurrent edits
4. **Webhook Integration**: Trigger pull on git push (real-time sync)
5. **CLI Client**: `webpass sync` command for terminal users
6. **Encrypted Commit Messages**: Sign commits with PGP key
7. **Branch per Device**: Each device has own branch, merge on sync

---

## References

- [pass (the standard unix password manager)](https://www.passwordstore.org/)
- [Git pass extension](https://git.zx2c4.com/password-store/about/)
- [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
