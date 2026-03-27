# Pure Go Git Implementation (One-Way Sync)

This document describes the simplified one-way sync implementation using the [`go-git`](https://github.com/go-git/go-git) library.

---

## Sync Strategy: One-Way Overwrite

**No merge. No conflicts. Fresh operations every time.**

### Push Flow

```
[PUSH] Delete /data/git-repos/{fingerprint}
[PUSH] Create fresh directory
[PUSH] Export ALL entries from DB to .gpg files
[PUSH] git init
[PUSH] git add --all
[PUSH] git commit -m "Sync: timestamp"
[PUSH] git remote add origin <url>
[PUSH] git push --force origin main
[PUSH] Delete /data/git-repos/{fingerprint}
```

**Result:** Remote = Exact copy of local DB

---

### Pull Flow

```
[PULL] Delete /data/git-repos/{fingerprint}
[PULL] git clone <url> /data/git-repos/{fingerprint}
[PULL] Delete ALL entries from DB
[PULL] Import all .gpg files from cloned repo
[PULL] Delete /data/git-repos/{fingerprint}
```

**Result:** Local DB = Exact copy of remote

---

## Key Design Decisions

### 1. Fresh Operations

**Every push/pull starts fresh:**
- Delete local git directory before operation
- Create new repo or clone from scratch
- Delete directory after operation completes

**Benefits:**
- No stale files
- No leftover state
- Predictable behavior
- Easy to reason about

---

### 2. No Merge Logic

**Traditional sync tries to merge changes:**
- Compare local vs remote
- Detect conflicts
- Merge or fail

**Our approach:**
- Push = overwrite remote with local
- Pull = overwrite local with remote
- Last write wins

**Benefits:**
- No conflict detection needed
- No complex merge logic
- Simpler implementation
- Clear error messages

---

### 3. Force Push

**Push uses `git push --force`:**
- Overwrites remote completely
- No fast-forward checks
- No "pull first" errors

**Warning:** Destructive operation - coordinates required for multi-client

---

### 4. Database Sync

**Pull deletes all DB entries before import:**
- Ensures exact match with remote
- No stale entries
- Deleted files properly removed

**Push exports all DB entries:**
- Complete snapshot
- No incremental updates
- Consistent state

---

## Dependencies

Add to `go.mod`:

```bash
go get github.com/go-git/go-git/v5@latest
```

Import in code:

```go
import (
    "github.com/go-git/go-git/v5"
    "github.com/go-git/go-git/v5/config"
    "github.com/go-git/go-git/v5/plumbing"
    "github.com/go-git/go-git/v5/plumbing/object"
    "github.com/go-git/go-git/v5/plumbing/transport/http"
)
```

---

## Git Operations Mapping

### 1. Cleanup Directory

**Delete `/data/git-repos/{fingerprint}`:**

```go
func cleanupRepoDir(repoRoot, fingerprint string) error {
    repoDir := filepath.Join(repoRoot, fingerprint)
    if err := os.RemoveAll(repoDir); err != nil {
        return fmt.Errorf("cleanup repo dir: %w", err)
    }
    slog.Info("cleaned up repo directory", "dir", repoDir)
    return nil
}
```

---

### 2. Fresh Clone (Pull)

**`git clone <url> <dir>`:**

```go
func cloneRepo(repoDir, repoURL, token string) error {
    // Create parent directory
    if err := os.MkdirAll(filepath.Dir(repoDir), 0700); err != nil {
        return fmt.Errorf("create dir: %w", err)
    }

    // Clone with authentication
    auth := &http.BasicAuth{
        Username: "token",
        Password: token,
    }

    _, err := git.PlainClone(repoDir, false, &git.CloneOptions{
        URL:      repoURL,
        Auth:     auth,
        Progress: nil,
    })
    if err != nil {
        return fmt.Errorf("clone: %w", err)
    }

    slog.Info("cloned remote repository", "url", repoURL, "dir", repoDir)
    return nil
}
```

---

### 3. Fresh Init (Push)

**`git init`:**

```go
func initRepo(repoDir string) (*git.Repository, error) {
    // Create directory
    if err := os.MkdirAll(repoDir, 0700); err != nil {
        return nil, fmt.Errorf("create dir: %w", err)
    }

    // Initialize git repo
    repo, err := git.PlainInit(repoDir, false)
    if err != nil {
        return nil, fmt.Errorf("init: %w", err)
    }

    slog.Info("initialized git repository", "dir", repoDir)
    return repo, nil
}
```

---

### 4. Add Remote

**`git remote add origin <url>`:**

```go
func addRemote(repo *git.Repository, url string) error {
    _, err := repo.CreateRemote(&config.RemoteConfig{
        Name: "origin",
        URLs: []string{url},
    })
    if err != nil {
        return fmt.Errorf("add remote: %w", err)
    }

    slog.Info("added remote origin", "url", url)
    return nil
}
```

---

### 5. Stage All Files

**`git add --all`:**

```go
func stageAll(w *git.Worktree) error {
    err := w.AddWithOptions(&git.AddOptions{All: true})
    if err != nil {
        return fmt.Errorf("git add: %w", err)
    }

    slog.Info("staged all files")
    return nil
}
```

---

### 6. Commit

**`git commit -m "message"`:**

```go
func commit(w *git.Worktree, message string) (plumbing.Hash, error) {
    hash, err := w.Commit(message, &git.CommitOptions{
        Author: &object.Signature{
            Name:  "WebPass",
            Email: "webpass@local",
            When:  time.Now(),
        },
    })
    if err != nil {
        return plumbing.ZeroHash, fmt.Errorf("git commit: %w", err)
    }

    slog.Info("committed changes", "hash", hash.String(), "message", message)
    return hash, nil
}
```

---

### 7. Force Push

**`git push --force origin main`:**

```go
func forcePush(repo *git.Repository, token string) error {
    auth := &http.BasicAuth{
        Username: "token",
        Password: token,
    }

    err := repo.Push(&git.PushOptions{
        RemoteName: "origin",
        Auth:       auth,
        RefSpecs:   []config.RefSpec{config.RefSpec("+refs/heads/main:refs/heads/main")},
        Force:      true,
    })
    if err != nil {
        return fmt.Errorf("git push --force: %w", err)
    }

    slog.Info("pushed --force to remote")
    return nil
}
```

---

### 8. Export Entries (Push)

**Export all DB entries to `.gpg` files:**

```go
func exportPasswordStore(ctx context.Context, q *dbgen.Queries, fingerprint, repoDir string) (int, error) {
    // Get all entries
    entries, err := q.ListEntriesContent(ctx, fingerprint)
    if err != nil {
        return 0, fmt.Errorf("list entries: %w", err)
    }

    // Write each entry to .gpg file
    for _, entry := range entries {
        entryPath := filepath.Join(repoDir, entry.Path+".gpg")
        
        // Create parent directory
        entryDir := filepath.Dir(entryPath)
        if err := os.MkdirAll(entryDir, 0700); err != nil {
            return 0, fmt.Errorf("create dir: %w", err)
        }

        // Write encrypted content
        if err := os.WriteFile(entryPath, entry.Content, 0600); err != nil {
            return 0, fmt.Errorf("write entry %s: %w", entry.Path, err)
        }

        slog.Info("exported entry", "path", entry.Path)
    }

    slog.Info("exported password store", "entries", len(entries))
    return len(entries), nil
}
```

---

### 9. Import Entries (Pull)

**Delete all DB entries, then import from cloned repo:**

```go
func syncDatabase(ctx context.Context, q *dbgen.Queries, fingerprint, repoDir string) (int, error) {
    // Delete all existing entries
    entries, err := q.ListEntries(ctx, fingerprint)
    if err != nil {
        return 0, fmt.Errorf("list entries: %w", err)
    }

    for _, entry := range entries {
        if err := q.DeleteEntry(ctx, dbgen.DeleteEntryParams{
            Fingerprint: fingerprint,
            Path:        entry.Path,
        }); err != nil {
            return 0, fmt.Errorf("delete entry %s: %w", entry.Path, err)
        }
        slog.Info("deleted entry", "path", entry.Path)
    }

    // Walk repo directory and import .gpg files
    count := 0
    err = filepath.Walk(repoDir, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }

        // Skip directories and non-.gpg files
        if info.IsDir() || !strings.HasSuffix(path, ".gpg") {
            return nil
        }

        // Skip .git directory
        if strings.Contains(path, "/.git/") {
            return filepath.SkipDir
        }

        // Get relative path
        relPath, err := filepath.Rel(repoDir, path)
        if err != nil {
            return err
        }

        entryPath := strings.TrimSuffix(relPath, ".gpg")
        entryPath = filepath.ToSlash(entryPath)

        // Read content
        content, err := os.ReadFile(path)
        if err != nil {
            return err
        }

        // Upsert to database
        if err := q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
            Fingerprint: fingerprint,
            Path:        entryPath,
            Content:     content,
        }); err != nil {
            slog.Error("upsert entry", "path", entryPath, "error", err)
            return err
        }

        slog.Info("imported entry", "path", entryPath)
        count++
        return nil
    })

    if err != nil {
        return 0, err
    }

    slog.Info("synced database", "entries", count)
    return count, nil
}
```

---

## Complete Push Implementation

```go
func (g *GitService) Push(ctx context.Context, fingerprint, token string) (*PullResult, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    // Get config
    config, err := g.q.GetGitConfig(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("get config: %w", err)
    }

    repoDir := filepath.Join(g.repoRoot, fingerprint)

    // Step 1: Cleanup before
    slog.Info("[PUSH] Starting git push", "fingerprint", fingerprint)
    if err := cleanupRepoDir(g.repoRoot, fingerprint); err != nil {
        return nil, err
    }

    // Step 2: Create fresh directory
    if err := os.MkdirAll(repoDir, 0700); err != nil {
        return nil, fmt.Errorf("create dir: %w", err)
    }

    // Step 3: Export entries
    count, err := exportPasswordStore(ctx, g.q, fingerprint, repoDir)
    if err != nil {
        return nil, fmt.Errorf("export entries: %w", err)
    }
    slog.Info("[PUSH] Exported entries", "count", count)

    // Step 4: Git init
    repo, err := initRepo(repoDir)
    if err != nil {
        return nil, err
    }

    // Step 5: Stage all
    w, err := repo.Worktree()
    if err != nil {
        return nil, fmt.Errorf("get worktree: %w", err)
    }
    if err := stageAll(w); err != nil {
        return nil, err
    }

    // Step 6: Commit
    commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))
    _, err = commit(w, commitMsg)
    if err != nil {
        return nil, err
    }

    // Step 7: Add remote
    if err := addRemote(repo, config.RepoUrl); err != nil {
        return nil, err
    }

    // Step 8: Force push
    if err := forcePush(repo, token); err != nil {
        return nil, err
    }

    // Step 9: Cleanup after
    if err := cleanupRepoDir(g.repoRoot, fingerprint); err != nil {
        return nil, err
    }

    slog.Info("[PUSH] Finished", "fingerprint", fingerprint, "entries", count)

    entriesChanged := int64(count)
    if err := g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
        Fingerprint:    fingerprint,
        Operation:      "push",
        Status:         "success",
        Message:        &commitMsg,
        EntriesChanged: &entriesChanged,
    }); err != nil {
        slog.Warn("log git sync failed", "error", err)
    }

    return &PullResult{
        Status:         "success",
        Operation:      "push",
        EntriesChanged: count,
        Message:        fmt.Sprintf("synced %d entries", count),
    }, nil
}
```

---

## Complete Pull Implementation

```go
func (g *GitService) Pull(ctx context.Context, fingerprint, token string) (*PullResult, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    // Get config
    config, err := g.q.GetGitConfig(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("get config: %w", err)
    }

    repoDir := filepath.Join(g.repoRoot, fingerprint)

    // Step 1: Cleanup before
    slog.Info("[PULL] Starting git pull", "fingerprint", fingerprint)
    if err := cleanupRepoDir(g.repoRoot, fingerprint); err != nil {
        return nil, err
    }

    // Step 2: Clone remote
    if err := cloneRepo(repoDir, config.RepoUrl, token); err != nil {
        return nil, err
    }

    // Step 3: Delete all DB entries and import from clone
    count, err := syncDatabase(ctx, g.q, fingerprint, repoDir)
    if err != nil {
        return nil, fmt.Errorf("sync database: %w", err)
    }

    // Step 4: Cleanup after
    if err := cleanupRepoDir(g.repoRoot, fingerprint); err != nil {
        return nil, err
    }

    slog.Info("[PULL] Finished", "fingerprint", fingerprint, "entries", count)

    entriesChanged := int64(count)
    msg := fmt.Sprintf("synced %d entries from remote", count)
    if err := g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
        Fingerprint:    fingerprint,
        Operation:      "pull",
        Status:         "success",
        Message:        &msg,
        EntriesChanged: &entriesChanged,
    }); err != nil {
        slog.Warn("log git sync failed", "error", err)
    }

    return &PullResult{
        Status:         "success",
        Operation:      "pull",
        EntriesChanged: count,
        Message:        msg,
    }, nil
}
```

---

## Logging

All operations log to console (`docker logs webpass`):

**Format:**
```
[PUSH] Starting git push for fingerprint=abc123
[PUSH] Cleaning up /data/git-repos/abc123
[PUSH] Exporting 5 entries from database to disk
[PUSH]   - email.gpg
[PUSH]   - work/database.gpg
[PUSH] Initialized git repository
[PUSH] Staged all files
[PUSH] Committed with message: "Sync: 2026-03-27T04:30:00Z"
[PUSH] Added remote origin: https://github.com/user/repo.git
[PUSH] Pushed --force to origin/main
[PUSH] Cleaning up /data/git-repos/abc123
[PUSH] Finished - synced 5 entries
```

**Key information:**
- Operation type: `[PUSH]` or `[PULL]`
- Fingerprint for traceability
- File paths for debugging
- Entry counts
- Error messages with context

---

## Summary

| Aspect | Implementation |
|--------|---------------|
| **Push** | Fresh export + force push |
| **Pull** | Fresh clone + import |
| **Cleanup** | Before and after each operation |
| **State** | No persistent local git state |
| **Conflicts** | None (last write wins) |
| **History** | Snapshot per push |
| **Complexity** | Minimal |

This simplified approach trades git history preservation for simplicity and reliability.
