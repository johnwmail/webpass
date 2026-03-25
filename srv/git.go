package srv

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
	"srv.exe.dev/db/dbgen"
)

// GitService handles git operations for password store sync
type GitService struct {
	mu       sync.Mutex
	dbPath   string
	q        *dbgen.Queries
	repoRoot string                  // base directory for .password-store repos
	tokens   map[string]SessionToken // fingerprint -> session token cache
}

// SessionToken represents a cached git token
type SessionToken struct {
	Token     string
	ExpiresAt time.Time
}

// SyncStatus represents the current sync status
type SyncStatus struct {
	Configured      bool   `json:"configured"`
	RepoURL         string `json:"repo_url,omitempty"`
	HasEncryptedPat bool   `json:"has_encrypted_pat"`
	SuccessCount    int64  `json:"success_count"`
	FailedCount     int64  `json:"failed_count"`
}

// PullResult represents the result of a pull operation
type PullResult struct {
	Status         string `json:"status"`
	Operation      string `json:"operation"`
	EntriesChanged int    `json:"entries_changed"`
	Message        string `json:"message"`
}

// NewGitService creates a new GitService
func NewGitService(dbPath string, q *dbgen.Queries, repoRoot string) *GitService {
	return &GitService{
		dbPath:   dbPath,
		q:        q,
		repoRoot: repoRoot,
		tokens:   make(map[string]SessionToken),
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Configure sets up git sync for a user with encrypted PAT
func (g *GitService) Configure(ctx context.Context, fingerprint, repoURL, encryptedPAT string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if err := g.q.UpsertGitConfig(ctx, dbgen.UpsertGitConfigParams{
		Fingerprint:  fingerprint,
		RepoUrl:      repoURL,
		EncryptedPat: encryptedPAT,
	}); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	slog.Info("git sync configured", "fingerprint", fingerprint, "repo", repoURL)
	return nil
}

// SetSessionToken caches a plaintext token for the current session
func (g *GitService) SetSessionToken(fingerprint, token string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tokens[fingerprint] = SessionToken{
		Token:     token,
		ExpiresAt: time.Now().Add(5 * time.Minute),
	}
}

// getSessionToken retrieves a cached token if still valid
func (g *GitService) getSessionToken(fingerprint string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	st, ok := g.tokens[fingerprint]
	if !ok || time.Now().After(st.ExpiresAt) {
		return "", false
	}
	return st.Token, true
}

// GetStatus returns current sync status
func (g *GitService) GetStatus(ctx context.Context, fingerprint string) (*SyncStatus, error) {
	row, err := g.q.GetGitSyncStatus(ctx, fingerprint)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return &SyncStatus{Configured: false}, nil
		}
		return nil, err
	}

	return &SyncStatus{
		Configured:      true,
		RepoURL:         row.RepoUrl,
		HasEncryptedPat: row.EncryptedPat != "",
		SuccessCount:    row.SuccessCount,
		FailedCount:     row.FailedCount,
	}, nil
}

// ---------------------------------------------------------------------------
// Git Operations
// ---------------------------------------------------------------------------

// initRepo clones or initializes the git repository
func (g *GitService) initRepo(fingerprint, repoURL, token string) error {
	repoDir := g.repoDir(fingerprint)

	// Check if repo exists
	if _, err := os.Stat(repoDir); err == nil {
		// Repo exists - already initialized
		return nil
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
		Progress: nil,
	})
	if err != nil {
		return fmt.Errorf("clone: %w", err)
	}

	return nil
}

// Push pushes local commits to remote
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

	// Ensure repo is initialized
	if err := g.initRepo(fingerprint, config.RepoUrl, token); err != nil {
		return nil, fmt.Errorf("init repo: %w", err)
	}

	// Export database entries to .password-store directory
	entries, err := g.q.ListEntriesContent(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("list entries: %w", err)
	}

	if err := g.exportPasswordStore(ctx, fingerprint); err != nil {
		return nil, fmt.Errorf("export password store: %w", err)
	}

	slog.Info("PUSH: exporting entries to git repo",
		"fingerprint", fingerprint,
		"entries", len(entries))

	// Open repo
	repo, err := git.PlainOpen(repoDir)
	if err != nil {
		return nil, fmt.Errorf("open repo: %w", err)
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
		slog.Info("PUSH: no changes to push", "fingerprint", fingerprint)
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
	slog.Info("PUSH: committed changes", "fingerprint", fingerprint, "hash", hash.String())

	// Push with authentication
	auth := &http.BasicAuth{Username: "token", Password: token}
	err = repo.Push(&git.PushOptions{
		RemoteName: "origin",
		Auth:       auth,
		RefSpecs:   []gitconfig.RefSpec{gitconfig.RefSpec("+refs/heads/main:refs/heads/main")},
	})

	if err != nil {
		if err == git.ErrNonFastForwardUpdate {
			// Remote has newer commits - user must pull first
			slog.Warn("PUSH: REJECTED - remote has changes, user must pull first",
				"fingerprint", fingerprint)
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
	entriesChangedInt64 := int64(len(entries))
	slog.Info("PUSH: successfully pushed to remote",
		"fingerprint", fingerprint,
		"entries", len(entries))
	if err := g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
		Fingerprint:    fingerprint,
		Operation:      "push",
		Status:         "success",
		Message:        &commitMsg,
		EntriesChanged: &entriesChangedInt64,
	}); err != nil {
		slog.Warn("log git sync failed", "error", err)
	}

	return &PullResult{
		Status:         "success",
		Operation:      "push",
		EntriesChanged: len(entries),
		Message:        fmt.Sprintf("pushed %d entries to remote", len(entries)),
	}, nil
}

// Pull pulls changes from remote and merges
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

	// Ensure repo is initialized
	if err := g.initRepo(fingerprint, config.RepoUrl, token); err != nil {
		return nil, fmt.Errorf("init repo: %w", err)
	}

	// Open repo
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
	// But we still need to sync database from local git repo
	if head.Hash() == remoteRef.Hash() {
		slog.Info("PULL: already up to date, syncing database",
			"fingerprint", fingerprint)

		// Sync database from local git repo
		entriesChanged, err := g.syncDatabase(ctx, fingerprint)
		if err != nil {
			slog.Error("PULL: sync database failed", "fingerprint", fingerprint, "error", err)
			return nil, fmt.Errorf("sync database: %w", err)
		}
		slog.Info("PULL: database synced", "fingerprint", fingerprint, "entries", entriesChanged)

		// Log success
		entriesChangedInt64 := int64(entriesChanged)
		successMsg := fmt.Sprintf("already up to date (%d entries in sync)", entriesChanged)
		_ = g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
			Fingerprint:    fingerprint,
			Operation:      "pull",
			Status:         "success",
			Message:        &successMsg,
			EntriesChanged: &entriesChangedInt64,
		})

		return &PullResult{
			Status:         "success",
			Operation:      "pull",
			EntriesChanged: entriesChanged,
			Message:        successMsg,
		}, nil
	}

	slog.Info("PULL: checking fast-forward",
		"fingerprint", fingerprint,
		"local_head", head.Hash().String(),
		"remote_head", remoteRef.Hash().String())

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

	slog.Info("PULL: fast-forward check",
		"fingerprint", fingerprint,
		"isAncestor", isAncestor)

	if !isAncestor {
		// Local has commits that aren't in remote - can't fast-forward
		slog.Warn("PULL: REJECTING - local has unpushed changes",
			"fingerprint", fingerprint,
			"local_head", head.Hash().String(),
			"remote_head", remoteRef.Hash().String())
		return nil, errors.New("local has unpushed changes, please push first")
	}

	slog.Info("PULL: fast-forward OK, proceeding", "fingerprint", fingerprint)

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
			// Already up to date - still sync DB
			slog.Info("PULL: already up to date, syncing database", "fingerprint", fingerprint)

			// Sync database from local git repo
			entriesChanged, err := g.syncDatabase(ctx, fingerprint)
			if err != nil {
				return nil, fmt.Errorf("sync database: %w", err)
			}

			slog.Info("PULL: database synced",
				"fingerprint", fingerprint,
				"entries", entriesChanged)

			// Log success
			entriesChangedInt64 := int64(entriesChanged)
			successMsg := fmt.Sprintf("already up to date (%d entries in sync)", entriesChanged)
			_ = g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
				Fingerprint:    fingerprint,
				Operation:      "pull",
				Status:         "success",
				Message:        &successMsg,
				EntriesChanged: &entriesChangedInt64,
			})

			return &PullResult{
				Status:         "success",
				Operation:      "pull",
				EntriesChanged: entriesChanged,
				Message:        successMsg,
			}, nil
		}

		// Other error
		return nil, fmt.Errorf("PULL: %w", err)
	}

	// Sync database with updated worktree
	entriesChanged, err := g.syncDatabase(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("sync database: %w", err)
	}

	slog.Info("PULL: successfully pulled from remote",
		"fingerprint", fingerprint,
		"entries", entriesChanged)

	// Log success
	entriesChangedInt64 := int64(entriesChanged)
	successMsg := fmt.Sprintf("pulled %d entries from remote", entriesChanged)
	if err := g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
		Fingerprint:    fingerprint,
		Operation:      "pull",
		Status:         "success",
		Message:        &successMsg,
		EntriesChanged: &entriesChangedInt64,
	}); err != nil {
		slog.Warn("log git sync failed", "error", err)
	}

	return &PullResult{
		Status:         "success",
		Operation:      "pull",
		EntriesChanged: entriesChanged,
		Message:        fmt.Sprintf("pulled %d entries from remote", entriesChanged),
	}, nil
}

// Reset discards local repo and re-clones from remote
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

// syncDatabase updates the database from the git repo after a pull
func (g *GitService) syncDatabase(ctx context.Context, fingerprint string) (int, error) {
	repoDir := g.repoDir(fingerprint)
	count := 0

	// Walk through all .gpg files in repo
	passwordStoreDir := filepath.Join(repoDir, ".password-store")
	if _, err := os.Stat(passwordStoreDir); os.IsNotExist(err) {
		return 0, nil // No .password-store directory yet
	}

	err := filepath.Walk(passwordStoreDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".gpg") {
			return nil
		}

		// Get relative path from .password-store
		relPath, err := filepath.Rel(passwordStoreDir, path)
		if err != nil {
			return err
		}
		entryPath := strings.TrimSuffix(relPath, ".gpg")
		// Convert path separators to forward slashes
		entryPath = filepath.ToSlash(entryPath)

		// Read file content
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		// Upsert to database
		if err := g.q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
			Fingerprint: fingerprint,
			Path:        entryPath,
			Content:     content,
		}); err != nil {
			slog.Error("upsert entry from git", "path", entryPath, "error", err)
			return err
		}

		count++
		return nil
	})

	if err != nil {
		return 0, err
	}

	return count, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// exportPasswordStore exports database entries to .password-store directory
func (g *GitService) exportPasswordStore(ctx context.Context, fingerprint string) error {
	repoDir := g.repoDir(fingerprint)
	passwordStoreDir := filepath.Join(repoDir, ".password-store")

	// Get all entries for this user
	entries, err := g.q.ListEntriesContent(ctx, fingerprint)
	if err != nil {
		return fmt.Errorf("list entries: %w", err)
	}

	// Create password-store directory
	if err := os.MkdirAll(passwordStoreDir, 0700); err != nil {
		return fmt.Errorf("create password-store dir: %w", err)
	}

	// Write each entry to a .gpg file
	for _, entry := range entries {
		// Create subdirectory if needed
		entryPath := filepath.Join(passwordStoreDir, entry.Path+".gpg")
		entryDir := filepath.Dir(entryPath)
		if err := os.MkdirAll(entryDir, 0700); err != nil {
			return fmt.Errorf("create entry dir: %w", err)
		}

		// Write encrypted content to file
		if err := os.WriteFile(entryPath, entry.Content, 0600); err != nil {
			return fmt.Errorf("write entry %s: %w", entry.Path, err)
		}
	}

	slog.Info("exported password-store", "fingerprint", fingerprint, "entries", len(entries))
	return nil
}

func (g *GitService) repoDir(fingerprint string) string {
	return filepath.Join(g.repoRoot, fingerprint)
}
