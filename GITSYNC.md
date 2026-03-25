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

## Account Deletion and Git Cleanup

When a user **permanently deletes their account**, the following cleanup occurs:

1. **Git repository folder deleted** — `/data/git-repos/{fingerprint}/` is removed
2. **All database entries deleted** — SQLite entries removed
3. **User account deleted** — User record removed from database
4. **Local data cleared** — Browser IndexedDB cleared

**Note:** This only deletes the local git repository on the server. The remote Git repository (GitHub, GitLab, etc.) is NOT affected. Users should manually delete their remote repository if desired.

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
| GET    | `/api/{fingerprint}/git/status`   | —                                         | Get sync status (repo URL, has encrypted PAT) |
| POST   | `/api/{fingerprint}/git/config`   | `{ repo_url, encrypted_pat }`             | Configure git sync (PGP-encrypted PAT) |
| POST   | `/api/{fingerprint}/git/session`  | `{ token }`                               | Set plaintext git token for current session |
| POST   | `/api/{fingerprint}/git/push`     | `{ token? }`                              | Manual push to remote                    |
| POST   | `/api/{fingerprint}/git/pull`     | `{ token? }`                              | Manual pull from remote + merge          |
| GET    | `/api/{fingerprint}/git/log`      | —                                         | Get sync operation history (last 50)     |

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
  "error": "local has unpushed changes, please push first"
}
```

---

## Frontend Pages

| Page/Modal        | Description                                         |
|-------------------|-----------------------------------------------------|
| **Settings → Git Sync** | Configure repo URL, PAT, view sync status, manual push/pull buttons |

---

## Setup & Configuration Guide

### Prerequisites

Before configuring Git sync, ensure you have:

1. **A private Git repository** created on your preferred hosting service:
   - GitHub: `https://github.com/username/password-store.git`
   - GitLab: `https://gitlab.com/username/password-store.git`
   - Gitea/Forgejo: `https://gitea.example.com/username/password-store.git`

2. **A Personal Access Token (PAT)** with appropriate permissions:
   - **GitHub**: Settings → Developer settings → Personal access tokens → Tokens (classic)
     - Scope: `repo` (full control of private repositories)
   - **GitLab**: Settings → Access Tokens
     - Scope: `api`, `write_repository`
   - **Gitea**: Settings → Applications → Generate New Token
     - Scope: `write:repository`

3. **Your PGP keypair** already set up in WebPass (from initial account setup)

---

### Step-by-Step Configuration

#### Step 1: Open Git Sync Settings

1. Log in to WebPass
2. Click **Settings** (⚙️) in the top-right corner
3. Scroll to **Git Sync** section

#### Step 2: Enter Repository URL

1. In the **Repository URL** field, enter your private Git repo URL:
   ```
   https://github.com/username/password-store.git
   ```

2. Ensure the URL uses **HTTPS** (not SSH) — SSH is not yet supported

#### Step 3: Enter Personal Access Token

1. In the **Personal Access Token** field, paste your PAT:
   - GitHub tokens start with `ghp_`
   - GitLab tokens are plain strings
   - Gitea tokens are plain strings

2. **Security note**: The PAT will be encrypted with your PGP public key before being sent to the server

#### Step 4: Save Configuration

1. Click **✓ Configure** button
2. The client will:
   - Encrypt your PAT using your PGP public key
   - Send the encrypted blob to the server
   - Server stores it in `git_config.encrypted_pat`
   - Server clones your repository to `.git-repos/:fingerprint/`

3. On success, you'll see:
   - Repository URL displayed
   - Sync history: ✅ 0 / ❌ 0
   - **Push** and **Pull** buttons enabled

---

### Initial Push (First Sync)

After configuration, perform an initial push to seed your remote repository:

1. Click **⬆️ Push Now**
2. You'll be prompted for your **PGP passphrase** (to decrypt the PAT)
3. Enter your passphrase and click **OK**
4. The client will:
   - Decrypt the PAT from the server using your PGP private key
   - Send the plaintext PAT to the server (over HTTPS)
   - Server exports all entries to `.password-store/` directory
   - Server commits and pushes to remote

5. On success:
   - Toast notification: "Pushed to remote"
   - Sync history updates: ✅ 1 / ❌ 0

---

### Manual Sync Operations

#### Pull (Download from Remote)

Use **Pull** to download changes from your remote repository:

1. Click **⬇️ Pull Now**
2. Enter your **PGP passphrase** when prompted
3. Server fetches from remote and merges into local database
4. On success: "Pulled X entries from remote"

**When to Pull:**
- After setting up a new device
- After manually adding commits to the remote repository
- To recover from data loss

#### Push (Upload to Remote)

Use **Push** to upload local changes to your remote repository:

1. Click **⬆️ Push Now**
2. Enter your **PGP passphrase** when prompted
3. Server commits current state and pushes to remote
4. On success: "Pushed to remote"

**When to Push:**
- After adding/editing/deleting entries
- Before switching devices
- As a backup before major changes

---

### Update Configuration

To change your repository URL or PAT:

1. Go to **Settings → Git Sync**
2. Scroll to **Update Configuration** section
3. Enter new **Repository URL** (if changing)
4. Enter new **PAT** (leave blank to keep current)
5. Click **💾 Update Config**
6. Enter your **PGP passphrase** to encrypt the new PAT

---

### View Sync Logs

To view sync history:

1. Click **📋 View Logs**
2. See last 50 sync operations with:
   - Operation type (PUSH/PULL)
   - Status (✅ success / ❌ failed)
   - Timestamp
   - Message or error details
   - Number of entries changed

---

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

## Technical Flows

### Configuration Flow

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │      │   Client    │      │   Server    │      │   Git       │
│   (Browser) │      │   (SPA)     │      │   (Go API)  │      │   Remote    │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                    │                    │                    │
       │ 1. Enter URL + PAT │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ 2. PGP encrypt PAT │                    │
       │                    │    (public key)    │                    │
       │                    │                    │                    │
       │ 3. POST /git/config│                    │                    │
       │    { repo_url,     │                    │                    │
       │      encrypted_pat }                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ 4. Store in DB     │                    │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │                    │ 5. git clone       │
       │                    │                    │───────────────────>│
       │                    │                    │                    │
       │ 6. Configured!     │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
```

### Push Flow

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │      │   Client    │      │   Server    │      │   Git       │
│   (Browser) │      │   (SPA)     │      │   (Go API)  │      │   Remote    │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                    │                    │                    │
       │ 1. Click Push      │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │ 2. Fetch encrypted │                    │                    │
       │    pat from server │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
       │ 3. PGP decrypt PAT │                    │                    │
       │    (private key +  │                    │                    │
       │     passphrase)    │                    │                    │
       │                    │                    │                    │
       │ 4. POST /git/push  │                    │                    │
       │    { token }       │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ 5. Export entries  │                    │
       │                    │    to .password-store/                  │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │ 6. git add, commit │                    │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │                    │ 7. git push        │                    │
       │                    │─────────────────────────────────────────>│
       │                    │                    │                    │
       │ 8. Push success!   │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
```

### Pull Flow

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │      │   Client    │      │   Server    │      │   Git       │
│   (Browser) │      │   (SPA)     │      │   (Go API)  │      │   Remote    │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                    │                    │                    │
       │ 1. Click Pull      │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │ 2. Fetch encrypted │                    │                    │
       │    pat from server │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
       │ 3. PGP decrypt PAT │                    │                    │
       │    (private key +  │                    │                    │
       │     passphrase)    │                    │                    │
       │                    │                    │                    │
       │ 4. POST /git/pull  │                    │                    │
       │    { token }       │                    │                    │
       │───────────────────>│                    │                    │
       │                    │                    │                    │
       │                    │ 5. git pull        │                    │
       │                    │<─────────────────────────────────────────│
       │                    │                    │                    │
       │                    │ 6. Sync database   │                    │
       │                    │    with repo state │                    │
       │                    │───────────────────>│                    │
       │                    │                    │                    │
       │ 7. Pull success!   │                    │                    │
       │    (X entries)     │                    │                    │
       │<───────────────────│                    │                    │
       │                    │                    │                    │
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
- Easier to reason about sync state

**Trade-offs**:
- User must remember to push changes
- Risk of data loss if user forgets to push before device failure
- Mitigation: Show "Last synced" timestamp prominently

### Conflict Resolution: Simplified

**Decision**: No conflict detection. Git's native non-fast-forward errors guide users.

**Rationale**:
- Zero-knowledge architecture makes content comparison impossible
- Path-based conflict detection is unreliable (encrypted blobs differ randomly)
- Simple error messages are clearer than complex conflict dialogs
- Reset button provides nuclear option for confused states

**Trade-offs**:
- User must manually resolve by pulling/pushing in correct order
- May require Reset operation if sync state becomes confused
- Much simpler implementation, no conflict UI needed

**Error Messages**:
- Push fails: "Remote has changes, please pull first"
- Pull fails: "Local has unpushed changes, please push first"
- Resolution: Use Reset button to discard local and re-clone from remote

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

## Troubleshooting

### Common Issues

#### "PAT not configured. Please reconfigure Git sync."

**Cause**: The encrypted PAT couldn't be retrieved or decrypted.

**Solution**:
1. Go to Settings → Git Sync
2. Re-enter your PAT in the Update Configuration section
3. Click "Update Config" and enter your PGP passphrase

---

#### "Failed to decrypt PAT. Check passphrase."

**Cause**: Wrong PGP passphrase entered, or private key corrupted.

**Solution**:
1. Verify you're entering the correct PGP passphrase
2. Try logging out and back in to ensure your private key is loaded
3. If still failing, reconfigure Git sync with a new PAT

---

#### "Remote has changes, please pull first"

**Cause**: Git push was rejected because remote repository has newer commits (non-fast-forward).

**Solution**:
1. Click "Pull" to download remote changes first
2. After pull completes, click "Push" again

---

#### "Local has unpushed changes, please push first"

**Cause**: Git pull would require non-fast-forward merge because local has unpushed commits.

**Solution**:
1. Click "Push" to upload your local changes first
2. After push completes, click "Pull" again

---

#### "Sync state is confused / Reset not working"

**Cause**: Local git repository state is inconsistent with remote.

**Solution**:
1. Go to Settings → Git Sync
2. Click "Reset Local" button (nuclear option)
3. This will delete local repo and re-clone from remote
4. **Warning**: All unpushed local changes will be lost

---

#### "git push: permission denied"

**Cause**: Invalid or expired PAT, or insufficient permissions.

**Solution**:
1. Verify your PAT is still valid (not expired or revoked)
2. Check PAT has correct scope:
   - GitHub: `repo` (full control of private repositories)
   - GitLab: `api`, `write_repository`
   - Gitea: `write:repository`
3. Generate a new PAT and update configuration

---

#### "Remote has changes, please pull first"

**Cause**: Git push was rejected because remote repository has newer commits (non-fast-forward).

**Solution**:
1. Click "Pull" to download remote changes first
2. After pull completes, click "Push" again

---

#### "Local has unpushed changes, please push first"

**Cause**: Git pull would require non-fast-forward merge because local has unpushed commits.

**Solution**:
1. Click "Push" to upload your local changes first
2. After push completes, click "Pull" again

---

#### "Sync state is confused / Reset not working"

**Cause**: Local git repository state is inconsistent with remote.

**Solution**:
1. Go to Settings → Git Sync
2. Click "Reset Local" button (nuclear option)
3. This will delete local repo and re-clone from remote
4. **Warning**: All unpushed local changes will be lost

---

#### "Failed to push/pull: authentication failed"

**Cause**: PAT is invalid or repository URL is incorrect.

**Solution**:
1. Verify repository URL is correct and accessible
2. Check that the repository exists and you have access
3. Generate a new PAT and reconfigure

---

#### "No changes to push"

**Cause**: Local database and git repo are in sync (no new commits).

**Solution**: This is informational, not an error. Your data is already synced.

---

#### "This entry was encrypted with a different key"

**Cause**: The entry was encrypted with a different PGP key than your current account. This can happen when:

- Pulling from a git repo that was created from a different WebPass account
- Pulling entries that were encrypted before you regenerated your PGP keypair
- Syncing from someone else's repository

**What Happens**:
- Git pull succeeds and entries are stored in the database
- When you try to view or edit an entry, decryption fails
- A dialog appears offering to re-encrypt the entry

**Solution**:
1. When you see the error dialog, click **"Decrypt & Re-encrypt"**
2. Upload the **original private key file** that was used to encrypt the entry
3. Enter the **passphrase** for that original key
4. The entry will be:
   - Decrypted with the original private key
   - Re-encrypted with your current account's public key
   - Saved back to the server
5. After re-encryption, the entry is usable with your current key

**Don't have the original key?**
- Click **"Skip"** in the dialog
- The entry will remain encrypted (unreadable) until you obtain the original key
- You can re-encrypt later when you have the original private key

**Batch re-encryption:**
If you have many entries with the wrong key, repeat the process for each entry. Alternatively:
1. Export your git repo locally: `git clone <repo-url>`
2. Create a tar.gz: `tar -czf backup.tar.gz .password-store/`
3. Use the **Import** feature with the original private key
4. Import will decrypt all entries and re-encrypt with your current key
5. After import, push to git sync to update the repo

---

### Error Messages Reference

| Error Message | Meaning | Action |
|--------------|---------|--------|
| `git token required` | No PAT provided | Reconfigure Git sync |
| `get config: sql: no rows` | Git sync not configured | Configure Git sync first |
| `init repo: ...` | Failed to clone/init repository | Check repo URL and PAT |
| `git push: ...` | Git push failed | Check PAT permissions, network |
| `git pull: ...` | Git pull failed | Check PAT permissions, network |
| `export password-store: ...` | Failed to write entries | Check server disk space |
| `sync database: ...` | Failed to import entries | Check database integrity |

---

### Debug Mode

To enable verbose logging for Git operations:

1. Server logs are written to stdout/stderr
2. Check server logs for `[GIT PUSH]` or `[GIT PULL]` prefixed messages
3. Look for detailed error messages in the log output

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

**Decision**: No conflict detection. Git's native non-fast-forward errors guide users.

**Implementation**:
- Push fails with "remote has changes, please pull first"
- Pull fails with "local has unpushed changes, please push first"
- User manually resolves by pulling/pushing in correct order
- Reset button available for confused states

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
3. **Server-side import** — add `/api/{fingerprint}/git/import` endpoint

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
- Clear error messages: "remote has changes, please pull first" / "local has unpushed changes, please push first"

---

## Implementation Checklist

- [x] Database schema (`git_config` with `encrypted_pat`, `git_sync_log`)
- [x] sqlc queries
- [x] Git service layer (`srv/git.go`)
- [x] Session token cache
- [x] API endpoints
- [x] Frontend crypto (OpenPGP.js for PAT encryption/decryption)
- [x] Frontend Git Sync UI (push/pull buttons, PGP passphrase prompt)
- [x] Error toasts in UI (show exact error messages)
- [x] Write tests (`srv/git_test.go`)
- [x] E2E tests (`frontend/tests/e2e/git-sync.spec.ts`)

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

## Security Best Practices

### PAT Management

- **Use expirable tokens**: GitHub allows setting expiration dates on PATs
- **Minimal scope**: Only grant `repo` or `write_repository` permissions
- **Rotate regularly**: Regenerate PATs every 3-6 months
- **Revoke compromised tokens**: Immediately revoke if you suspect a breach

### Repository Security

- **Private repositories only**: Never use public repos for password storage
- **Enable 2FA on Git hosting**: Protect your Git account with two-factor authentication
- **Audit access**: Regularly review who has access to your repository
- **Backup your repo**: Download periodic backups of your remote repository

### Client-Side Security

- **Protect your PGP passphrase**: Never share it; use a strong, unique passphrase
- **Lock your device**: Always lock your computer when stepping away
- **Clear session after use**: Use the "Lock" button to clear sensitive data from memory
- **Monitor sync logs**: Regularly check sync history for unexpected activity

---

## FAQ

### Q: Can I use the same repository for multiple users?

**A:** No. Each user has their own encrypted PAT and `.password-store/` directory. Sharing a repository would mix encrypted entries from different users, making decryption impossible.

### Q: What happens if I forget my PGP passphrase?

**A:** You won't be able to decrypt your PAT or sync with Git. You'll need to:
1. Generate a new PAT on your Git hosting service
2. Reconfigure Git sync with the new PAT
3. Your existing entries remain in the database (not affected)

### Q: Can I use SSH instead of HTTPS?

**A:** Not yet. SSH key support is planned for Phase 2. Currently, only HTTPS with PAT is supported.

### Q: How often should I push/pull?

**A:** As needed:
- **Push**: After making important changes, or before switching devices
- **Pull**: When setting up a new device, or to recover from data loss

### Q: What if I accidentally delete an entry and push?

**A:** Git keeps history! You can:
1. Access your Git repository directly (via `git clone`)
2. Browse commit history to find the deleted entry
3. Restore the `.gpg` file manually
4. Pull the restored entry back into WebPass

### Q: Can I sync between multiple devices?

**A:** Yes, but manually:
1. Device A: Push changes to remote
2. Device B: Pull changes from remote
3. If conflicts occur: pull first, then push

### Q: Is the `.password-store/` format compatible with `pass`?

**A:** Yes! The directory structure and `.gpg` files follow the standard `pass` convention. You can:
- Clone your repository and use standard `pass` commands
- Import existing `.password-store/` directories via the Import feature

### Q: What data is stored on the server?

**A:** The server stores:
- **SQLite database**: Encrypted entry blobs (PGP-encrypted)
- **Git config**: Repo URL + PGP-encrypted PAT
- **Git repo clone**: Local copy of `.password-store/` for sync operations

The server **cannot** decrypt any of this data without your PGP private key.

---

## Environment Variables

| Variable        | Default       | Description                          |
|-----------------|---------------|--------------------------------------|
| `GIT_REPO_ROOT` | `.git-repos`  | Base directory for cloned repos      |

---

## Future Enhancements

1. **SSH Key Support**: Store encrypted SSH key, use for git auth
2. **Multi-Device Sync**: Detect and merge concurrent edits
3. **Webhook Integration**: Trigger pull on git push (real-time sync)
4. **CLI Client**: `webpass sync` command for terminal users
5. **Encrypted Commit Messages**: Sign commits with PGP key

---

## References

- [pass (the standard unix password manager)](https://www.passwordstore.org/)
- [Git pass extension](https://git.zx2c4.com/password-store/about/)
- [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
