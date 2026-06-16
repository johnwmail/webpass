package srv

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"
	httptransport "github.com/go-git/go-git/v5/plumbing/transport/http"
	gossh "github.com/go-git/go-git/v5/plumbing/transport/ssh"
	"golang.org/x/crypto/ssh"

	"srv.exe.dev/db/dbgen"
)

// ---------------------------------------------------------------------------
// Error types for SSH host key verification
// ---------------------------------------------------------------------------

// HostKeyUnknownError is returned when the host key is not yet trusted.
type HostKeyUnknownError struct {
	Host        string
	Port        int
	Fingerprint string
}

func (e *HostKeyUnknownError) Error() string {
	return fmt.Sprintf("host key unknown: %s fingerprint %s", e.Host, e.Fingerprint)
}

// HostKeyChangedError is returned when the host key has changed since last trust.
type HostKeyChangedError struct {
	Host           string
	Port           int
	OldFingerprint string
	NewFingerprint string
}

func (e *HostKeyChangedError) Error() string {
	return fmt.Sprintf("host key changed for %s: was %s, now %s", e.Host, e.OldFingerprint, e.NewFingerprint)
}

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
	Configured         bool   `json:"configured"`
	RepoURL            string `json:"repo_url,omitempty"`
	Branch             string `json:"branch,omitempty"`
	AuthType           string `json:"auth_type,omitempty"`
	HasEncryptedPat    bool   `json:"has_encrypted_pat"`
	HasEncryptedSSHKey bool   `json:"has_encrypted_ssh_key"`
	SuccessCount       int64  `json:"success_count"`
	FailedCount        int64  `json:"failed_count"`
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

// Configure sets up git sync for a user
func (g *GitService) Configure(ctx context.Context, fingerprint, repoURL, encryptedPAT, encryptedSSHKey, authType, branch string) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if err := g.q.UpsertGitConfig(ctx, dbgen.UpsertGitConfigParams{
		Fingerprint:     fingerprint,
		RepoUrl:         repoURL,
		Branch:          branch,
		EncryptedPat:    encryptedPAT,
		EncryptedSshKey: encryptedSSHKey,
		AuthType:        authType,
	}); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	slog.Info("git sync configured", "fingerprint", fingerprint, "repo", repoURL, "branch", branch, "auth", authType)
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
		Configured:         true,
		RepoURL:            row.RepoUrl,
		Branch:             row.Branch,
		AuthType:           row.AuthType,
		HasEncryptedPat:    row.EncryptedPat != "",
		HasEncryptedSSHKey: row.EncryptedSshKey != "",
		SuccessCount:       row.SuccessCount,
		FailedCount:        row.FailedCount,
	}, nil
}

// ---------------------------------------------------------------------------
// Known Hosts Management
// ---------------------------------------------------------------------------

// TrustHostKey stores a trusted host key fingerprint
func (g *GitService) TrustHostKey(ctx context.Context, fingerprint, hostname, hostKeyFingerprint string) error {
	// Strip port if present for storage
	host, _, err := net.SplitHostPort(hostname)
	if err != nil {
		host = hostname
	}
	return g.q.UpsertKnownHost(ctx, dbgen.UpsertKnownHostParams{
		Fingerprint:        fingerprint,
		Hostname:           host,
		HostKeyFingerprint: hostKeyFingerprint,
	})
}

// GetTrustedHosts lists all trusted hosts for a user
func (g *GitService) GetTrustedHosts(ctx context.Context, fingerprint string) ([]dbgen.GitKnownHost, error) {
	return g.q.ListKnownHosts(ctx, fingerprint)
}

// DeleteTrustedHost removes a trusted host
func (g *GitService) DeleteTrustedHost(ctx context.Context, fingerprint, hostname string) error {
	return g.q.DeleteKnownHost(ctx, dbgen.DeleteKnownHostParams{
		Fingerprint: fingerprint,
		Hostname:    hostname,
	})
}

// ---------------------------------------------------------------------------
// Auth Method Factory
// ---------------------------------------------------------------------------

// authFor creates the appropriate transport.AuthMethod based on auth type
func (g *GitService) authFor(ctx context.Context, fingerprint, token, authType string) (transport.AuthMethod, error) {
	switch authType {
	case "ssh":
		// token is the PEM-encoded SSH private key (decrypted by browser)
		// Default user is "git" (standard for GitHub/GitLab/Gitea)
		publicKeys, err := gossh.NewPublicKeys("git", []byte(token), "")
		if err != nil {
			return nil, fmt.Errorf("ssh auth: %w", err)
		}
		// Set up TOFU host key callback
		publicKeys.HostKeyCallback = g.knownHostsCallback(ctx, fingerprint)
		return publicKeys, nil
	default:
		return &httptransport.BasicAuth{
			Username: "token",
			Password: token,
		}, nil
	}
}

// knownHostsCallback returns an ssh.HostKeyCallback that checks the DB for known hosts.
func (g *GitService) knownHostsCallback(ctx context.Context, fingerprint string) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)

		host, _, err := net.SplitHostPort(hostname)
		if err != nil {
			host = hostname
		}

		known, err := g.q.GetKnownHost(ctx, dbgen.GetKnownHostParams{
			Fingerprint: fingerprint,
			Hostname:    host,
		})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return &HostKeyUnknownError{
					Host:        host,
					Port:        22,
					Fingerprint: fp,
				}
			}
			return fmt.Errorf("lookup known host: %w", err)
		}

		if known.HostKeyFingerprint != fp {
			return &HostKeyChangedError{
				Host:           host,
				Port:           22,
				OldFingerprint: known.HostKeyFingerprint,
				NewFingerprint: fp,
			}
		}

		return nil
	}
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

	config, err := g.q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	if token == "" {
		return nil, errors.New("git token required")
	}

	auth, err := g.authFor(ctx, fingerprint, token, config.AuthType)
	if err != nil {
		return nil, fmt.Errorf("auth setup: %w", err)
	}

	repoDir := g.repoDir(fingerprint)

	slog.Info("[PUSH] Starting git push", "fingerprint", fingerprint)
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	if err := os.MkdirAll(repoDir, 0700); err != nil {
		return nil, fmt.Errorf("create dir: %w", err)
	}

	slog.Info("[PUSH] Cloning remote to get history", "url", config.RepoUrl)
	repo, cloneErr := git.PlainClone(repoDir, false, &git.CloneOptions{
		URL:  config.RepoUrl,
		Auth: auth,
	})
	if cloneErr != nil {
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
	}

	count, err := g.exportPasswordStore(ctx, fingerprint, repoDir)
	if err != nil {
		return nil, fmt.Errorf("export entries: %w", err)
	}

	user, err := g.q.GetUser(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	gpgID := fingerprint
	if user.GpgID != nil && *user.GpgID != "" {
		gpgID = *user.GpgID
	}
	gpgIDPath := filepath.Join(repoDir, ".gpg-id")
	if err := os.WriteFile(gpgIDPath, []byte(gpgID), 0600); err != nil {
		return nil, fmt.Errorf("write .gpg-id: %w", err)
	}

	w, err := repo.Worktree()
	if err != nil {
		return nil, fmt.Errorf("get worktree: %w", err)
	}
	if err := w.AddWithOptions(&git.AddOptions{All: true}); err != nil {
		return nil, fmt.Errorf("git add: %w", err)
	}

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

	remote, err := repo.Remote("origin")
	if err != nil {
		return nil, fmt.Errorf("get remote: %w", err)
	}

	headRef, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("get HEAD ref: %w", err)
	}
	branchName := headRef.Name().Short()

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

	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

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

// Pull clones remote and imports to local DB (one-way sync)
func (g *GitService) Pull(ctx context.Context, fingerprint, token string) (*PullResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	config, err := g.q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		return nil, fmt.Errorf("get config: %w", err)
	}
	if token == "" {
		return nil, errors.New("git token required")
	}

	auth, err := g.authFor(ctx, fingerprint, token, config.AuthType)
	if err != nil {
		return nil, fmt.Errorf("auth setup: %w", err)
	}

	repoDir := g.repoDir(fingerprint)

	slog.Info("[PULL] Starting git pull", "fingerprint", fingerprint)
	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

	_, err = git.PlainClone(repoDir, false, &git.CloneOptions{
		URL:  config.RepoUrl,
		Auth: auth,
	})
	if err != nil {
		return nil, fmt.Errorf("git clone: %w", err)
	}

	gpgIDPath := filepath.Join(repoDir, ".gpg-id")
	if gpgIDData, err := os.ReadFile(gpgIDPath); err == nil {
		gpgIDStr := string(gpgIDData)
		if err := g.q.UpdateUserGpgID(ctx, dbgen.UpdateUserGpgIDParams{
			GpgID:       &gpgIDStr,
			Fingerprint: fingerprint,
		}); err != nil {
			slog.Warn("[PULL] Failed to store .gpg-id", "error", err)
		}
	}

	count, err := g.syncDatabase(ctx, fingerprint, repoDir)
	if err != nil {
		return nil, fmt.Errorf("sync database: %w", err)
	}

	if err := g.cleanupRepoDir(fingerprint); err != nil {
		return nil, err
	}

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

// syncDatabase deletes all DB entries and imports from git repo
func (g *GitService) syncDatabase(ctx context.Context, fingerprint, repoDir string) (int, error) {
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
	}

	count := 0
	if _, err := os.Stat(repoDir); os.IsNotExist(err) {
		return 0, nil
	}

	err = filepath.Walk(repoDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".gpg") {
			return nil
		}
		relPath, err := filepath.Rel(repoDir, path)
		if err != nil {
			return err
		}
		entryPath := strings.TrimSuffix(relPath, ".gpg")
		entryPath = filepath.ToSlash(entryPath)
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := g.q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
			Fingerprint: fingerprint,
			Path:        entryPath,
			Content:     content,
		}); err != nil {
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

// exportPasswordStore exports all DB entries to .gpg files
func (g *GitService) exportPasswordStore(ctx context.Context, fingerprint, repoDir string) (int, error) {
	entries, err := g.q.ListEntriesContent(ctx, fingerprint)
	if err != nil {
		return 0, fmt.Errorf("list entries: %w", err)
	}

	for _, entry := range entries {
		entryPath := filepath.Join(repoDir, entry.Path+".gpg")
		entryDir := filepath.Dir(entryPath)
		if err := os.MkdirAll(entryDir, 0700); err != nil {
			return 0, fmt.Errorf("create dir: %w", err)
		}
		if err := os.WriteFile(entryPath, entry.Content, 0600); err != nil {
			return 0, fmt.Errorf("write entry %s: %w", entry.Path, err)
		}
	}
	return len(entries), nil
}

func (g *GitService) repoDir(fingerprint string) string {
	return filepath.Join(g.repoRoot, fingerprint)
}
