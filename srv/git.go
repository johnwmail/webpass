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
	Branch          string `json:"branch,omitempty"`
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
func (g *GitService) Configure(ctx context.Context, fingerprint, repoURL, encryptedPAT, branch string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if err := g.q.UpsertGitConfig(ctx, dbgen.UpsertGitConfigParams{
		Fingerprint:  fingerprint,
		RepoUrl:      repoURL,
		Branch:       branch,
		EncryptedPat: encryptedPAT,
	}); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	slog.Info("git sync configured", "fingerprint", fingerprint, "repo", repoURL, "branch", branch)
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
		Branch:          row.Branch,
		HasEncryptedPat: row.EncryptedPat != "",
		SuccessCount:    row.SuccessCount,
		FailedCount:     row.FailedCount,
	}, nil
}

// ---------------------------------------------------------------------------
// Git Operations - One-Way Sync
// ---------------------------------------------------------------------------

// cleanupRepoDir deletes the fingerprint directory completely
func (g *GitService) cleanupRepoDir(fingerprint string) error {
	repoDir := g.repoDir(fingerprint)
	if err := os.RemoveAll(repoDir); err != nil {
		return fmt.Errorf("cleanup repo dir: %w", err)
	}
	slog.Info("[CLEANUP] Deleted directory", "dir", repoDir)
	return nil
}

// Push exports local DB to git and force-pushes to remote (one-way sync)
func (g *GitService) Push(ctx context.Context, fingerprint, token string) (*PullResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	// Get config
	config, err := g.q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	if token == "" {
		return nil, errors.New("git token required")
	}

	repoDir := g.repoDir(fingerprint)

	// Step 1: Cleanup before
	slog.Info("[PUSH] Starting git push", "fingerprint", fingerprint)
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	// Step 2: Create fresh directory
	if err := os.MkdirAll(repoDir, 0700); err != nil {
		return nil, fmt.Errorf("create dir: %w", err)
	}
	slog.Info("[PUSH] Created fresh directory", "dir", repoDir)

	// Step 3: Clone remote repo first (to get history for force push)
	auth := &http.BasicAuth{
		Username: "token",
		Password: token,
	}
	slog.Info("[PUSH] Cloning remote to get history", "url", config.RepoUrl)
	repo, cloneErr := git.PlainClone(repoDir, false, &git.CloneOptions{
		URL:      config.RepoUrl,
		Auth:     auth,
		Progress: nil,
	})
	if cloneErr != nil {
		// If clone fails (empty remote), init fresh repo
		slog.Info("[PUSH] Remote empty, initializing fresh repo", "error", cloneErr)
		repo, err = git.PlainInit(repoDir, false)
		if err != nil {
			return nil, fmt.Errorf("git init: %w", err)
		}
		_, err = repo.CreateRemote(&gitconfig.RemoteConfig{
			Name: "origin",
			URLs: []string{config.RepoUrl},
		})
		if err != nil {
			return nil, fmt.Errorf("add remote: %w", err)
		}
	} else {
		slog.Info("[PUSH] Cloned remote successfully")

		// Step 4: Remove all files except .git (prepare for overwrite)
		slog.Info("[PUSH] Removing all files except .git")
		entries, err := os.ReadDir(repoDir)
		if err != nil {
			return nil, fmt.Errorf("read dir: %w", err)
		}
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			if err := os.RemoveAll(filepath.Join(repoDir, entry.Name())); err != nil {
				return nil, fmt.Errorf("remove file %s: %w", entry.Name(), err)
			}
		}
		slog.Info("[PUSH] Cleaned working directory")
	}

	// Step 5: Export all entries from DB (overwrites remote content)
	count, err := g.exportPasswordStore(ctx, fingerprint, repoDir)
	if err != nil {
		return nil, fmt.Errorf("export entries: %w", err)
	}
	slog.Info("[PUSH] Exported entries", "count", count)

	// Step 6: Stage all files
	w, err := repo.Worktree()
	if err != nil {
		return nil, fmt.Errorf("get worktree: %w", err)
	}
	if err := w.AddWithOptions(&git.AddOptions{All: true}); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}
	slog.Info("[PUSH] Staged all files")

	// Step 7: Commit
	commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))
	_, err = w.Commit(commitMsg, &git.CommitOptions{
		Author: &object.Signature{
			Name:  "WebPass",
			Email: "webpass@local",
			When:  time.Now(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("git commit: %w", err)
	}
	slog.Info("[PUSH] Committed", "message", commitMsg)

	// Step 8: Get remote and force push
	remote, err := repo.Remote("origin")
	if err != nil {
		return nil, fmt.Errorf("get remote: %w", err)
	}

	// Get current branch name from the cloned repo
	headRef, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("get HEAD ref: %w", err)
	}
	branchName := headRef.Name().Short()
	slog.Info("[PUSH] Detected branch", "branch", branchName)

	// Force push current branch to remote
	refSpec := gitconfig.RefSpec(fmt.Sprintf("+refs/heads/%s:refs/heads/%s", branchName, branchName))
	pushErr := remote.Push(&git.PushOptions{
		RemoteName: "origin",
		Auth:       auth,
		RefSpecs:   []gitconfig.RefSpec{refSpec},
		Force:      true,
	})

	if pushErr != nil {
		if pushErr == git.NoErrAlreadyUpToDate {
			slog.Info("[PUSH] Already up-to-date")
		} else {
			return nil, fmt.Errorf("git push --force: %w", pushErr)
		}
	} else {
		slog.Info("[PUSH] Pushed --force", "branch", branchName)
	}

	// Step 9: Cleanup after
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	// Log success
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

	slog.Info("[PUSH] Finished", "fingerprint", fingerprint, "entries", count)
	return &PullResult{
		Status:         "success",
		Operation:      "push",
		EntriesChanged: count,
		Message:        fmt.Sprintf("synced %d entries", count),
	}, nil
}

// Pull clones remote and imports to local DB (one-way sync)
func (g *GitService) Pull(ctx context.Context, fingerprint, token string) (*PullResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	// Get config
	config, err := g.q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	if token == "" {
		return nil, errors.New("git token required")
	}

	repoDir := g.repoDir(fingerprint)

	// Step 1: Cleanup before
	slog.Info("[PULL] Starting git pull", "fingerprint", fingerprint)
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	// Step 2: Clone remote
	auth := &http.BasicAuth{
		Username: "token",
		Password: token,
	}
	if err := os.MkdirAll(filepath.Dir(repoDir), 0700); err != nil {
		return nil, fmt.Errorf("create dir: %w", err)
	}
	_, err = git.PlainClone(repoDir, false, &git.CloneOptions{
		URL:  config.RepoUrl,
		Auth: auth,
	})
	if err != nil {
		return nil, fmt.Errorf("git clone: %w", err)
	}
	slog.Info("[PULL] Cloned remote", "url", config.RepoUrl)

	// Step 3: Delete all DB entries and import from clone
	count, err := g.syncDatabase(ctx, fingerprint, repoDir)
	if err != nil {
		return nil, fmt.Errorf("sync database: %w", err)
	}
	slog.Info("[PULL] Imported entries", "count", count)

	// Step 4: Cleanup after
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	// Log success
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

	slog.Info("[PULL] Finished", "fingerprint", fingerprint, "entries", count)
	return &PullResult{
		Status:         "success",
		Operation:      "pull",
		EntriesChanged: count,
		Message:        msg,
	}, nil
}

// syncDatabase deletes all DB entries and imports from git repo
func (g *GitService) syncDatabase(ctx context.Context, fingerprint, repoDir string) (int, error) {
	// Delete all existing entries first
	entries, err := g.q.ListEntries(ctx, fingerprint)
	if err != nil {
		return 0, fmt.Errorf("list entries: %w", err)
	}

	for _, entry := range entries {
		if err := g.q.DeleteEntry(ctx, dbgen.DeleteEntryParams{
			Fingerprint: fingerprint,
			Path:        entry.Path,
		}); err != nil {
			return 0, fmt.Errorf("delete entry %s: %w", entry.Path, err)
		}
		slog.Info("[PULL] Deleted entry from DB", "path", entry.Path)
	}
	slog.Info("[PULL] Deleted all entries", "count", len(entries))

	// Walk repo directory and import .gpg files
	count := 0
	if _, err := os.Stat(repoDir); os.IsNotExist(err) {
		return 0, nil
	}

	err = filepath.Walk(repoDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories
		if info.IsDir() {
			// Skip .git directory
			if info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}

		// Only process .gpg files
		if !strings.HasSuffix(path, ".gpg") {
			return nil
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
		if err := g.q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
			Fingerprint: fingerprint,
			Path:        entryPath,
			Content:     content,
		}); err != nil {
			slog.Error("upsert entry", "path", entryPath, "error", err)
			return err
		}

		slog.Info("[PULL] Imported entry", "path", entryPath)
		count++
		return nil
	})

	if err != nil {
		return 0, err
	}

	return count, nil
}

// exportPasswordStore exports all DB entries to .gpg files
func (g *GitService) exportPasswordStore(ctx context.Context, fingerprint, repoDir string) (int, error) {
	// Get all entries
	entries, err := g.q.ListEntriesContent(ctx, fingerprint)
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

		slog.Info("[PUSH] Exported entry", "path", entry.Path)
	}

	return len(entries), nil
}

func (g *GitService) repoDir(fingerprint string) string {
	return filepath.Join(g.repoRoot, fingerprint)
}
