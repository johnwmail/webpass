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
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Configure git sync
	err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT, "HEAD")
	if err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// Verify configuration was saved
	config, err := s.Q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get git config: %v", err)
	}
	if config.RepoUrl != repoURL {
		t.Errorf("expected repo URL %s, got %s", repoURL, config.RepoUrl)
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
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Initial config
	if err := s.GitService.Configure(ctx, fingerprint, repoURL1, encryptedPAT, "HEAD"); err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// Update config
	if err := s.GitService.Configure(ctx, fingerprint, repoURL2, encryptedPAT, "HEAD"); err != nil {
		t.Fatalf("failed to update git config: %v", err)
	}

	// Verify update
	config, err := s.Q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get git config: %v", err)
	}
	if config.RepoUrl != repoURL2 {
		t.Errorf("expected repo URL %s, got %s", repoURL2, config.RepoUrl)
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
		GpgID:        &fingerprint,
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
	if err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT, "HEAD"); err != nil {
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
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Log a sync operation
	msg := "test message"
	var entriesChanged int64 = 5
	err := s.Q.LogGitSync(ctx, dbgen.LogGitSyncParams{
		Fingerprint:    fingerprint,
		Operation:      "push",
		Status:         "success",
		Message:        &msg,
		EntriesChanged: &entriesChanged,
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
	if logs[0].EntriesChanged == nil || *logs[0].EntriesChanged != 5 {
		t.Errorf("expected 5 entries changed, got %v", logs[0].EntriesChanged)
	}
}

func TestGitServiceUpdateUserGpgID(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-8"
	gpgID := "0xDEADBEEF"

	// Create user first (gpg_id defaults to fingerprint via CreateUserParams)
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Verify initial gpg_id is the fingerprint
	user, err := s.Q.GetUser(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get user: %v", err)
	}
	if user.GpgID == nil || *user.GpgID != fingerprint {
		t.Errorf("expected initial gpg_id %s, got %v", fingerprint, user.GpgID)
	}

	// Update gpg_id via UpdateUserGpgID
	if err := s.Q.UpdateUserGpgID(ctx, dbgen.UpdateUserGpgIDParams{
		GpgID:       &gpgID,
		Fingerprint: fingerprint,
	}); err != nil {
		t.Fatalf("failed to update gpg_id: %v", err)
	}

	// Verify gpg_id was updated in users table
	user, err = s.Q.GetUser(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to get user: %v", err)
	}
	if user.GpgID == nil || *user.GpgID != gpgID {
		t.Errorf("expected gpg_id %s, got %v", gpgID, user.GpgID)
	}
}
