package srv

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/johnwmail/webpass/db/dbgen"
)

func TestGitServiceNew(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")
	repoRoot := filepath.Join(tmpDir, "git-repos")

	srv := newTestServer(t)
	gs := NewGitService(dbPath, srv.DB, srv.Q, repoRoot)

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
	err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT, "", "https", "HEAD")
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
	if err := s.GitService.Configure(ctx, fingerprint, repoURL1, encryptedPAT, "", "https", "HEAD"); err != nil {
		t.Fatalf("failed to configure git: %v", err)
	}

	// Update config
	if err := s.GitService.Configure(ctx, fingerprint, repoURL2, encryptedPAT, "", "https", "HEAD"); err != nil {
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
	if err := s.GitService.Configure(ctx, fingerprint, repoURL, encryptedPAT, "", "https", "HEAD"); err != nil {
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

	got, err := s.GitService.repoDir(fingerprint)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != expected {
		t.Errorf("expected repo dir %s, got %s", expected, got)
	}
}

func TestGitServiceRepoDirRejectsTraversal(t *testing.T) {
	s := newTestServer(t)

	for _, fp := range []string{
		"",
		".",
		"..",
		"../escape",
		"..%2fescape",
		"a/b",
		`a\b`,
		"a/../b",
		"../../data/db",
	} {
		t.Run(fp, func(t *testing.T) {
			if _, err := s.GitService.repoDir(fp); err == nil {
				t.Fatalf("expected repoDir(%q) to fail", fp)
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

// ---------------------------------------------------------------------------
// SSH Known Hosts Tests
// ---------------------------------------------------------------------------

func TestGitServiceTrustHostKey(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-kh-1"
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Trust a host key
	err := s.GitService.TrustHostKey(ctx, fingerprint, "github.com", "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8")
	if err != nil {
		t.Fatalf("failed to trust host key: %v", err)
	}

	// List trusted hosts
	hosts, err := s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to list trusted hosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 trusted host, got %d", len(hosts))
	}
	if hosts[0].Hostname != "github.com" {
		t.Errorf("expected hostname github.com, got %s", hosts[0].Hostname)
	}
	if hosts[0].HostKeyFingerprint != "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8" {
		t.Errorf("unexpected fingerprint: %s", hosts[0].HostKeyFingerprint)
	}
}

func TestGitServiceTrustHostKeyWithPort(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-kh-2"
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Trust with host:port — should strip port
	err := s.GitService.TrustHostKey(ctx, fingerprint, "github.com:22", "SHA256:test")
	if err != nil {
		t.Fatalf("failed to trust host key: %v", err)
	}

	hosts, err := s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to list trusted hosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 trusted host, got %d", len(hosts))
	}
	// Port should be stripped, stored as just "github.com"
	if hosts[0].Hostname != "github.com" {
		t.Errorf("expected hostname github.com, got %s", hosts[0].Hostname)
	}
}

func TestGitServiceDeleteTrustedHost(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-kh-3"
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Trust a host
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "github.com", "SHA256:fp1"); err != nil {
		t.Fatalf("failed to trust host key: %v", err)
	}
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "gitlab.com", "SHA256:fp2"); err != nil {
		t.Fatalf("failed to trust host key: %v", err)
	}

	// Delete one
	if err := s.GitService.DeleteTrustedHost(ctx, fingerprint, "github.com"); err != nil {
		t.Fatalf("failed to delete trusted host: %v", err)
	}

	hosts, err := s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to list trusted hosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 trusted host after delete, got %d", len(hosts))
	}
	if hosts[0].Hostname != "gitlab.com" {
		t.Errorf("expected gitlab.com, got %s", hosts[0].Hostname)
	}
}

func TestGitServiceUpdateTrustedHostKey(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	fingerprint := "test-fp-kh-4"
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Trust with initial key
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "github.com", "SHA256:oldfp"); err != nil {
		t.Fatalf("failed to trust host key: %v", err)
	}

	// Update with new key (same host)
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "github.com", "SHA256:newfp"); err != nil {
		t.Fatalf("failed to update host key: %v", err)
	}

	hosts, err := s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("failed to list trusted hosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 trusted host, got %d", len(hosts))
	}
	if hosts[0].HostKeyFingerprint != "SHA256:newfp" {
		t.Errorf("expected updated fingerprint, got %s", hosts[0].HostKeyFingerprint)
	}
}

// ---------------------------------------------------------------------------
// Repository content hardening (regression: symlink file read / path escape)
// ---------------------------------------------------------------------------

func mustCreateUser(t *testing.T, s *Server, fingerprint string) {
	t.Helper()
	if err := s.Q.CreateUser(context.Background(), dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}
}

func TestSyncDatabase_IgnoresSymlinksAndOversizedFiles(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	fp := "symlink-fp"
	mustCreateUser(t, s, fp)

	repoDir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repoDir, 0700); err != nil {
		t.Fatalf("create repo dir: %v", err)
	}

	// A file outside the repo that an attacker would like the server to read.
	secretPath := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secretPath, []byte("top-secret"), 0600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	if err := os.Symlink(secretPath, filepath.Join(repoDir, "evil.gpg")); err != nil {
		t.Skipf("symlinks not supported on this platform: %v", err)
	}

	// A legitimate entry plus an oversized one.
	if err := os.WriteFile(filepath.Join(repoDir, "good.gpg"), []byte("good"), 0600); err != nil {
		t.Fatalf("write good entry: %v", err)
	}
	big := bytes.Repeat([]byte("x"), maxEntrySize+1)
	if err := os.WriteFile(filepath.Join(repoDir, "big.gpg"), big, 0600); err != nil {
		t.Fatalf("write oversized entry: %v", err)
	}

	count, err := s.GitService.syncDatabase(ctx, fp, repoDir)
	if err != nil {
		t.Fatalf("syncDatabase: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected only the regular in-size entry to be imported, got %d", count)
	}

	entries, err := s.Q.ListEntries(ctx, fp)
	if err != nil {
		t.Fatalf("list entries: %v", err)
	}
	if len(entries) != 1 || entries[0].Path != "good" {
		t.Fatalf("expected only 'good', got %+v", entries)
	}

	// The symlink target must never be stored.
	if _, err := s.Q.GetEntry(ctx, dbgen.GetEntryParams{Fingerprint: fp, Path: "evil"}); err == nil {
		t.Fatal("symlinked file was imported into the database")
	}
}

func TestExportPasswordStore_SkipsUnsafePaths(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	fp := "export-fp"
	mustCreateUser(t, s, fp)

	// Simulate a legacy/buggy row that escaped path validation.
	for _, p := range []string{"../escaped", "good"} {
		if err := s.Q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        p,
			Content:     []byte("data"),
		}); err != nil {
			t.Fatalf("upsert entry %q: %v", p, err)
		}
	}

	root := t.TempDir()
	repoDir := filepath.Join(root, "repo")
	if err := os.MkdirAll(repoDir, 0700); err != nil {
		t.Fatalf("create repo dir: %v", err)
	}

	count, err := s.GitService.exportPasswordStore(ctx, fp, repoDir)
	if err != nil {
		t.Fatalf("exportPasswordStore: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected only the safe entry to be exported, got %d", count)
	}

	if _, err := os.Stat(filepath.Join(root, "escaped.gpg")); err == nil {
		t.Fatal("unsafe entry escaped the repo directory")
	}
	if _, err := os.Stat(filepath.Join(repoDir, "good.gpg")); err != nil {
		t.Fatalf("expected good.gpg to be written: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Git remote URL validation (#6)
// ---------------------------------------------------------------------------

func TestValidateRepoURL(t *testing.T) {
	t.Setenv("GIT_ALLOW_LOCAL_REPOS", "false")
	t.Setenv("GIT_ALLOW_PRIVATE_NETWORKS", "false")
	t.Setenv("GIT_ALLOW_INSECURE_HTTP", "false")

	valid := []string{
		"https://203.0.113.10/user/repo.git",
		"https://github.com/user/repo.git",
		"ssh://git@203.0.113.10/user/repo.git",
		"git@203.0.113.10:user/repo.git",
	}
	for _, raw := range valid {
		if _, err := validateRepoURL(raw); err != nil {
			t.Errorf("expected %q to be valid, got %v", raw, err)
		}
	}

	invalid := []string{
		"",
		"file:///tmp/repo.git",
		"http://203.0.113.10/repo.git",
		"ftp://203.0.113.10/repo.git",
		"https://user:pass@203.0.113.10/repo.git",
		"https://127.0.0.1/repo.git",
		"https://localhost/repo.git",
		"https://10.1.2.3/repo.git",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/repo.git",
		"ssh://git@127.0.0.1/repo.git",
		"git@127.0.0.1:repo.git",
		"not a url",
	}
	for _, raw := range invalid {
		if _, err := validateRepoURL(raw); err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}

func TestValidateRepoURLOptIns(t *testing.T) {
	t.Run("file remotes", func(t *testing.T) {
		t.Setenv("GIT_ALLOW_LOCAL_REPOS", "true")
		if _, err := validateRepoURL("file:///tmp/repo.git"); err != nil {
			t.Fatalf("expected file:// to be allowed, got %v", err)
		}
	})

	t.Run("private networks", func(t *testing.T) {
		t.Setenv("GIT_ALLOW_PRIVATE_NETWORKS", "true")
		for _, raw := range []string{
			"https://127.0.0.1/repo.git",
			"https://10.1.2.3/repo.git",
			"git@192.168.1.10:repo.git",
		} {
			if _, err := validateRepoURL(raw); err != nil {
				t.Fatalf("expected %q to be allowed, got %v", raw, err)
			}
		}
	})

	t.Run("insecure http", func(t *testing.T) {
		t.Setenv("GIT_ALLOW_INSECURE_HTTP", "true")
		if _, err := validateRepoURL("http://203.0.113.10/repo.git"); err != nil {
			t.Fatalf("expected http:// to be allowed, got %v", err)
		}
	})
}

func TestValidateGitBranch(t *testing.T) {
	for _, branch := range []string{"HEAD", "main", "feature/x", "release-1.0"} {
		if err := validateGitBranch(branch); err != nil {
			t.Errorf("expected %q to be valid, got %v", branch, err)
		}
	}
	for _, branch := range []string{"", "../x", "a..b", "/main", "main/", "a b", "a;b", "a\nb"} {
		if err := validateGitBranch(branch); err == nil {
			t.Errorf("expected %q to be rejected", branch)
		}
	}
}

func TestGitServiceConfigureRejectsUnsafeURL(t *testing.T) {
	t.Setenv("GIT_ALLOW_LOCAL_REPOS", "false")
	t.Setenv("GIT_ALLOW_PRIVATE_NETWORKS", "false")

	s := newTestServer(t)
	fp := "cfg-reject-fp"
	mustCreateUser(t, s, fp)

	for _, raw := range []string{
		"file:///etc/passwd",
		"https://127.0.0.1/repo.git",
		"https://user:pass@203.0.113.10/repo.git",
	} {
		if err := s.GitService.Configure(context.Background(), fp, raw, "", "", "https", "HEAD"); err == nil {
			t.Errorf("expected Configure(%q) to fail", raw)
		}
	}
}

func TestGitServiceClearSessionToken(t *testing.T) {
	s := newTestServer(t)
	fp := "clear-token-fp"
	s.GitService.SetSessionToken(fp, "plaintext-pat")
	if _, ok := s.GitService.getSessionToken(fp); !ok {
		t.Fatal("expected token to be cached")
	}
	s.GitService.ClearSessionToken(fp)
	if _, ok := s.GitService.getSessionToken(fp); ok {
		t.Fatal("expected token to be cleared")
	}
}

func TestSyncDatabaseRefusesEmptyRepo(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	fp := "empty-repo-fp"
	mustCreateUser(t, s, fp)

	if err := s.Q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
		Fingerprint: fp,
		Path:        "keep",
		Content:     []byte("data"),
	}); err != nil {
		t.Fatalf("seed entry: %v", err)
	}

	repoDir := t.TempDir() // empty repository (only an empty dir)
	if _, err := s.GitService.syncDatabase(ctx, fp, repoDir); err == nil {
		t.Fatal("expected empty repository to be refused")
	}

	entries, err := s.Q.ListEntries(ctx, fp)
	if err != nil {
		t.Fatalf("list entries: %v", err)
	}
	if len(entries) != 1 || entries[0].Path != "keep" {
		t.Fatalf("local entries should be preserved, got %+v", entries)
	}
}

func TestValidateRepoURLAllowedHosts(t *testing.T) {
	t.Setenv("GIT_ALLOWED_HOSTS", "github.com,example.com")

	for _, raw := range []string{
		"https://github.com/user/repo.git",
		"https://sub.example.com/user/repo.git",
	} {
		if _, err := validateRepoURL(raw); err != nil {
			t.Errorf("expected %q to be allowed, got %v", raw, err)
		}
	}
	for _, raw := range []string{
		"https://gitlab.com/user/repo.git",
		"https://example.net/user/repo.git",
		"https://203.0.113.10/user/repo.git",
	} {
		if _, err := validateRepoURL(raw); err == nil {
			t.Errorf("expected %q to be rejected by GIT_ALLOWED_HOSTS", raw)
		}
	}
}
