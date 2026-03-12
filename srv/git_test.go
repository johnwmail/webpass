package srv

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"srv.exe.dev/db/dbgen"
)

func TestGitServiceNew(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")
	repoRoot := filepath.Join(tmpDir, "git-repos")

	srv := newTestServer(t)
	gs := NewGitService(dbPath, srv.Q, repoRoot)

	if gs == nil {
		t.Fatal("expected GitService to be created")
	}
	if gs.repoRoot != repoRoot {
		t.Errorf("expected repoRoot %s, got %s", repoRoot, gs.repoRoot)
	}
	if gs.tokens == nil {
		t.Error("expected tokens map to be initialized")
	}
}

func TestGitServiceConfigure(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-1"
	repoURL := "https://github.com/user/repo.git"
	encryptedPAT := "encrypted-pat-data"

	// Create user first (required for FK constraint)
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Configure git sync
	err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT)
	if err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// Verify configuration was saved
	config, err := s.Q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get git config: %v", err)
	}
	if config.RepoURL != repoURL {
		t.Errorf("expected repo URL %s, got %s", repoURL, config.RepoURL)
	}
	if config.EncryptedPat != encryptedPAT {
		t.Errorf("expected encrypted PAT %s, got %s", encryptedPAT, config.EncryptedPat)
	}
}

func TestGitServiceConfigureUpdate(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-2"
	repoURL1 := "https://github.com/user/repo1.git"
	repoURL2 := "https://github.com/user/repo2.git"
	encryptedPAT := "encrypted-pat"

	// Create user first
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Initial config
	if err := s.GitService.Configure(ctx, fingerprint, repoURL1, encryptedPAT); err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// Update config
	if err := s.GitService.Configure(ctx, fingerprint, repoURL2, encryptedPAT); err != nil {
		t.Fatalf("failed to update git config: %v", err)
	}

	// Verify update
	config, err := s.Q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get git config: %v", err)
	}
	if config.RepoURL != repoURL2 {
		t.Errorf("expected repo URL %s, got %s", repoURL2, config.RepoURL)
	}
}

func TestGitServiceSetSessionToken(t *testing.T) {
	s := newTestServer(t)

	fingerprint := "test-fp-3"
	token := "test-token-123"

	// Set session token
	s.GitService.SetSessionToken(fingerprint, token)

	// Retrieve token
	retrieved, ok := s.GitService.getSessionToken(fingerprint)
	if !ok {
		t.Fatal("expected to retrieve session token")
	}
	if retrieved != token {
		t.Errorf("expected token %s, got %s", token, retrieved)
	}
}

func TestGitServiceSessionTokenExpiry(t *testing.T) {
	s := newTestServer(t)

	fingerprint := "test-fp-4"
	token := "test-token-456"

	// Manually set an expired token
	s.GitService.mu.Lock()
	s.GitService.tokens[fingerprint] = SessionToken{
		Token:     token,
		ExpiresAt: time.Now().Add(-1 * time.Second), // Already expired
	}
	s.GitService.mu.Unlock()

	// Try to retrieve
	_, ok := s.GitService.getSessionToken(fingerprint)
	if ok {
		t.Error("expected expired token to be invalid")
	}
}

func TestGitServiceGetStatus(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-5"
	repoURL := "https://github.com/user/repo.git"
	encryptedPAT := "encrypted-pat"

	// Create user first
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Before configuration
	status, err := s.GitService.GetStatus(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if status.Configured {
		t.Error("expected not configured before setup")
	}

	// Configure
	if err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT); err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// After configuration
	status, err = s.GitService.GetStatus(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if !status.Configured {
		t.Error("expected configured after setup")
	}
	if status.RepoURL != repoURL {
		t.Errorf("expected repo URL %s, got %s", repoURL, status.RepoURL)
	}
	if !status.HasEncryptedPat {
		t.Error("expected encrypted PAT to be present")
	}
}

func TestGitServiceRepoDir(t *testing.T) {
	s := newTestServer(t)

	fingerprint := "test-fp-6"
	expected := filepath.Join(s.GitService.repoRoot, fingerprint)

	got := s.GitService.repoDir(fingerprint)
	if got != expected {
		t.Errorf("expected repo dir %s, got %s", expected, got)
	}
}

func TestGitServiceAuthURL(t *testing.T) {
	s := newTestServer(t)

	tests := []struct {
		name     string
		repoURL  string
		token    string
		expected string
	}{
		{
			name:     "https URL",
			repoURL:  "https://github.com/user/repo.git",
			token:    "mytoken",
			expected: "https://mytoken@github.com/user/repo.git",
		},
		{
			name:     "ssh URL",
			repoURL:  "git@github.com:user/repo.git",
			token:    "mytoken",
			expected: "git@github.com:user/repo.git",
		},
		{
			name:     "https with subdomain",
			repoURL:  "https://gitlab.com/user/repo.git",
			token:    "mytoken",
			expected: "https://mytoken@gitlab.com/user/repo.git",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := s.GitService.authURL(tt.repoURL, tt.token)
			if got != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, got)
			}
		})
	}
}

func TestGitServiceGetStatusNoConfig(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	// Non-existent fingerprint
	status, err := s.GitService.GetStatus(ctx, "non-existent-fp")
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if status.Configured {
		t.Error("expected not configured for non-existent fingerprint")
	}
	if status.RepoURL != "" {
		t.Errorf("expected empty repo URL, got %s", status.RepoURL)
	}
}

func TestGitServiceLogGitSync(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-7"

	// Create user first
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Log a sync operation
	err := s.Q.LogGitSync(ctx, dbgen.LogGitSyncParams{
		Fingerprint:    fingerprint,
		Operation:      "push",
		Status:         "success",
		Message:        "test message",
		EntriesChanged: 5,
	})
	if err != nil {
		t.Fatalf("failed to log git sync: %v", err)
	}

	// Verify log entry
	logs, err := s.Q.ListGitSyncLog(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to list git sync log: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(logs))
	}
	if logs[0].Operation != "push" {
		t.Errorf("expected operation 'push', got %s", logs[0].Operation)
	}
	if logs[0].Status != "success" {
		t.Errorf("expected status 'success', got %s", logs[0].Status)
	}
	if logs[0].EntriesChanged != 5 {
		t.Errorf("expected 5 entries changed, got %d", logs[0].EntriesChanged)
	}
}
