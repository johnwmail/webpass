# Pure Go Git Implementation

This document maps all `git` CLI operations in `srv/git.go` to their pure Go equivalents using the [`go-git`](https://github.com/go-git/go-git) library.

---

## Zero-Knowledge Architecture

**Important: Content comparison is meaningless for encrypted password entries.**

### Why Content Comparison Fails

WebPass uses a **zero-knowledge architecture**: all password entries are PGP-encrypted client-side before being sent to the server. The server stores encrypted blobs but cannot decrypt them.

This creates a fundamental limitation:

| Issue | Explanation |
|-------|-------------|
| **Encrypted blobs differ randomly** | Same password encrypted twice produces different ciphertexts (different timestamps, random padding in PGP) |
| **Different PGP keys** | Remote repo may contain entries encrypted with keys the server doesn't have (imported from another account, old key before regeneration) |
| **Server has no private key** | By design, server cannot decrypt entries to compare plaintext content |

### Example Scenario

```
User A encrypts "mysecret123" → blob_A = "PGP_ENCRYPTED_A..."
User B encrypts "mysecret123" → blob_B = "PGP_ENCRYPTED_B..."

blob_A != blob_B  (even though plaintext is identical!)
```

### Simplified Sync Strategy

Since content comparison is impossible and per-file conflict resolution is complex, the sync strategy is simplified:

| Operation | Behavior |
|-----------|----------|
| **Push** | Direct push. If remote has changes → error "Please pull first" |
| **Pull** | Direct pull (fast-forward only). If local has changes → error "Please push first" |
| **Reset** | Discard local, re-clone from remote (nuclear option) |

**No conflict detection. No per-file selection. Clear error messages guide users.**

---

## Strategy: Simplified Direct Operations

**No temp directories. No per-file conflict resolution. Clear error messages guide users.**

### Push Flow

```
Try direct repo.Push()
  ├─ Success → Done ✅
  └─ ErrNonFastForwardUpdate → Error: "Remote has changes. Please pull first."
```

### Pull Flow

```
Try direct w.Pull(FastForwardOnly: true)
  ├─ Success → Sync DB → Done ✅
  ├─ NoErrAlreadyUpToDate → Done ✅
  └─ ErrNonFastForwardUpdate → Error: "Local has unpushed changes. Please push first."
```

### Reset Operation (Nuclear Option)

```
User clicks "Reset Local" button:
  1. Delete local repo directory
  2. Re-clone from remote
  3. Sync DB with cloned state
```

### When to Use Reset

| Scenario | Recommended Action |
|----------|-------------------|
| Remote has newer commits | Pull first, then push |
| Local has unpushed commits | Push first, then pull |
| Sync state is confused | Reset Local (re-clone) |
| Switching devices | Reset Local on new device |
| Remote repo was recreated | Reset Local |

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

## Git CLI to go-git Mapping

### 1. `git clone <url> .`

**Current (CLI):**
```go
func (g *GitService) initRepo(fingerprint, repoURL, token string) error {
    repoDir := g.repoDir(fingerprint)
    cloneURL := g.authURL(repoURL, token)
    if err := g.runGitCommand(repoDir, "clone", cloneURL, "."); err != nil {
        // handle error
    }
}
```

**Replacement (go-git):**
```go
func (g *GitService) initRepo(fingerprint, repoURL, token string) error {
    repoDir := g.repoDir(fingerprint)
    
    // Check if repo exists
    if _, err := os.Stat(repoDir); err == nil {
        return nil // Already initialized
    }
    
    // Create directory
    if err := os.MkdirAll(repoDir, 0700); err != nil {
        return fmt.Errorf("create dir: %w", err)
    }
    
    // Clone with authentication
    auth := &http.BasicAuth{
        Username: "token", // Username can be anything for PAT
        Password: token,
    }
    
    _, err := git.PlainClone(repoDir, false, &git.CloneOptions{
        URL:      repoURL,
        Auth:     auth,
        Progress: nil, // Set to os.Stdout for debugging
    })
    if err != nil {
        return fmt.Errorf("clone: %w", err)
    }
    
    return nil
}
```

---

### 2. `git init`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "init"); err != nil {
    return fmt.Errorf("init: %w", err)
}
```

**Replacement (go-git):**
```go
_, err := git.PlainInit(repoDir, false)
if err != nil {
    return fmt.Errorf("init: %w", err)
}
```

---

### 3. `git checkout -b main`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "checkout", "-b", "main"); err != nil {
    return fmt.Errorf("create main branch: %w", err)
}
```

**Replacement (go-git):**
```go
// Create and checkout main branch
err := repo.CreateBranch(&config.Branch{
    Name: "main",
})
if err != nil {
    return fmt.Errorf("create main branch: %w", err)
}

// Checkout the branch
w, err := repo.Worktree()
if err != nil {
    return err
}
err = w.Checkout(&git.CheckoutOptions{
    Branch: plumbing.NewBranchReferenceName("main"),
    Create: true,
})
if err != nil {
    return fmt.Errorf("checkout main: %w", err)
}
```

---

### 4. `git remote add origin <url>`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "remote", "add", "origin", repoURL); err != nil {
    return fmt.Errorf("add remote: %w", err)
}
```

**Replacement (go-git):**
```go
_, err := repo.CreateRemote(&config.RemoteConfig{
    Name: "origin",
    URLs: []string{repoURL},
})
if err != nil {
    return fmt.Errorf("add remote: %w", err)
}
```

---

### 5. `git remote set-url origin <url>`

**Current (CLI):**
```go
// For push
pushURL := g.authURL(config.RepoUrl, token)
if err := g.runGitCommand(repoDir, "remote", "set-url", "origin", pushURL); err != nil {
    return fmt.Errorf("set remote url: %w", err)
}
```

**Replacement (go-git):**
```go
// Update remote URL with auth
remote, err := repo.Remote("origin")
if err != nil {
    return fmt.Errorf("get remote: %w", err)
}

// Remove and re-add with new URL
err = repo.DeleteRemote("origin")
if err != nil {
    return err
}

_, err = repo.CreateRemote(&config.RemoteConfig{
    Name: "origin",
    URLs: []string{config.RepoUrl}, // URL stored in config
})
if err != nil {
    return err
}

// Auth is passed during Push/Fetch operations, not in remote URL
```

**Note:** With go-git, authentication is passed during `Push()`/`Fetch()`/`Pull()` operations, not embedded in the remote URL. This is cleaner and more secure.

---

### 6. `git add -A .`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "add", "-A", "."); err != nil {
    return fmt.Errorf("git add: %w", err)
}
```

**Replacement (go-git):**
```go
w, err := repo.Worktree()
if err != nil {
    return fmt.Errorf("get worktree: %w", err)
}

// Add all changes
err = w.AddWithOptions(&git.AddOptions{All: true})
if err != nil {
    return fmt.Errorf("git add: %w", err)
}
```

---

### 7. `git status --porcelain`

**Current (CLI):**
```go
statusCmd := exec.Command("git", "status", "--porcelain")
statusCmd.Dir = repoDir
output, err := statusCmd.Output()
if err != nil {
    return nil, fmt.Errorf("git status: %w", err)
}

// If no changes, skip commit
if len(output) == 0 {
    return &PullResult{Status: "success", Operation: "push", Message: "no changes to push"}, nil
}
```

**Replacement (go-git):**
```go
w, err := repo.Worktree()
if err != nil {
    return nil, fmt.Errorf("get worktree: %w", err)
}

status, err := w.Status()
if err != nil {
    return nil, fmt.Errorf("git status: %w", err)
}

// If no changes, skip commit
if status.IsClean() {
    return &PullResult{Status: "success", Operation: "push", Message: "no changes to push"}, nil
}
```

---

### 8. `git config user.email` and `git config user.name`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "config", "user.email", "webpass@local"); err != nil {
    return nil, fmt.Errorf("git config email: %w", err)
}
if err := g.runGitCommand(repoDir, "config", "user.name", "WebPass"); err != nil {
    return nil, fmt.Errorf("git config name: %w", err)
}
```

**Replacement (go-git):**
```go
// Set in commit options, not globally
commitOpts := &git.CommitOptions{
    Author: &object.Signature{
        Name:  "WebPass",
        Email: "webpass@local",
        When:  time.Now(),
    },
}
```

---

### 9. `git commit -m "<message>"`

**Current (CLI):**
```go
commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))
if err := g.runGitCommand(repoDir, "commit", "-m", commitMsg); err != nil {
    return nil, fmt.Errorf("git commit: %w", err)
}
```

**Replacement (go-git):**
```go
w, err := repo.Worktree()
if err != nil {
    return nil, fmt.Errorf("get worktree: %w", err)
}

commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))

hash, err := w.Commit(commitMsg, &git.CommitOptions{
    Author: &object.Signature{
        Name:  "WebPass",
        Email: "webpass@local",
        When:  time.Now(),
    },
})
if err != nil {
    return nil, fmt.Errorf("git commit: %w", err)
}

slog.Info("committed changes", "hash", hash.String())
```

---

### 10. `git push origin main`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "push", "origin", "main"); err != nil {
    errMsg := err.Error()
    _ = g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
        Fingerprint: fingerprint,
        Operation:   "push",
        Status:      "failed",
        Message:     &errMsg,
    })
    return nil, fmt.Errorf("git push: %w", err)
}
```

**Replacement (go-git) - Simplified Direct Push:**

```go
func (g *GitService) Push(ctx context.Context, fingerprint string, token string) (*PullResult, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    config, err := g.q.GetGitConfig(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("get config: %w", err)
    }
    if token == "" {
        return nil, errors.New("git token required")
    }

    repoDir := g.repoDir(fingerprint)
    repo, err := git.PlainOpen(repoDir)
    if err != nil {
        return nil, fmt.Errorf("open repo: %w", err)
    }

    // Export database entries to .password-store directory
    if err := g.exportPasswordStore(ctx, fingerprint); err != nil {
        return nil, fmt.Errorf("export password store: %w", err)
    }

    // Stage all changes
    w, err := repo.Worktree()
    if err != nil {
        return nil, fmt.Errorf("get worktree: %w", err)
    }

    err = w.AddWithOptions(&git.AddOptions{All: true})
    if err != nil {
        return nil, fmt.Errorf("git add: %w", err)
    }

    // Check if there are any changes to commit
    status, err := w.Status()
    if err != nil {
        return nil, fmt.Errorf("git status: %w", err)
    }

    // If no changes, skip commit
    if status.IsClean() {
        slog.Info("git push: no changes to push", "fingerprint", fingerprint)
        return &PullResult{
            Status:    "success",
            Operation: "push",
            Message:   "no changes to push",
        }, nil
    }

    // Commit changes
    commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))
    hash, err := w.Commit(commitMsg, &git.CommitOptions{
        Author: &object.Signature{
            Name:  "WebPass",
            Email: "webpass@local",
            When:  time.Now(),
        },
    })
    if err != nil {
        return nil, fmt.Errorf("git commit: %w", err)
    }
    slog.Info("committed changes", "hash", hash.String())

    // Push with authentication
    auth := &http.BasicAuth{Username: "token", Password: token}
    err = repo.Push(&git.PushOptions{
        RemoteName: "origin",
        Auth:       auth,
        RefSpecs:   []config.RefSpec{config.RefSpec("+refs/heads/main:refs/heads/main")},
    })

    if err != nil {
        if err == git.ErrNonFastForwardUpdate {
            // Remote has newer commits - user must pull first
            return nil, errors.New("remote has changes, please pull first")
        }
        // Log failure
        errMsg := err.Error()
        _ = g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
            Fingerprint: fingerprint,
            Operation:   "push",
            Status:      "failed",
            Message:     &errMsg,
        })
        return nil, fmt.Errorf("git push: %w", err)
    }

    // Log success
    var entriesChanged int64 = 1
    if err := g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
        Fingerprint:    fingerprint,
        Operation:      "push",
        Status:         "success",
        Message:        &commitMsg,
        EntriesChanged: &entriesChanged,
    }); err != nil {
        slog.Warn("log git sync failed", "error", err)
    }

    slog.Info("pushed to remote", "fingerprint", fingerprint)
    return &PullResult{Status: "success", Operation: "push", Message: "pushed to remote"}, nil
}
```

| Aspect | Behavior |
|--------|----------|
| **When** | No conflicts (fast-forward) |
| **History** | Preserved |
| **Speed** | Fast |
| **Error** | "Remote has changes, please pull first" |

---

### 11. `git fetch origin`

**Current (CLI):**
```go
if err := g.runGitCommand(repoDir, "fetch", "origin"); err != nil {
    return nil, fmt.Errorf("git fetch: %w", err)
}
```

**Replacement (go-git):**
```go
err = repo.Fetch(&git.FetchOptions{
    RemoteName: "origin",
    Auth: &http.BasicAuth{
        Username: "token",
        Password: token,
    },
    Progress: nil,
    RefSpecs: []config.RefSpec{
        config.RefSpec("+refs/heads/*:refs/remotes/origin/*"),
    },
})
if err != nil && err != git.NoErrAlreadyUpToDate {
    return nil, fmt.Errorf("git fetch: %w", err)
}
```

---

### 12. `git pull --ff-only origin main`

**Current (CLI):**
```go
pullErr = g.runGitCommand(repoDir, "pull", "--ff-only", "origin", "main")
```

**Replacement (go-git) - Simplified Direct Pull:**

Note: go-git's `Pull()` doesn't have a `FastForwardOnly` option and will create merge commits by default. We manually check if fast-forward is possible before pulling.

```go
func (g *GitService) Pull(ctx context.Context, fingerprint string, token string) (*PullResult, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    config, err := g.q.GetGitConfig(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("get config: %w", err)
    }
    if token == "" {
        return nil, errors.New("git token required")
    }

    repoDir := g.repoDir(fingerprint)
    repo, err := git.PlainOpen(repoDir)
    if err != nil {
        return nil, fmt.Errorf("open repo: %w", err)
    }

    // Pull with authentication
    auth := &http.BasicAuth{Username: "token", Password: token}

    // First, fetch to check remote state
    err = repo.Fetch(&git.FetchOptions{
        RemoteName: "origin",
        Auth:       auth,
    })

    if err != nil && err != git.NoErrAlreadyUpToDate {
        return nil, fmt.Errorf("git fetch: %w", err)
    }

    // Check if we can fast-forward by comparing local and remote refs
    head, err := repo.Head()
    if err != nil {
        return nil, fmt.Errorf("get HEAD: %w", err)
    }

    remoteRef, err := repo.Reference(plumbing.NewRemoteReferenceName("origin", "main"), true)
    if err != nil {
        return nil, fmt.Errorf("get remote ref: %w", err)
    }

    // If local HEAD equals remote, already up to date
    if head.Hash() == remoteRef.Hash() {
        return &PullResult{
            Status:    "success",
            Operation: "pull",
            Message:   "already up to date",
        }, nil
    }

    // Check if local HEAD is an ancestor of remote (can fast-forward)
    // Walk commit history from remote to see if we find local HEAD
    isAncestor := false
    commitIter, err := repo.Log(&git.LogOptions{From: remoteRef.Hash()})
    if err == nil {
        defer commitIter.Close()
        _ = commitIter.ForEach(func(c *object.Commit) error {
            if c.Hash == head.Hash() {
                isAncestor = true
                return errors.New("found") // Stop iteration
            }
            return nil
        })
    }

    if !isAncestor {
        // Local has commits that aren't in remote - can't fast-forward
        return nil, errors.New("local has unpushed changes, please push first")
    }

    // Fast-forward is possible - do the pull
    w, err := repo.Worktree()
    if err != nil {
        return nil, fmt.Errorf("get worktree: %w", err)
    }

    err = w.Pull(&git.PullOptions{
        RemoteName: "origin",
        Auth:       auth,
    })

    if err != nil {
        if err == git.NoErrAlreadyUpToDate {
            return &PullResult{
                Status:    "success",
                Operation: "pull",
                Message:   "already up to date",
            }, nil
        }
        return nil, fmt.Errorf("git pull: %w", err)
    }

    // Sync database with updated worktree
    entriesChanged, err := g.syncDatabase(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("sync database: %w", err)
    }

    // Log success...
    return &PullResult{
        Status:         "success",
        Operation:      "pull",
        EntriesChanged: entriesChanged,
        Message:        fmt.Sprintf("pulled %d entries from remote", entriesChanged),
    }, nil
}
```

| Aspect | Behavior |
|--------|----------|
| **When** | Local is behind remote (fast-forward possible) |
| **Error** | "Local has unpushed changes, please push first" if local has commits not in remote |
| **Already up-to-date** | Returns success with message "already up to date" |

---

### 13. Reset (Re-clone from Remote)

**New operation** - Not a git CLI command, but a helper function for the "nuclear option".

**Use case:** When sync state is confused or user wants to discard local and re-clone from remote.

**Replacement (go-git):**

```go
func (g *GitService) Reset(ctx context.Context, fingerprint string, token string) (*PullResult, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    config, err := g.q.GetGitConfig(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("get config: %w", err)
    }
    if token == "" {
        return nil, errors.New("git token required")
    }

    repoDir := g.repoDir(fingerprint)

    // Delete local repo directory
    if err := os.RemoveAll(repoDir); err != nil {
        return nil, fmt.Errorf("remove local repo: %w", err)
    }
    slog.Info("deleted local repo", "dir", repoDir)

    // Re-clone from remote
    auth := &http.BasicAuth{Username: "token", Password: token}
    _, err = git.PlainClone(repoDir, false, &git.CloneOptions{
        URL:  config.RepoUrl,
        Auth: auth,
    })
    if err != nil {
        return nil, fmt.Errorf("clone from remote: %w", err)
    }
    slog.Info("cloned from remote", "fingerprint", fingerprint)

    // Sync database with cloned state
    entriesChanged, err := g.syncDatabase(ctx, fingerprint)
    if err != nil {
        return nil, fmt.Errorf("sync database: %w", err)
    }

    return &PullResult{
        Status:         "success",
        Operation:      "reset",
        EntriesChanged: entriesChanged,
        Message:        fmt.Sprintf("reset and synced %d entries from remote", entriesChanged),
    }, nil
}
```

| Aspect | Behavior |
|--------|----------|
| **When** | Sync state confused, switching devices, remote recreated |
| **Effect** | Discards all local changes |
| **Speed** | Slow (full clone) |
| **Warning** | All unpushed local changes will be lost |

---

### 14. `git ls-tree -r --name-only origin/main -- .password-store`

**Current (CLI):**
```go
cmd := exec.Command("git", "ls-tree", "-r", "--name-only", "origin/main", "--", ".password-store")
cmd.Dir = repoDir
remoteOutput, err := cmd.Output()
if err != nil {
    return conflicts, nil
}

remoteFiles := strings.Split(strings.TrimSpace(string(remoteOutput)), "\n")
```

**Replacement (go-git):**
```go
// Get origin/main reference
remoteRef, err := repo.Reference(
    plumbing.NewRemoteReferenceName("origin", "main"),
    true,
)
if err != nil {
    return nil, err // Remote might not exist yet
}

// Get commit object
commit, err := repo.CommitObject(remoteRef.Hash())
if err != nil {
    return nil, fmt.Errorf("get commit: %w", err)
}

// Get tree
tree, err := commit.Tree()
if err != nil {
    return nil, fmt.Errorf("get tree: %w", err)
}

// Build set of remote file PATHS
// In zero-knowledge model, we only compare paths, not content
remoteFileSet := make(map[string]bool)
err = tree.Files().ForEach(func(f *object.File) error {
    if strings.HasSuffix(f.Name, ".gpg") && strings.HasPrefix(f.Name, ".password-store/") {
        path := strings.TrimPrefix(f.Name, ".password-store/")
        path = strings.TrimSuffix(path, ".gpg")
        remoteFileSet[path] = true
    }
    return nil
})
if err != nil {
    return nil, fmt.Errorf("walk tree: %w", err)
}
```

**Note:** Zero-knowledge architecture means the server cannot compare encrypted content. Path comparison is used only for informational purposes (e.g., showing what files exist on remote).

---

### 15. `git show origin/main:<path>`

**Use case:** Read a file from a specific commit (returns encrypted blob - server cannot decrypt).

**Replacement (go-git):**
```go
// Get origin/main reference
remoteRef, err := repo.Reference(
    plumbing.NewRemoteReferenceName("origin", "main"),
    true,
)
if err != nil {
    return nil, err
}

// Get commit
commit, err := repo.CommitObject(remoteRef.Hash())
if err != nil {
    return nil, err
}

// Get file from commit
file, err := commit.File(remotePath)
if err != nil {
    return nil, err
}

// Read content (returns encrypted blob - server cannot decrypt)
remoteContent, err := file.Contents()
if err != nil {
    return nil, err
}
```

**Note:** Content is encrypted - can only be decrypted by client with private key.

---

### 16. `git log -1 --format=%cI -- <file>`

**Current (CLI):**
```go
// Get local commit time
localTimeCmd := exec.Command("git", "log", "-1", "--format=%cI", "--", localFile)
localTimeCmd.Dir = repoDir
localTimeOutput, err := localTimeCmd.Output()
if err == nil {
    conflict.LocalTime = strings.TrimSpace(string(localTimeOutput))
}

// Get remote commit time
remoteTimeCmd := exec.Command("git", "log", "-1", "--format=%cI", "--", remotePath)
remoteTimeCmd.Dir = repoDir
remoteTimeOutput, err := remoteTimeCmd.Output()
if err == nil {
    conflict.RemoteTime = strings.TrimSpace(string(remoteTimeOutput))
}
```

**Replacement (go-git):**
```go
// Helper function to get commit time for a file
func (g *GitService) getFileCommitTime(repo *git.Repository, filePath string, remote bool) (string, error) {
    var fromHash plumbing.Hash
    var err error

    if remote {
        ref, err := repo.Reference(
            plumbing.NewRemoteReferenceName("origin", "main"),
            true,
        )
        if err != nil {
            return "", err
        }
        fromHash = ref.Hash()
    } else {
        ref, err := repo.Head()
        if err != nil {
            return "", err
        }
        fromHash = ref.Hash()
    }

    // Get commit log for specific file
    commitIter, err := repo.Log(&git.LogOptions{
        FileName: &filePath,
        From:     fromHash,
    })
    if err != nil {
        return "", err
    }

    // Get most recent commit
    commit, err := commitIter.Next()
    if err != nil {
        return "", err
    }

    // Return RFC3339 timestamp (equivalent to %cI)
    return commit.Committer.When.Format(time.RFC3339), nil
}
```

---

## Complete Helper Function Removal

### Remove `runGitCommand`

**Current:**
```go
func (g *GitService) runGitCommand(dir string, args ...string) error {
    cmd := exec.Command("git", args...)
    cmd.Dir = dir
    cmd.Stdout = nil
    cmd.Stderr = nil
    return cmd.Run()
}
```

**Action:** Delete this function entirely - no longer needed.

---

### Remove `authURL`

**Current:**
```go
func (g *GitService) authURL(repoURL, token string) string {
    // Convert https://github.com/user/repo.git to https://token@github.com/user/repo.git
    if strings.HasPrefix(repoURL, "https://") {
        return strings.Replace(repoURL, "https://", "https://"+token+"@", 1)
    }
    return repoURL
}
```

**Action:** Delete this function - authentication is now passed via `http.BasicAuth` struct.

---

## Import Changes

### Before:
```go
import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "log/slog"
    "os"
    "os/exec"  // REMOVE
    "path/filepath"
    "strings"
    "sync"
    "time"

    "srv.exe.dev/db/dbgen"
)
```

### After:
```go
import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "io"
    "log/slog"
    "os"
    "path/filepath"
    "strings"
    "sync"
    "time"

    "github.com/go-git/go-git/v5"
    "github.com/go-git/go-git/v5/config"
    "github.com/go-git/go-git/v5/plumbing"
    "github.com/go-git/go-git/v5/plumbing/object"
    "github.com/go-git/go-git/v5/plumbing/transport/http"
    "srv.exe.dev/db/dbgen"
)
```

---

## Error Handling Notes

go-git returns typed errors that can be checked:

```go
import "github.com/go-git/go-git/v5"

// Common errors to handle:
- git.NoErrAlreadyUpToDate  // Fetch/pull: remote is already up to date
- git.ErrNonFastForwardUpdate // Pull: would require non-fast-forward merge
- git.ErrRepositoryNotExists  // Clone: repository doesn't exist
- git.ErrAuthenticationFailed // Auth: invalid credentials
```

Example:
```go
err = repo.Fetch(&git.FetchOptions{...})
if err != nil && err != git.NoErrAlreadyUpToDate {
    return fmt.Errorf("git fetch: %w", err)
}
```

---

## Summary Table

| Git CLI Command | go-git Equivalent | 1:1? | Notes |
|-----------------|-------------------|------|-------|
| `git clone <url> .` | `git.PlainClone()` | ✅ Yes | No |
| `git init` | `git.PlainInit()` | ✅ Yes | No |
| `git checkout -b main` | `repo.CreateBranch()` + `w.Checkout()` | ✅ Yes | No |
| `git remote add origin` | `repo.CreateRemote()` | ✅ Yes | No |
| `git remote set-url` | `repo.DeleteRemote()` + `CreateRemote()` | ✅ Yes | No |
| `git add -A` | `w.AddWithOptions(&git.AddOptions{All: true})` | ✅ Yes | No |
| `git status --porcelain` | `w.Status().IsClean()` | ✅ Yes | No |
| `git config user.email/name` | `git.CommitOptions{Author: ...}` | ✅ Yes | No |
| `git commit -m` | `w.Commit()` | ✅ Yes | No |
| `git push origin main` | `repo.Push()` | ✅ Yes | Error if non-fast-forward |
| `git fetch origin` | `repo.Fetch()` | ✅ Yes | No |
| `git pull --ff-only` | `w.Pull(FastForwardOnly: true)` | ✅ Yes | Error if non-fast-forward |
| `git ls-tree -r` | `commit.Tree().Files().ForEach()` | ✅ Yes | Path-based only, not content |
| `git show <ref>:<path>` | `commit.File(path).Contents()` | ✅ Yes | Returns encrypted blob only |
| `git log -1 --format=%cI` | `repo.Log()` → `commit.Committer.When` | ✅ Yes | No |

### Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Yes | Direct 1:1 replacement, identical behavior |

### Error Handling

| Operation | Error Condition | User Message |
|-----------|-----------------|--------------|
| **Push** | Non-fast-forward rejection | "Remote has changes, please pull first" |
| **Pull** | Non-fast-forward rejection | "Local has unpushed changes, please push first" |
| **Reset** | N/A | Re-clones from remote (discards local) |

---

## Testing Checklist

After implementation:

- [ ] Build succeeds: `go build -o webpass-server ./cmd/srv`
- [ ] No `os/exec` imports in `srv/git.go`
- [ ] No `exec.Command` calls in `srv/git.go`
- [ ] Go tests pass: `go test ./srv/...`
- [ ] Manual test: Configure git sync
- [ ] Manual test: Push to remote (no conflicts)
- [ ] Manual test: Pull from remote (no conflicts)
- [ ] Manual test: Push error when remote has changes
- [ ] Manual test: Pull error when local has unpushed changes
- [ ] Manual test: Reset operation (re-clone from remote)

---

## References

- [go-git Documentation](https://pkg.go.dev/github.com/go-git/go-git/v5)
- [go-git Examples](https://github.com/go-git/go-git/tree/master/_examples)
- [go-git Authentication](https://github.com/go-git/go-git/tree/master/_examples/authentication)
