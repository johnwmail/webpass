package srv

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-git/go-git/v5"
	"golang.org/x/crypto/ssh"

	"srv.exe.dev/db/dbgen"
)

// ---------------------------------------------------------------------------
// SSH Integration Test: Full TOFU + Push/Pull Flow
// ---------------------------------------------------------------------------

func TestGitServiceSSHIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping SSH integration test in short mode")
	}

	s := newTestServer(t)
	ctx := context.Background()
	fingerprint := "test-ssh-int"

	// Create test user
	if err := s.Q.CreateUser(ctx, dbgen.CreateUserParams{
		Fingerprint:  fingerprint,
		PasswordHash: "hash",
		PublicKey:    "pk",
		GpgID:        &fingerprint,
	}); err != nil {
		t.Fatalf("create user: %v", err)
	}

	// Generate host key for SSH server
	hostSigner, _ := generatePEMKey(t)
	hostKeyFingerprint := ssh.FingerprintSHA256(hostSigner.PublicKey())

	// Create bare repo for the SSH server (the "remote")
	serverRepoDir := t.TempDir()
	mustRunGit(t, "init", "--bare", serverRepoDir)

	// Generate client SSH key (the one we'll use for auth)
	_, clientKeyPEM := generatePEMKey(t)

	// Start SSH server on random port
	port := startSSHGitServer(t, hostSigner, serverRepoDir)
	t.Logf("SSH server listening on localhost:%d", port)

	// Construct repo URL
	// Use the bare repo directory path, URL-encoded path style
	remotePath := filepath.ToSlash(serverRepoDir)
	repoURL := fmt.Sprintf("ssh://git@localhost:%d%s", port, remotePath)
	t.Logf("Repo URL: %s", repoURL)

	// Ensure the path doesn't start with // (from empty host part)
	// Actually, serverRepoDir is an absolute path, so remotePath starts with /
	// ssh://git@host:port/path is correct

	// -----------------------------------------------------------------------
	// Step 1: Configure git sync with SSH auth
	// -----------------------------------------------------------------------
	if err := s.GitService.Configure(ctx, fingerprint, repoURL, "", "encrypted-ssh-key-blob", "ssh", "master"); err != nil {
		t.Fatalf("Configure: %v", err)
	}

	// Verify config was saved correctly
	config, err := s.Q.GetGitConfig(ctx, fingerprint)
	if err != nil {
		t.Fatalf("GetGitConfig: %v", err)
	}
	if config.AuthType != "ssh" {
		t.Errorf("expected auth_type ssh, got %s", config.AuthType)
	}
	if config.RepoUrl != repoURL {
		t.Errorf("expected repo URL %s, got %s", repoURL, config.RepoUrl)
	}

	// -----------------------------------------------------------------------
	// Step 2: Push with unknown host → should get HostKeyUnknownError
	// -----------------------------------------------------------------------
	t.Log("--- Step 2: Push with unknown host ---")
	_, err = s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	var hkue *HostKeyUnknownError
	if !errors.As(err, &hkue) {
		t.Fatalf("expected HostKeyUnknownError, got %T: %v", err, err)
	}
	if hkue.Host != "localhost" {
		t.Errorf("expected host 'localhost', got %q", hkue.Host)
	}
	if hkue.Fingerprint != hostKeyFingerprint {
		t.Errorf("expected fingerprint %q, got %q", hostKeyFingerprint, hkue.Fingerprint)
	}
	t.Logf("Got expected HostKeyUnknownError: host=%s, fingerprint=%s", hkue.Host, hkue.Fingerprint)

	// Verify no trusted hosts yet
	hosts, err := s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("GetTrustedHosts: %v", err)
	}
	if len(hosts) != 0 {
		t.Errorf("expected 0 trusted hosts, got %d", len(hosts))
	}

	// -----------------------------------------------------------------------
	// Step 3: Trust the host key
	// -----------------------------------------------------------------------
	t.Log("--- Step 3: Trust host key ---")
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "localhost", hostKeyFingerprint); err != nil {
		t.Fatalf("TrustHostKey: %v", err)
	}

	// Verify trusted host
	hosts, err = s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("GetTrustedHosts after trust: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected 1 trusted host, got %d", len(hosts))
	}
	if hosts[0].Hostname != "localhost" {
		t.Errorf("expected localhost, got %s", hosts[0].Hostname)
	}
	if hosts[0].HostKeyFingerprint != hostKeyFingerprint {
		t.Errorf("expected fingerprint %s, got %s", hostKeyFingerprint, hosts[0].HostKeyFingerprint)
	}

	// -----------------------------------------------------------------------
	// Step 4: Push should now work with trusted host
	// -----------------------------------------------------------------------
	t.Log("--- Step 4: Push with trusted host ---")
	result, err := s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	if err != nil {
		t.Fatalf("Push after trust: %v", err)
	}
	if result.Status != "success" {
		t.Errorf("expected success status, got %s", result.Status)
	}
	t.Logf("Push result: %s (entries: %d)", result.Status, result.EntriesChanged)

	// -----------------------------------------------------------------------
	// Step 5: Add some entries, push again, verify they appear in remote
	// -----------------------------------------------------------------------
	t.Log("--- Step 5: Push entries and verify ---")
	// Create some entries in the DB
	entry1Path := "test/entry1"
	entry1Content := []byte("encrypted-content-1")
	if err := s.Q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
		Fingerprint: fingerprint,
		Path:        entry1Path,
		Content:     entry1Content,
	}); err != nil {
		t.Fatalf("UpsertEntry: %v", err)
	}

	entry2Path := "test/entry2"
	entry2Content := []byte("encrypted-content-2")
	if err := s.Q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
		Fingerprint: fingerprint,
		Path:        entry2Path,
		Content:     entry2Content,
	}); err != nil {
		t.Fatalf("UpsertEntry: %v", err)
	}

	// Push again - should include the new entries
	result, err = s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	if err != nil {
		t.Fatalf("Push entries: %v", err)
	}
	if result.Status != "success" {
		t.Errorf("expected success, got %s", result.Status)
	}
	if result.EntriesChanged != 2 {
		t.Errorf("expected 2 entries changed, got %d", result.EntriesChanged)
	}

	// Verify remote repo has the entries
	verifyRemoteRepo(t, serverRepoDir, map[string][]byte{
		"test/entry1": entry1Content,
		"test/entry2": entry2Content,
	})

	// -----------------------------------------------------------------------
	// Step 6: Pull should work (clone from remote)
	// -----------------------------------------------------------------------
	t.Log("--- Step 6: Pull from remote ---")
	// Clear DB entries
	entries, err := s.Q.ListEntries(ctx, fingerprint)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	for _, e := range entries {
		if err := s.Q.DeleteEntry(ctx, dbgen.DeleteEntryParams{
			Fingerprint: fingerprint,
			Path:        e.Path,
		}); err != nil {
			t.Fatalf("DeleteEntry: %v", err)
		}
	}

	// Pull should restore them
	result, err = s.GitService.Pull(ctx, fingerprint, string(clientKeyPEM))
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if result.Status != "success" {
		t.Errorf("expected success, got %s", result.Status)
	}
	if result.EntriesChanged != 2 {
		t.Errorf("expected 2 entries, got %d", result.EntriesChanged)
	}

	// Verify entries are back in DB
	entry1DB, err := s.Q.GetEntry(ctx, dbgen.GetEntryParams{
		Fingerprint: fingerprint,
		Path:        entry1Path,
	})
	if err != nil {
		t.Fatalf("GetEntry entry1: %v", err)
	}
	if string(entry1DB.Content) != string(entry1Content) {
		t.Errorf("entry1 content mismatch: got %s, expected %s", entry1DB.Content, entry1Content)
	}

	// -----------------------------------------------------------------------
	// Step 7: Host key changes → HostKeyChangedError
	// -----------------------------------------------------------------------
	t.Log("--- Step 7: Host key changed ---")
	// Generate a new host key and start a NEW server on a different port
	newHostSigner, _ := generatePEMKey(t)
	newHostKeyFingerprint := ssh.FingerprintSHA256(newHostSigner.PublicKey())

	newPort := startSSHGitServer(t, newHostSigner, serverRepoDir)
	newRepoURL := fmt.Sprintf("ssh://git@localhost:%d%s", newPort, remotePath)

	// Re-configure with new URL (same remote, different host key)
	if err := s.GitService.Configure(ctx, fingerprint, newRepoURL, "", "encrypted-ssh-key-blob", "ssh", "master"); err != nil {
		t.Fatalf("Configure new URL: %v", err)
	}

	// Push should fail with HostKeyChangedError because the old fingerprint doesn't match
	_, err = s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	var hkce *HostKeyChangedError
	if !errors.As(err, &hkce) {
		t.Fatalf("expected HostKeyChangedError, got %T: %v", err, err)
	}
	if hkce.Host != "localhost" {
		t.Errorf("expected host localhost, got %s", hkce.Host)
	}
	if hkce.OldFingerprint != hostKeyFingerprint {
		t.Errorf("expected old fingerprint %s, got %s", hostKeyFingerprint, hkce.OldFingerprint)
	}
	if hkce.NewFingerprint != newHostKeyFingerprint {
		t.Errorf("expected new fingerprint %s, got %s", newHostKeyFingerprint, hkce.NewFingerprint)
	}
	t.Logf("Got expected HostKeyChangedError: old=%s, new=%s", hkce.OldFingerprint, hkce.NewFingerprint)

	// -----------------------------------------------------------------------
	// Step 8: Trust new host key and push works again
	// -----------------------------------------------------------------------
	t.Log("--- Step 8: Trust new key and push ---")
	if err := s.GitService.TrustHostKey(ctx, fingerprint, "localhost", newHostKeyFingerprint); err != nil {
		t.Fatalf("TrustHostKey new: %v", err)
	}

	// Add a new entry so there's something to commit
	entry3Path := "test/entry3"
	entry3Content := []byte("encrypted-content-3")
	if err := s.Q.UpsertEntry(ctx, dbgen.UpsertEntryParams{
		Fingerprint: fingerprint,
		Path:        entry3Path,
		Content:     entry3Content,
	}); err != nil {
		t.Fatalf("UpsertEntry entry3: %v", err)
	}

	// Push should now work (with new content)
	result, err = s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	if err != nil {
		t.Fatalf("Push after re-trust: %v", err)
	}
	if result.Status != "success" {
		t.Errorf("expected success, got %s", result.Status)
	}
	if result.EntriesChanged != 3 {
		t.Errorf("expected 3 entries, got %d", result.EntriesChanged)
	}

	// Verify remote repo has all 3 entries and .gpg-id
	verifyRemoteRepo(t, serverRepoDir, map[string][]byte{
		"test/entry1": entry1Content,
		"test/entry2": entry2Content,
		"test/entry3": entry3Content,
	})
	verifyRemoteHasGPGID(t, serverRepoDir, fingerprint)

	// -----------------------------------------------------------------------
	// Step 9: Delete trusted host and verify it's gone
	// -----------------------------------------------------------------------
	t.Log("--- Step 9: Delete trusted host ---")
	if err := s.GitService.DeleteTrustedHost(ctx, fingerprint, "localhost"); err != nil {
		t.Fatalf("DeleteTrustedHost: %v", err)
	}

	hosts, err = s.GitService.GetTrustedHosts(ctx, fingerprint)
	if err != nil {
		t.Fatalf("GetTrustedHosts after delete: %v", err)
	}
	if len(hosts) != 0 {
		t.Errorf("expected 0 trusted hosts after delete, got %d", len(hosts))
	}

	// Push should fail again (host unknown)
	_, err = s.GitService.Push(ctx, fingerprint, string(clientKeyPEM))
	if !errors.As(err, &hkue) {
		t.Fatalf("expected HostKeyUnknownError after delete, got %T: %v", err, err)
	}
	t.Log("Push correctly fails with HostKeyUnknownError after deleting trusted host")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// generatePEMKey generates an ed25519 key pair and returns the SSH signer
// and PEM-encoded private key bytes (PKCS#8 format).
func generatePEMKey(t *testing.T) (ssh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}

	b, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: b,
	})

	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("create signer: %v", err)
	}

	return signer, pemBytes
}

// startSSHGitServer starts an SSH server on a random port that handles
// git-upload-pack and git-receive-pack commands for the given repoDir.
// Returns the port number. The server is automatically stopped on test cleanup.
func startSSHGitServer(t *testing.T, hostKey ssh.Signer, repoDir string) int {
	t.Helper()

	config := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			t.Logf("SSH auth: user=%s, fingerprint=%s", conn.User(), ssh.FingerprintSHA256(key))
			// Accept any public key for testing
			return &ssh.Permissions{}, nil
		},
	}
	config.AddHostKey(hostKey)

	listener, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatalf("SSH listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	port := listener.Addr().(*net.TCPAddr).Port

	var wg sync.WaitGroup
	wg.Add(1)

	go func() {
		wg.Done()
		for {
			nConn, err := listener.Accept()
			if err != nil {
				return
			}
			go handleSSHGitConnection(t, nConn, config, repoDir)
		}
	}()

	wg.Wait() // Wait for goroutine to start
	return port
}

// handleSSHGitConnection handles a single SSH connection for git operations.
func handleSSHGitConnection(t *testing.T, nConn net.Conn, config *ssh.ServerConfig, repoDir string) {
	conn, chans, reqs, err := ssh.NewServerConn(nConn, config)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()

	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unknown channel type")
			continue
		}

		channel, requests, err := newChannel.Accept()
		if err != nil {
			continue
		}

		// Handle requests for this session channel
		go func() {
			defer func() { _ = channel.Close() }()
			for req := range requests {
				if req.Type == "exec" {
					var payload struct{ Command string }
					if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
						t.Logf("SSH exec unmarshal error: %v", err)
						_ = req.Reply(false, nil)
						continue
					}

					t.Logf("SSH exec: %s", payload.Command)

					// Parse command: "git-upload-pack /path" or "git-receive-pack /path"
					parts := strings.Fields(payload.Command)
					if len(parts) != 2 {
						t.Logf("invalid command: %q", payload.Command)
						_ = req.Reply(false, nil)
						continue
					}

					gitCmd := parts[0]
					repoPath := strings.Trim(parts[1], "'")

					// Resolve path - if relative, make it absolute under repoDir
					if !filepath.IsAbs(repoPath) {
						repoPath = filepath.Join(repoDir, repoPath)
					}

					cmd := exec.Command(gitCmd, repoPath)
					cmd.Dir = repoDir
					cmd.Stdout = channel
					cmd.Stdin = channel
					cmd.Stderr = channel.Stderr()

					if err := cmd.Start(); err != nil {
						t.Logf("git command start error: %v", err)
						_ = req.Reply(false, nil)
						return
					}

					// Reply success - command started
					req.Reply(true, nil)

					// Wait for command to complete
					if err := cmd.Wait(); err != nil {
						t.Logf("git command error: %v", err)
					}
					return
				}
			}
		}()
	}
}

// mustRunGit runs a git command, failing the test on error.
func mustRunGit(t *testing.T, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
	return string(out)
}

// verifyRemoteHasGPGID checks that the bare repo contains a .gpg-id file with the expected ID.
func verifyRemoteHasGPGID(t *testing.T, bareRepoDir, expectedGPGID string) {
	t.Helper()
	cloneDir := t.TempDir()
	_, err := git.PlainClone(cloneDir, false, &git.CloneOptions{
		URL: bareRepoDir,
	})
	if err != nil {
		t.Fatalf("clone bare repo for gpg-id check: %v", err)
	}
	content, err := exec.Command("git", "-C", cloneDir, "show", "HEAD:.gpg-id").Output()
	if err != nil {
		t.Fatalf(".gpg-id not found in remote: %v", err)
	}
	if strings.TrimSpace(string(content)) != expectedGPGID {
		t.Errorf("expected .gpg-id %q, got %q", expectedGPGID, strings.TrimSpace(string(content)))
	}
}

// verifyRemoteRepo checks that the bare repo contains the expected .gpg files.
func verifyRemoteRepo(t *testing.T, bareRepoDir string, expected map[string][]byte) {
	t.Helper()

	// Clone the bare repo to a temp dir for inspection
	cloneDir := t.TempDir()
	_, err := git.PlainClone(cloneDir, false, &git.CloneOptions{
		URL: bareRepoDir,
	})
	if err != nil {
		t.Fatalf("clone bare repo for verification: %v", err)
	}

	for path, expectedContent := range expected {
		content, err := exec.Command("git", "-C", cloneDir, "show", "HEAD:"+path+".gpg").Output()
		if err != nil {
			t.Errorf("file %s.gpg not found in remote: %v", path, err)
			continue
		}
		if string(content) != string(expectedContent) {
			t.Errorf("content mismatch for %s: got %s, expected %s", path, string(content), string(expectedContent))
		}
	}
}
