# 🔄 Git Sync Feature (One-Way Sync)

Sync encrypted password entries to a private Git repository with **simplified one-way sync**.

---

## Overview

Git sync allows users to backup and synchronize their encrypted password store to any Git hosting service (GitHub, GitLab, Gitea, etc.). 

**Sync Model**: One-way overwrite sync with fresh clone/export.

- **Pull**: Remote → Local (clone remote, replace local DB)
- **Push**: Local → Remote (export local DB, force-push to remote)
- **No merge conflicts** - Last write wins
- **Fresh operations** - Local git repo is temporary, cleaned before/after each operation
- **Per-user configuration** - Each user has their own repo URL
- **PGP-encrypted PAT** - Encrypted with user's PGP public key

---

## Sync Behavior

### Pull (Download from Remote)

**"Remote is source of truth"**

1. Delete local git repo directory (`/data/git-repos/{fingerprint}`)
2. Fresh clone from remote
3. Delete ALL entries in local database
4. Import exactly what's in cloned repo
5. Delete local git repo directory (cleanup)

**Result:** Local DB = Exact copy of remote

---

### Push (Upload to Remote)

**"Local DB is source of truth"**

1. Delete local git repo directory (`/data/git-repos/{fingerprint}`)
2. Create fresh git repo
3. Export ALL entries from local DB
4. Commit and `git push --force` (overwrite remote)
5. Delete local git repo directory (cleanup)

**Result:** Remote repo = Exact copy of local DB

---

## Example Scenarios

### Scenario 1: Pull with Deleted File

| Before Pull | After Pull |
|-------------|------------|
| **Local DB:** fileA, fileB | **Local DB:** fileA |
| **Remote:** fileA | **Remote:** fileA |

**What happens:**
- fileB is deleted from local DB (not in remote)
- Local matches remote exactly

---

### Scenario 2: Push with New/Deleted Files

| Before Push | After Push |
|-------------|------------|
| **Local DB:** fileA, fileB, fileC | **Local DB:** fileA, fileB, fileC |
| **Remote:** fileA, fileB, fileD | **Remote:** fileA, fileB, fileC |

**What happens:**
- fileA, fileB → Unchanged
- fileC → Added to remote (new in local DB)
- fileD → Deleted from remote (not in local DB)

---

### Scenario 3: Multi-Client (Last Write Wins)

```
Client A: Push (fileA, fileB) → Remote becomes: fileA, fileB
Client B: Push (fileA, fileC) → Remote becomes: fileA, fileC
```

**Result:** Client B's push overwrites Client A's changes

**Warning:** This is a **destructive** operation. Coordinate pushes across clients.

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
│  + Git service (fresh clone/export)             │
│  + Session token cache (5-min)                  │
│  + /data/git-repos/:fingerprint/ (temporary)    │
│  + git_config.encrypted_pat (PGP-encrypted)     │
└──────────────┬──────────────────────────────────┘
               │ HTTPS + PAT (plaintext)
┌──────────────▼──────────────────────────────────┐
│  Remote Git Repo (GitHub/GitLab/etc.)           │
│  ├── email.gpg                                  │
│  ├── work/database.gpg                          │
│  └── social/twitter.gpg                         │
└─────────────────────────────────────────────────┘
```

**Key Differences from Traditional Sync:**
- No `.password-store/` subdirectory - files at repo root
- No merge operations - fresh clone/export every time
- No persistent local git state - cleaned before/after
- Compatible with standard `pass` CLI structure

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

## Data Model (SQLite)

```sql
-- Git configuration per user
CREATE TABLE git_config (
    fingerprint       TEXT PRIMARY KEY REFERENCES users(fingerprint) ON DELETE CASCADE,
    repo_url          TEXT NOT NULL,               -- HTTPS URL to git repo
    encrypted_pat     TEXT NOT NULL,               -- PGP-encrypted PAT blob
    branch            TEXT NOT NULL DEFAULT 'HEAD',-- Branch name (HEAD = auto-detect)
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

---

## API Endpoints

All endpoints require JWT authentication.

| Method | Path                          | Body                                      | Description                              |
|--------|-------------------------------|-------------------------------------------|------------------------------------------|
| GET    | `/api/{fingerprint}/git/status`   | —                                         | Get sync status (repo URL, has encrypted PAT) |
| POST   | `/api/{fingerprint}/git/config`   | `{ repo_url, encrypted_pat }`             | Configure git sync (PGP-encrypted PAT) |
| POST   | `/api/{fingerprint}/git/session`  | `{ token }`                               | Set plaintext git token for current session |
| POST   | `/api/{fingerprint}/git/push`     | `{ token? }`                              | Manual push to remote (force overwrite) |
| POST   | `/api/{fingerprint}/git/pull`     | `{ token? }`                              | Manual pull from remote (fresh clone) |
| GET    | `/api/{fingerprint}/git/log`      | —                                         | Get sync operation history (last 50)     |

---

## Git Repository Structure

```
repo-root/
├── .git/
├── email.gpg
├── work/
│   └── database.gpg
└── social/
    └── twitter.gpg
```

- All files are `.gpg` encrypted blobs (client-side PGP encryption)
- Files at repo root (no `.password-store/` subdirectory)
- Compatible with standard `pass` CLI after cloning

---

## Technical Flows

### Pull Flow (Fresh Clone)

```
[PULL] Starting git pull for fingerprint=abc123
[PULL] Cleaning up /data/git-repos/abc123
[PULL] Cloning remote repository: https://github.com/user/repo.git
[PULL] Cloned to /data/git-repos/abc123
[PULL] Deleting all entries from database for fingerprint=abc123
[PULL] Deleted 5 entries
[PULL] Importing entries from cloned repo
[PULL]   - email.gpg
[PULL]   - work/database.gpg
[PULL] Imported 3 entries
[PULL] Cleaning up /data/git-repos/abc123
[PULL] Finished - synced 3 entries
```

**Steps:**
1. Delete `/data/git-repos/{fingerprint}` (cleanup before)
2. Fresh clone remote to `/data/git-repos/{fingerprint}`
3. Delete ALL entries in local database
4. Walk cloned repo, import all `.gpg` files
5. Delete `/data/git-repos/{fingerprint}` (cleanup after)

---

### Push Flow (Fresh Export + Force Push)

```
[PUSH] Starting git push for fingerprint=abc123
[PUSH] Cleaning up /data/git-repos/abc123
[PUSH] Creating fresh directory /data/git-repos/abc123
[PUSH] Exporting 5 entries from database to disk
[PUSH]   - email.gpg
[PUSH]   - work/database.gpg
[PUSH]   - social/twitter.gpg
[PUSH] Initializing git repository
[PUSH] Staging all files
[PUSH] Committing with message: "Sync: 2026-03-27T04:30:00Z"
[PUSH] Adding remote origin: https://github.com/user/repo.git
[PUSH] Pushing --force to origin/main
[PUSH] Push completed successfully
[PUSH] Cleaning up /data/git-repos/abc123
[PUSH] Finished - synced 5 entries
```

**Steps:**
1. Delete `/data/git-repos/{fingerprint}` (cleanup before)
2. Create fresh `/data/git-repos/{fingerprint}`
3. Export ALL entries from database to `.gpg` files
4. `git init`, `git add --all`, `git commit`
5. `git remote add origin`, `git push --force origin main`
6. Delete `/data/git-repos/{fingerprint}` (cleanup after)

---

## Branch Detection

**Default branch auto-detection** (branch = "HEAD"):

1. Read remote HEAD symbolic reference
2. If HEAD not found → try `main`
3. If `main` not found → try `master`
4. Use first available branch

**Manual branch config:**
- Set specific branch name (e.g., `main`, `dev`)
- Overrides auto-detection

---

## Account Deletion and Git Cleanup

When a user **permanently deletes their account**:

1. **Git repository folder deleted** — `/data/git-repos/{fingerprint}/` is removed
2. **All database entries deleted** — SQLite entries removed
3. **User account deleted** — User record removed from database
4. **Local data cleared** — Browser IndexedDB cleared

**Note:** This only deletes the local git repository on the server. The remote Git repository (GitHub, GitLab, etc.) is NOT affected. Users should manually delete their remote repository if desired.

---

## Troubleshooting

### Common Issues

#### "Remote repository not found"

**Cause:** Invalid URL or repository doesn't exist.

**Solution:**
1. Verify repository URL is correct
2. Ensure repository exists on remote (GitHub/GitLab/etc.)
3. Check PAT has correct permissions

---

#### "Authentication failed"

**Cause:** Invalid or expired PAT.

**Solution:**
1. Generate new PAT with correct scope:
   - GitHub: `repo` (full control of private repositories)
   - GitLab: `api`, `write_repository`
   - Gitea: `write:repository`
2. Update configuration with new PAT

---

#### "Last write wins - data loss"

**Cause:** Two clients push different changes; second overwrites first.

**Solution:**
1. Coordinate pushes across clients
2. Always pull before pushing on new devices
3. Consider this a "backup" not "multi-user sync"

---

#### "Pushed files disappeared on pull"

**Cause:** Another client pushed after you; their push overwrote yours.

**Solution:**
1. Pull latest from remote
2. Re-add your files locally
3. Push again (when no one else is pushing)

---

## Trade-offs

### Advantages

| Benefit | Description |
|---------|-------------|
| **Simple** | Easy to understand: pull = download, push = upload |
| **No conflicts** | Never need to resolve merge conflicts |
| **Clean state** | Fresh clone/export every time, no stale files |
| **Deleted files handled** | Properly removed on sync |

### Disadvantages

| Risk | Description |
|------|-------------|
| **Last write wins** | Multi-client pushes can overwrite each other |
| **No history** | Git history shows snapshots, not incremental changes |
| **Destructive** | Mistakes propagate immediately |
| **No recovery** | Can't easily recover old versions from git history |

---

## Best Practices

1. **Pull before pushing** on new devices or after long absence
2. **One client at a time** - avoid simultaneous pushes
3. **Use as backup** - not for real-time multi-user sync
4. **Verify after push** - pull on another device to confirm
5. **Keep remote private** - contains encrypted password blobs

---

## Implementation Notes

### Logging

All operations log to console (`docker logs webpass`):

- **Prefix**: `[PUSH]` or `[PULL]` for easy filtering
- **Fingerprint**: Always logged for traceability
- **Paths**: Full paths for debugging
- **Counts**: Number of entries processed
- **Errors**: Clear error messages with context

### Cleanup

Local git repo directory is **always temporary**:

- Deleted **before** operation (fresh start)
- Deleted **after** operation (no leftover state)
- `/data/git-repos/` stays empty between operations

### Fresh Operations

Every push/pull is isolated:

- No reliance on previous git state
- No incremental updates
- No merge logic
- Predictable, repeatable behavior
