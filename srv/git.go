package srv

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

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

// SyncStatus represents the current sync state
type SyncStatus struct {
	Configured      bool   `json:"configured"`
	RepoURL         string `json:"repo_url,omitempty"`
	HasEncryptedPat bool   `json:"has_encrypted_pat"`
	SuccessCount    int64  `json:"success_count"`
	FailedCount     int64  `json:"failed_count"`
}

// Conflict represents a file that has conflicting changes
type Conflict struct {
	Path           string `json:"path"`
	LocalModified  bool   `json:"local_modified"`
	RemoteModified bool   `json:"remote_modified"`
	LocalTime      string `json:"local_time,omitempty"`  // RFC3339 format
	RemoteTime     string `json:"remote_time,omitempty"` // RFC3339 format
}

// PullResult represents the result of a pull operation
type PullResult struct {
	Status         string     `json:"status"`
	Operation      string     `json:"operation"`
	EntriesChanged int        `json:"entries_changed"`
	Message        string     `json:"message"`
	Conflicts      []Conflict `json:"conflicts,omitempty"`
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

	// Clone repo with credentials
	cloneURL := g.authURL(repoURL, token)
	if err := g.runGitCommand(repoDir, "clone", cloneURL, "."); err != nil {
		// If clone fails, initialize new repo
		slog.Info("clone failed, initializing new repo", "dir", repoDir)
		if err := g.runGitCommand(repoDir, "init"); err != nil {
			return fmt.Errorf("init: %w", err)
		}
		if err := g.runGitCommand(repoDir, "checkout", "-b", "main"); err != nil {
			return fmt.Errorf("create main branch: %w", err)
		}
		if err := g.runGitCommand(repoDir, "remote", "add", "origin", repoURL); err != nil {
			return fmt.Errorf("add remote: %w", err)
		}
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
	if err := g.exportPasswordStore(ctx, fingerprint); err != nil {
		return nil, fmt.Errorf("export password store: %w", err)
	}

	// Set credentials for push
	pushURL := g.authURL(config.RepoUrl, token)
	if err := g.runGitCommand(repoDir, "remote", "set-url", "origin", pushURL); err != nil {
		return nil, fmt.Errorf("set remote url: %w", err)
	}

	// Check if there are any changes to commit
	if err := g.runGitCommand(repoDir, "add", "-A", "."); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}

	// Check for changes
	statusCmd := exec.Command("git", "status", "--porcelain")
	statusCmd.Dir = repoDir
	output, err := statusCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git status: %w", err)
	}

	// If no changes, skip commit
	if len(output) == 0 {
		slog.Info("git push: no changes to push", "fingerprint", fingerprint)
		return &PullResult{
			Status:    "success",
			Operation: "push",
			Message:   "no changes to push",
		}, nil
	}

	// Commit changes
	commitMsg := fmt.Sprintf("Sync: %s", time.Now().Format(time.RFC3339))
	if err := g.runGitCommand(repoDir, "config", "user.email", "webpass@local"); err != nil {
		return nil, fmt.Errorf("git config email: %w", err)
	}
	if err := g.runGitCommand(repoDir, "config", "user.name", "WebPass"); err != nil {
		return nil, fmt.Errorf("git config name: %w", err)
	}
	if err := g.runGitCommand(repoDir, "commit", "-m", commitMsg); err != nil {
		return nil, fmt.Errorf("git commit: %w", err)
	}

	// Push
	if err := g.runGitCommand(repoDir, "push", "origin", "main"); err != nil {
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

	slog.Info("git push successful", "fingerprint", fingerprint)
	return &PullResult{
		Status:    "success",
		Operation: "push",
		Message:   "pushed to remote",
	}, nil
}

// Pull pulls changes from remote and merges
func (g *GitService) Pull(ctx context.Context, fingerprint string, token string, forceTheirs bool) (*PullResult, error) {
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

	// Set credentials for pull
	fetchURL := g.authURL(config.RepoUrl, token)
	if err := g.runGitCommand(repoDir, "remote", "set-url", "origin", fetchURL); err != nil {
		return nil, fmt.Errorf("set remote url: %w", err)
	}

	// Fetch first to get latest remote state
	if err := g.runGitCommand(repoDir, "fetch", "origin"); err != nil {
		return nil, fmt.Errorf("git fetch: %w", err)
	}

	// Check for conflicts BEFORE pulling (compare DB vs remote)
	conflicts, err := g.detectConflicts(ctx, fingerprint, repoDir)
	if err != nil {
		slog.Warn("conflict detection failed", "error", err)
		// Continue with pull anyway
	}

	if len(conflicts) > 0 && !forceTheirs {
		// Return conflicts without pulling (unless forceTheirs is true)
		return &PullResult{
			Status:    "conflict",
			Operation: "pull",
			Conflicts: conflicts,
			Message:   fmt.Sprintf("%d conflicts detected", len(conflicts)),
		}, nil
	}

	// Pull with fast-forward only, or force theirs if conflicts
	var pullErr error
	if forceTheirs {
		slog.Info("pulling with --strategy-option=theirs to resolve conflicts")
		pullErr = g.runGitCommand(repoDir, "pull", "--strategy-option=theirs", "origin", "main")
	} else {
		pullErr = g.runGitCommand(repoDir, "pull", "--ff-only", "origin", "main")
	}
	if pullErr != nil {
		// Try with merge strategy if ff-only fails
		if !forceTheirs {
			if err := g.runGitCommand(repoDir, "pull", "--strategy-option=ours", "origin", "main"); err != nil {
				// Log failure
				errMsg := err.Error()
				_ = g.q.LogGitSync(ctx, dbgen.LogGitSyncParams{
					Fingerprint: fingerprint,
					Operation:   "pull",
					Status:      "failed",
					Message:     &errMsg,
				})
				return nil, fmt.Errorf("git pull: %w", err)
			}
		} else {
			return nil, fmt.Errorf("git pull: %w", pullErr)
		}
	}

	// After pull, sync database with repo state
	entriesChanged, err := g.syncDatabase(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("sync database: %w", err)
	}

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

	slog.Info("git pull successful", "fingerprint", fingerprint, "entries", entriesChanged)
	return &PullResult{
		Status:         "success",
		Operation:      "pull",
		EntriesChanged: entriesChanged,
		Message:        fmt.Sprintf("pulled %d entries from remote", entriesChanged),
	}, nil
}

// detectConflicts checks for files that exist both locally (in DB) and remotely with different content
func (g *GitService) detectConflicts(ctx context.Context, fingerprint, repoDir string) ([]Conflict, error) {
	var conflicts []Conflict

	// Get entries from database
	dbEntries, err := g.q.ListEntriesContent(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("list db entries: %w", err)
	}

	// Get list of tracked files in remote repo
	cmd := exec.Command("git", "ls-tree", "-r", "--name-only", "origin/main", "--", ".password-store")
	cmd.Dir = repoDir
	remoteOutput, err := cmd.Output()
	if err != nil {
		// Remote might not have any files yet
		slog.Info("no remote files to compare")
		return conflicts, nil
	}

	remoteFiles := strings.Split(strings.TrimSpace(string(remoteOutput)), "\n")
	remoteFileSet := make(map[string]bool)
	for _, file := range remoteFiles {
		if file == "" {
			continue
		}
		// Remove .password-store/ prefix and .gpg suffix
		path := strings.TrimPrefix(file, ".password-store/")
		path = strings.TrimSuffix(path, ".gpg")
		remoteFileSet[path] = true
	}

	// Check each DB entry against remote
	for _, entry := range dbEntries {
		if !remoteFileSet[entry.Path] {
			continue // Entry not in remote, no conflict
		}

		// Entry exists in both DB and remote - check if content differs
		remotePath := ".password-store/" + entry.Path + ".gpg"

		// Get remote file content hash
		hashCmd := exec.Command("git", "show", "origin/main:"+remotePath)
		hashCmd.Dir = repoDir
		remoteContent, err := hashCmd.Output()
		if err != nil {
			continue
		}

		// Compare hashes
		if string(remoteContent) != string(entry.Content) {
			// Content differs - this is a conflict
			conflict := Conflict{
				Path:           entry.Path,
				LocalModified:  true,
				RemoteModified: true,
			}

			// Get local commit time (if committed)
			localFile := ".password-store/" + entry.Path + ".gpg"
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

			conflicts = append(conflicts, conflict)
			slog.Info("conflict detected", "path", entry.Path)
		}
	}

	return conflicts, nil
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

func (g *GitService) authURL(repoURL, token string) string {
	// Convert https://github.com/user/repo.git to https://token@github.com/user/repo.git
	if strings.HasPrefix(repoURL, "https://") {
		return strings.Replace(repoURL, "https://", "https://"+token+"@", 1)
	}
	return repoURL
}

func (g *GitService) runGitCommand(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}
