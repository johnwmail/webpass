package srv

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// ---------------------------------------------------------------------------
// Rate Limiter Tests
// ---------------------------------------------------------------------------

func TestRateLimiter_Allow(t *testing.T) {
	// Use very short window for testing
	t.Setenv("RATE_LIMIT_ATTEMPTS", "3")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "test-key-1"

	// First 3 requests should be allowed
	for i := 0; i < 3; i++ {
		if !rl.Allow(key) {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}

	// 4th request should be rejected
	if rl.Allow(key) {
		t.Fatal("request 4 should be rejected")
	}
}

func TestRateLimiter_DifferentKeys(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	// Key 1: use up the limit
	rl.Allow("key1")
	rl.Allow("key1")
	if rl.Allow("key1") {
		t.Fatal("key1 third request should be rejected")
	}

	// Key 2: should still have full limit
	if !rl.Allow("key2") {
		t.Fatal("key2 first request should be allowed")
	}
	if !rl.Allow("key2") {
		t.Fatal("key2 second request should be allowed")
	}
	if rl.Allow("key2") {
		t.Fatal("key2 third request should be rejected")
	}
}

func TestRateLimiter_Remaining(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "5")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "test-key"

	// Initially should have 5 remaining
	if rem := rl.Remaining(key); rem != 5 {
		t.Fatalf("expected 5 remaining, got %d", rem)
	}

	// After 2 requests, should have 3 remaining
	rl.Allow(key)
	rl.Allow(key)
	if rem := rl.Remaining(key); rem != 3 {
		t.Fatalf("expected 3 remaining after 2 requests, got %d", rem)
	}

	// After hitting limit, should have 0 remaining
	rl.Allow(key)
	rl.Allow(key)
	rl.Allow(key)
	if rem := rl.Remaining(key); rem != 0 {
		t.Fatalf("expected 0 remaining after hitting limit, got %d", rem)
	}
}

func TestRateLimiter_IsAllowed(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "test-key"

	// IsAllowed should not record the request
	if !rl.IsAllowed(key) {
		t.Fatal("should be allowed initially")
	}
	if !rl.IsAllowed(key) {
		t.Fatal("should still be allowed (IsAllowed doesn't record)")
	}

	// After recording requests, IsAllowed should reflect the state
	rl.Allow(key)
	rl.Allow(key)
	if rl.IsAllowed(key) {
		t.Fatal("should not be allowed after hitting limit")
	}
}

func TestRateLimiter_WindowExpiry(t *testing.T) {
	// Use very short window for testing
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "test-key"

	// Use up the limit
	rl.Allow(key)
	rl.Allow(key)
	if rl.Allow(key) {
		t.Fatal("should be rate limited")
	}

	// Manually expire the timestamps by modifying the internal state
	// This simulates time passing
	rl.mu.Lock()
	if timestamps, ok := rl.requests[key]; ok {
		// Set timestamps to 2 minutes ago (beyond the 1-minute window)
		for i := range timestamps {
			timestamps[i] = time.Now().Add(-2 * time.Minute)
		}
		rl.requests[key] = timestamps
	}
	rl.mu.Unlock()

	// Now should be allowed again (old timestamps expired)
	if !rl.Allow(key) {
		t.Fatal("should be allowed after window expires")
	}
}

func TestRateLimiter_Reset(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "login:fp:reset"
	rl.Allow(key)
	rl.Allow(key)
	if rl.Allow(key) {
		t.Fatal("expected the key to be rate limited")
	}

	rl.Reset(key)
	if rem := rl.Remaining(key); rem != 2 {
		t.Fatalf("expected full budget after reset, got %d", rem)
	}
	if !rl.Allow(key) {
		t.Fatal("expected a request to be allowed after reset")
	}
}

func TestRateLimiter_Release(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	rl := NewRateLimiter()
	defer rl.Stop()

	key := "login:ip:release"
	rl.Allow(key)
	rl.Allow(key)
	if rl.Allow(key) {
		t.Fatal("expected the key to be rate limited")
	}

	rl.Release(key)
	if rem := rl.Remaining(key); rem != 1 {
		t.Fatalf("expected one remaining after release, got %d", rem)
	}
	if !rl.Allow(key) {
		t.Fatal("expected a request to be allowed after release")
	}
	if rl.Allow(key) {
		t.Fatal("expected the key to be rate limited again")
	}
}

func TestLoginRateLimitResetsAfterSuccess(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "3")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "15")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"rlfp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	for i := 0; i < 2; i++ {
		resp = doReq(t, ts, "POST", "/api/rlfp1/login", `{"password":"wrongpassword"}`, "")
		expectStatus(t, resp, http.StatusUnauthorized)
		_ = resp.Body.Close()
	}

	resp = doReq(t, ts, "POST", "/api/rlfp1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	// The per-account budget is cleared, so earlier mistakes do not count.
	if rem := s.RateLimiter.Remaining("login:fp:rlfp1"); rem != 3 {
		t.Fatalf("expected account budget reset to 3, got %d", rem)
	}
	// The per-IP budget keeps the two failures and only refunds the successful
	// attempt, so a valid account cannot be used to clear IP-level spraying
	// protection.
	if rem := s.RateLimiter.Remaining("login:ip:127.0.0.1"); rem != 1 {
		t.Fatalf("expected IP budget to keep 2 failures and refund the success, got %d remaining", rem)
	}
}

func TestRateLimiter_EnvConfig(t *testing.T) {
	// Test custom configuration via environment
	t.Setenv("RATE_LIMIT_ATTEMPTS", "10")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "30")

	rl := NewRateLimiter()
	defer rl.Stop()

	// Should use custom values
	if rl.limit != 10 {
		t.Fatalf("expected limit 10, got %d", rl.limit)
	}
	if rl.window != 30*time.Minute {
		t.Fatalf("expected window 30m, got %v", rl.window)
	}
}

func TestRateLimiter_InvalidEnv(t *testing.T) {
	// Test invalid environment values (should use defaults)
	t.Setenv("RATE_LIMIT_ATTEMPTS", "invalid")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "-5")

	rl := NewRateLimiter()
	defer rl.Stop()

	// Should use defaults
	if rl.limit != defaultLimit {
		t.Fatalf("expected default limit %d, got %d", defaultLimit, rl.limit)
	}
	if rl.window != defaultWindowMin*time.Minute {
		t.Fatalf("expected default window %dm, got %v", defaultWindowMin, rl.window)
	}
}

func TestRateLimitMiddleware_Integration(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "3")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	fp := "ratelimit-test"

	// First 3 login attempts should be processed (may fail auth, but not rate limited)
	for i := 0; i < 3; i++ {
		resp := doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"wrongpassword"}`, "")
		// Should get 401 (invalid credentials), not 429 (rate limited)
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("request %d should not be rate limited", i+1)
		}
	}

	// 4th attempt should be rate limited
	resp := doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"wrongpassword"}`, "")
	expectStatus(t, resp, http.StatusTooManyRequests)
}

func TestRateLimit_Registration(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")
	t.Setenv("REGISTRATION_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// First 2 registration attempts should be processed
	for i := 0; i < 2; i++ {
		body := `{"password":"password1234","public_key":"pk` + string(rune('0'+i)) + `","fingerprint":"fp` + string(rune('0'+i)) + `"}`
		resp := doReq(t, ts, "POST", "/api", body, "")
		// Should not be rate limited (may get other errors, but not 429)
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("registration %d should not be rate limited", i+1)
		}
	}

	// 3rd registration should be rate limited
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk3","fingerprint":"fp3"}`, "")
	expectStatus(t, resp, http.StatusTooManyRequests)
}

func TestRateLimit_LoginFailures(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"fp2fa"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	// Two failed password checks exhaust the budget.
	for i := 0; i < 2; i++ {
		resp = doReq(t, ts, "POST", "/api/fp2fa/login", `{"password":"wrongpassword"}`, "")
		expectStatus(t, resp, http.StatusUnauthorized)
		_ = resp.Body.Close()
	}

	// The next attempt is blocked before the password is even checked.
	resp = doReq(t, ts, "POST", "/api/fp2fa/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusTooManyRequests)
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

// newTestServer creates a Server backed by a temp SQLite DB.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	// bcrypt cost 10 keeps the suite fast; the production default (12) and
	// configurable costs are covered by TestBcryptCost_*.
	t.Setenv("BCRYPT_COST", "10")
	return newTestServerRaw(t)
}

// newTestServerRaw is like newTestServer but leaves BCRYPT_COST untouched.
func newTestServerRaw(t *testing.T) *Server {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.sqlite3")
	t.Cleanup(func() { _ = os.Remove(dbPath) })

	// Set temp git repo root for tests
	gitRepoRoot := filepath.Join(t.TempDir(), "git-repos")
	t.Setenv("GIT_REPO_ROOT", gitRepoRoot)

	// Enable registration for tests (open mode, no TOTP secret required)
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("REGISTRATION_TOTP_SECRET", "") // Clear TOTP secret for open registration

	key := []byte("test-secret-key-32-bytes-long!!!") // exactly 32 bytes
	srv, err := New(dbPath, key, 5, 5)                // 5 minutes hard/soft limit for tests
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(func() { _ = srv.DB.Close() })
	t.Cleanup(func() { srv.RateLimiter.Stop() })
	return srv
}

func TestFullCRUDFlow(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// 1. Create user (exempt from CSRF)
	body := `{"password":"hunter2password","public_key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test","fingerprint":"abc123"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)
	var createResp map[string]string
	decodeJSON(t, resp, &createResp)
	if createResp["fingerprint"] != "abc123" {
		t.Fatalf("expected fingerprint abc123, got %s", createResp["fingerprint"])
	}
	fp := createResp["fingerprint"]

	// 2. Login (exempt from CSRF)
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"hunter2password"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]
	if token == "" {
		t.Fatal("expected token in login response")
	}

	// 3. PUT entry (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/"+fp+"/entries/Email/gmail", []byte("encrypted-blob-data"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// 4. List entries
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
	var listResp struct {
		Entries []struct {
			Path    string     `json:"path"`
			Created *time.Time `json:"created"`
			Updated *time.Time `json:"updated"`
		} `json:"entries"`
	}
	decodeJSON(t, resp, &listResp)
	if len(listResp.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(listResp.Entries))
	}
	if listResp.Entries[0].Path != "Email/gmail" {
		t.Fatalf("expected path Email/gmail, got %s", listResp.Entries[0].Path)
	}

	// 5. GET entry blob
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries/Email/gmail", "", token)
	expectStatus(t, resp, http.StatusOK)
	gotBlob, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(gotBlob) != "encrypted-blob-data" {
		t.Fatalf("expected blob 'encrypted-blob-data', got %q", string(gotBlob))
	}

	// 6. Move entry (requires CSRF)
	resp = doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/entries/move", `{"from":"Email/gmail","to":"Email/gmail-moved"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Verify moved
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries/Email/gmail-moved", "", token)
	expectStatus(t, resp, http.StatusOK)
	gotBlob, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(gotBlob) != "encrypted-blob-data" {
		t.Fatalf("moved entry has wrong content: %q", string(gotBlob))
	}

	// Old path should be gone
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries/Email/gmail", "", token)
	expectStatus(t, resp, http.StatusNotFound)

	// 7. Delete entry (requires CSRF)
	resp = doReqWithCSRF(t, ts, "DELETE", "/api/"+fp+"/entries/Email/gmail-moved", "", token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Verify deleted
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries/Email/gmail-moved", "", token)
	expectStatus(t, resp, http.StatusNotFound)
}

func TestUnauthorized(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// No token at all
	resp := doReq(t, ts, "GET", "/api/abc123/entries", "", "")
	expectStatus(t, resp, http.StatusUnauthorized)

	// Bad token
	resp = doReq(t, ts, "GET", "/api/abc123/entries", "", "bad-token")
	expectStatus(t, resp, http.StatusUnauthorized)

	// Wrong fingerprint in token
	createUserAndGetToken := func(fp, pw string) string {
		body := `{"password":"` + pw + `","public_key":"key-` + fp + `","fingerprint":"` + fp + `"}`
		resp := doReq(t, ts, "POST", "/api", body, "")
		expectStatus(t, resp, http.StatusCreated)
		resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"`+pw+`"}`, "")
		expectStatus(t, resp, http.StatusOK)
		var lr map[string]string
		decodeJSON(t, resp, &lr)
		return lr["token"]
	}

	tokenA := createUserAndGetToken("userA", "passA12345678")
	createUserAndGetToken("userB", "passB12345678")

	// userA's token trying to access userB's entries
	resp = doReq(t, ts, "GET", "/api/userB/entries", "", tokenA)
	expectStatus(t, resp, http.StatusForbidden)
}

func TestLoginWrongPassword(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"correctpassword","public_key":"pk1","fingerprint":"fp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Wrong password
	resp = doReq(t, ts, "POST", "/api/fp1/login", `{"password":"wrongpassword"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestDuplicateUser(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	body := `{"password":"password1234","public_key":"pk","fingerprint":"dup1"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusConflict)
}

func TestTOTPFlow(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"totp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api/totp1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Setup TOTP (requires CSRF)
	resp = doReqWithCSRF(t, ts, "POST", "/api/totp1/totp/setup", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var setupResp map[string]string
	decodeJSON(t, resp, &setupResp)
	secret := setupResp["secret"]
	if secret == "" {
		t.Fatal("expected totp secret")
	}
	if setupResp["url"] == "" {
		t.Fatal("expected totp url")
	}

	// Generate a valid TOTP code from the secret
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp code: %v", err)
	}

	// Confirm TOTP (requires CSRF)
	confirmBody := `{"secret":"` + secret + `","code":"` + code + `","current_password":"password1234"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/totp1/totp/confirm", confirmBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var confirmResp map[string]any
	decodeJSON(t, resp, &confirmResp)
	if confirmResp["enabled"] != true {
		t.Fatal("expected enabled=true")
	}

	// Now login should require 2FA
	resp = doReq(t, ts, "POST", "/api/totp1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var login2Resp map[string]any
	decodeJSON(t, resp, &login2Resp)
	if login2Resp["requires_2fa"] != true {
		t.Fatalf("expected requires_2fa=true, got %v", login2Resp)
	}

	// Complete 2FA login
	code2, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp code: %v", err)
	}
	resp = doReq(t, ts, "POST", "/api/totp1/login/2fa",
		`{"password":"password1234","totp_code":"`+code2+`"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var token2Resp map[string]string
	decodeJSON(t, resp, &token2Resp)
	if token2Resp["token"] == "" {
		t.Fatal("expected token from 2fa login")
	}

	// 2FA with wrong code
	resp = doReq(t, ts, "POST", "/api/totp1/login/2fa",
		`{"password":"password1234","totp_code":"000000"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)

	// 2FA with wrong password
	resp = doReq(t, ts, "POST", "/api/totp1/login/2fa",
		`{"password":"wrongpassword","totp_code":"`+code2+`"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestExportImport(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"exp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/exp1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create some entries (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/exp1/entries/Email/gmail", []byte("blob1"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/exp1/entries/Social/github", []byte("blob2"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Export
	resp = doReq(t, ts, "GET", "/api/exp1/export", "", token)
	expectStatus(t, resp, http.StatusOK)
	exportData, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()

	if len(exportData) == 0 {
		t.Fatal("export returned empty data")
	}

	// Verify tar.gz contents
	gr, err := gzip.NewReader(bytes.NewReader(exportData))
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	tr := tar.NewReader(gr)
	files := make(map[string]string)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("tar next: %v", err)
		}
		data, _ := io.ReadAll(tr)
		files[hdr.Name] = string(data)
	}
	if files["Email/gmail.gpg"] != "blob1" {
		t.Fatalf("expected Email/gmail.gpg=blob1, got %q", files["Email/gmail.gpg"])
	}
	if files["Social/github.gpg"] != "blob2" {
		t.Fatalf("expected Social/github.gpg=blob2, got %q", files["Social/github.gpg"])
	}

	// Import into a new user
	resp = doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk2","fingerprint":"imp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/imp1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr2 map[string]string
	decodeJSON(t, resp, &lr2)
	token2 := lr2["token"]

	// Import the tar.gz (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "POST", "/api/imp1/import", exportData, token2, csrf)
	expectStatus(t, resp, http.StatusOK)
	var importResp map[string]int
	decodeJSON(t, resp, &importResp)
	if importResp["imported"] != 2 {
		t.Fatalf("expected 2 imported, got %d", importResp["imported"])
	}

	// Verify imported entries
	resp = doReq(t, ts, "GET", "/api/imp1/entries", "", token2)
	expectStatus(t, resp, http.StatusOK)
	var listResp struct {
		Entries []struct {
			Path string `json:"path"`
		} `json:"entries"`
	}
	decodeJSON(t, resp, &listResp)
	if len(listResp.Entries) != 2 {
		t.Fatalf("expected 2 entries after import, got %d", len(listResp.Entries))
	}

	// Verify content
	resp = doReq(t, ts, "GET", "/api/imp1/entries/Email/gmail", "", token2)
	expectStatus(t, resp, http.StatusOK)
	gotBlob, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(gotBlob) != "blob1" {
		t.Fatalf("imported blob mismatch: got %q", string(gotBlob))
	}
}

func TestFingerprintFromKey(t *testing.T) {
	// When no fingerprint is provided, one is derived from the public key
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"my-public-key"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	var cr map[string]string
	decodeJSON(t, resp, &cr)
	if cr["fingerprint"] == "" {
		t.Fatal("expected auto-generated fingerprint")
	}
	// Should be deterministic
	expected := fingerprintFromKey("my-public-key")
	if cr["fingerprint"] != expected {
		t.Fatalf("fingerprint mismatch: %s vs %s", cr["fingerprint"], expected)
	}
}

func TestCORSHeaders(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// With no CORS_ORIGINS, cross-origin requests are denied by default, but
	// preflight still completes without granting access.
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/api", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("options request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no CORS origin header by default, got %q", got)
	}
	if got := resp.Header.Get("Vary"); !strings.Contains(got, "Origin") {
		t.Fatalf("expected Vary: Origin, got %q", got)
	}
}

func TestCORSAllowedOrigin(t *testing.T) {
	t.Setenv("CORS_ORIGINS", "https://app.example.com")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Header.Set("Origin", "https://app.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Fatalf("expected allowed origin, got %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("expected credentials header, got %q", got)
	}

	req, _ = http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected unlisted origin to be denied, got %q", got)
	}
}

func TestUpsertEntryUpdates(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"upd1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/upd1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create entry (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/upd1/entries/test", []byte("v1"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Update same path (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/upd1/entries/test", []byte("v2"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Should have v2
	resp = doReq(t, ts, "GET", "/api/upd1/entries/test", "", token)
	expectStatus(t, resp, http.StatusOK)
	got, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(got) != "v2" {
		t.Fatalf("expected v2, got %q", string(got))
	}

	// List should still have 1 entry
	resp = doReq(t, ts, "GET", "/api/upd1/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
	var listResp struct {
		Entries []struct{ Path string } `json:"entries"`
	}
	decodeJSON(t, resp, &listResp)
	if len(listResp.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(listResp.Entries))
	}
}

// ---------------------------------------------------------------------------
// DELETE /api/{fingerprint}/account — delete user account
// ---------------------------------------------------------------------------

func TestDeleteAccount(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"del1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/del1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create some entries (requires CSRF)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/del1/entries/Email/gmail", []byte("blob1"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/del1/entries/Social/github", []byte("blob2"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Verify entries exist
	resp = doReq(t, ts, "GET", "/api/del1/entries", "", token)
	expectStatus(t, resp, http.StatusOK)

	// Delete account (requires CSRF)
	resp = doReqWithCSRF(t, ts, "DELETE", "/api/del1/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Verify user is deleted - login should fail
	resp = doReq(t, ts, "POST", "/api/del1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)

	// Verify entries are deleted (should return empty list)
	resp = doReq(t, ts, "GET", "/api/del1/entries", "", token)
	expectStatus(t, resp, http.StatusOK) // Token still valid, but entries are gone
	var listResp struct {
		Entries []struct{ Path string } `json:"entries"`
	}
	decodeJSON(t, resp, &listResp)
	if len(listResp.Entries) != 0 {
		t.Fatalf("expected 0 entries after delete, got %d", len(listResp.Entries))
	}
}

func TestDeleteAccount_WithGitRepo(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"del2"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/del2/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create a fake git repo folder
	repoPath := filepath.Join(s.GitService.repoRoot, "del2")
	if err := os.MkdirAll(repoPath, 0755); err != nil {
		t.Fatalf("create repo dir: %v", err)
	}
	testFile := filepath.Join(repoPath, "test.txt")
	if err := os.WriteFile(testFile, []byte("test"), 0644); err != nil {
		t.Fatalf("create test file: %v", err)
	}

	// Verify repo exists
	if _, err := os.Stat(repoPath); err != nil {
		t.Fatalf("repo should exist: %v", err)
	}

	// Delete account (requires CSRF)
	csrf := getCSRFToken(t, ts)
	resp = doReqWithCSRF(t, ts, "DELETE", "/api/del2/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Verify git repo is deleted
	if _, err := os.Stat(repoPath); err == nil {
		t.Fatal("git repo should be deleted")
	}
}

func TestChangePassword(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// 1. Create user
	body := `{"password":"original1234","public_key":"test-key","fingerprint":"test-fp"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)
	fp := "test-fp"

	// 2. Login with original password
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"original1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]

	// 3. Change password (requires CSRF)
	changeBody := `{"current_password":"original1234","new_password":"newpass45678"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/password", changeBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var changeResp map[string]any
	decodeJSON(t, resp, &changeResp)
	if changeResp["status"] != "success" {
		t.Fatalf("expected success, got %v", changeResp["status"])
	}

	// 4. Login with new password should work
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"newpass45678"}`, "")
	expectStatus(t, resp, http.StatusOK)

	// 5. Login with old password should fail
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"original1234"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)

	// 6. The token issued before the password change must be revoked.
	resp = doReq(t, ts, "GET", "/api/"+fp+"/entries", "", token)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestChangePasswordWrongCurrent(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// 1. Create user
	body := `{"password":"correct12345","public_key":"test-key","fingerprint":"test-fp2"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)
	fp := "test-fp2"

	// 2. Login to get token
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"correct12345"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]

	// 3. Try to change password with wrong current password (requires CSRF)
	changeBody := `{"current_password":"wrongpassword","new_password":"newpass45678"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/password", changeBody, token, csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestChangePasswordLogsAttempts(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"original1234","public_key":"pk","fingerprint":"pwlog1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/pwlog1/login", `{"password":"original1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Policy failure (password too short).
	resp = doReqWithCSRF(t, ts, "POST", "/api/pwlog1/password", `{"current_password":"original1234","new_password":"short"}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()

	// Wrong current password.
	resp = doReqWithCSRF(t, ts, "POST", "/api/pwlog1/password", `{"current_password":"wrongpassword","new_password":"newpass45678"}`, token, csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	// Successful change.
	resp = doReqWithCSRF(t, ts, "POST", "/api/pwlog1/password", `{"current_password":"original1234","new_password":"newpass45678"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	logs := buf.String()
	for _, want := range []string{"password change failed", "password_policy", "invalid_current_password", "password change succeeded"} {
		if !strings.Contains(logs, want) {
			t.Errorf("log missing %q:\n%s", want, logs)
		}
	}
	for _, secret := range []string{"original1234", "wrongpassword", "newpass45678"} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs leaked password material %q:\n%s", secret, logs)
		}
	}

	var failed, changed int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE fingerprint = ? AND event = 'password_change_failed'`, "pwlog1").Scan(&failed); err != nil {
		t.Fatalf("count failed audit rows: %v", err)
	}
	if failed != 2 {
		t.Errorf("expected 2 password_change_failed audit rows, got %d", failed)
	}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE fingerprint = ? AND event = 'password_change'`, "pwlog1").Scan(&changed); err != nil {
		t.Fatalf("count success audit rows: %v", err)
	}
	if changed != 1 {
		t.Errorf("expected 1 password_change audit row, got %d", changed)
	}
}

func TestChangePasswordWith2FA(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// 1. Create user
	body := `{"password":"pass123456789","public_key":"test-key","fingerprint":"test-fp3"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)
	fp := "test-fp3"

	// 2. Setup TOTP (requires CSRF)
	loginResp := doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"pass123456789"}`, "")
	expectStatus(t, loginResp, http.StatusOK)
	var loginData map[string]string
	decodeJSON(t, loginResp, &loginData)
	loginToken := loginData["token"]

	totpResp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/totp/setup", `{"current_password":"pass123456789"}`, loginToken, csrf)
	expectStatus(t, totpResp, http.StatusOK)
	var totpData map[string]string
	decodeJSON(t, totpResp, &totpData)
	totpSecret := totpData["secret"]

	// Generate valid TOTP code
	code, _ := totp.GenerateCode(totpSecret, time.Now())

	// 3. Confirm TOTP (requires CSRF)
	confirmBody := `{"secret":"` + totpSecret + `","code":"` + code + `","current_password":"pass123456789"}`
	confirmResp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/totp/confirm", confirmBody, loginToken, csrf)
	expectStatus(t, confirmResp, http.StatusOK)

	// 4. Login with 2FA to get new token
	login2faCode, _ := totp.GenerateCode(totpSecret, time.Now())
	login2faBody := `{"password":"pass123456789","totp_code":"` + login2faCode + `"}`
	login2faResp := doReq(t, ts, "POST", "/api/"+fp+"/login/2fa", login2faBody, "")
	expectStatus(t, login2faResp, http.StatusOK)
	var login2faData map[string]string
	decodeJSON(t, login2faResp, &login2faData)
	token := login2faData["token"]

	// 5. Change password (requires CSRF)
	changeBody := `{"current_password":"pass123456789","new_password":"newpass78901"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/password", changeBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)

	// Replay protection rejects reusing the same TOTP step; simulate a new
	// time step so the second login can be exercised.
	if _, err := s.DB.Exec(`UPDATE users SET last_totp_step = 0 WHERE fingerprint = ?`, fp); err != nil {
		t.Fatalf("reset totp step: %v", err)
	}

	// 6. Login with new password and 2FA should work
	newLogin2faCode, _ := totp.GenerateCode(totpSecret, time.Now())
	newLogin2faBody := `{"password":"newpass78901","totp_code":"` + newLogin2faCode + `"}`
	newLogin2faResp := doReq(t, ts, "POST", "/api/"+fp+"/login/2fa", newLogin2faBody, "")
	expectStatus(t, newLogin2faResp, http.StatusOK)
}

// ---------------------------------------------------------------------------
// Cookie-based Authentication Tests
// ---------------------------------------------------------------------------

func TestCookieAuth_LoginSetsCookie(t *testing.T) {
	// Enable cookie auth
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Login
	resp = doReq(t, ts, "POST", "/api/cookie1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)

	// Verify cookie is set
	cookies := resp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie in response")
	}
	if authCookie.Value == "" {
		t.Fatal("cookie value should not be empty")
	}
	if !authCookie.HttpOnly {
		t.Fatal("cookie should be HttpOnly")
	}
	if !authCookie.Secure {
		t.Fatal("cookie should always be Secure")
	}
	if authCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("expected SameSite=Strict, got %v", authCookie.SameSite)
	}
	if authCookie.Path != "/api" {
		t.Fatalf("expected path /api, got %s", authCookie.Path)
	}
}

func TestCookieAuth_Login2FA_SetsCookie(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Get CSRF token
	csrf := getCSRFToken(t, ts)

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie2fa"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Login to get cookie
	loginResp := doReq(t, ts, "POST", "/api/cookie2fa/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Extract cookie
	cookies := loginResp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie")
	}

	// Setup TOTP using cookie (requires CSRF)
	totpReq, _ := http.NewRequest("POST", ts.URL+"/api/cookie2fa/totp/setup", strings.NewReader(`{"current_password":"password1234"}`))
	totpReq.Header.Set("Content-Type", "application/json")
	totpReq.AddCookie(authCookie)
	totpReq.Header.Set("X-CSRF-Token", csrf)
	totpReq.AddCookie(&http.Cookie{
		Name:  "webpass_csrf",
		Value: csrf,
		Path:  "/api",
	})
	totpResp, err := http.DefaultClient.Do(totpReq)
	if err != nil {
		t.Fatalf("TOTP setup request failed: %v", err)
	}
	expectStatus(t, totpResp, http.StatusOK)
	var totpData map[string]string
	decodeJSON(t, totpResp, &totpData)
	totpSecret := totpData["secret"]

	code, _ := totp.GenerateCode(totpSecret, time.Now())
	confirmBody := `{"secret":"` + totpSecret + `","code":"` + code + `","current_password":"password1234"}`
	confirmReq, _ := http.NewRequest("POST", ts.URL+"/api/cookie2fa/totp/confirm", strings.NewReader(confirmBody))
	confirmReq.Header.Set("Content-Type", "application/json")
	confirmReq.AddCookie(authCookie)
	confirmReq.Header.Set("X-CSRF-Token", csrf)
	confirmReq.AddCookie(&http.Cookie{
		Name:  "webpass_csrf",
		Value: csrf,
		Path:  "/api",
	})
	confirmResp, err := http.DefaultClient.Do(confirmReq)
	if err != nil {
		t.Fatalf("TOTP confirm request failed: %v", err)
	}
	expectStatus(t, confirmResp, http.StatusOK)

	// Login with 2FA
	login2faCode, _ := totp.GenerateCode(totpSecret, time.Now())
	login2faBody := `{"password":"password1234","totp_code":"` + login2faCode + `"}`
	login2faResp := doReq(t, ts, "POST", "/api/cookie2fa/login/2fa", login2faBody, "")
	expectStatus(t, login2faResp, http.StatusOK)

	// Verify cookie is set
	cookies = login2faResp.Cookies()
	var authCookie2 *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie2 = c
			break
		}
	}
	if authCookie2 == nil {
		t.Fatal("expected webpass_auth cookie in 2FA login response")
	}
}

func TestCookieAuth_AuthenticatedRequest(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login to get cookie
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie3"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	loginResp := doReq(t, ts, "POST", "/api/cookie3/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Extract cookie
	cookies := loginResp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie")
	}

	// Create HTTP client that sends cookies
	client := &http.Client{
		Jar: &testCookieJar{},
	}

	// Make request with cookie
	req, _ := http.NewRequest("GET", ts.URL+"/api/cookie3/entries", nil)
	req.AddCookie(authCookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}

	// Should succeed with valid cookie
	expectStatus(t, resp, http.StatusOK)
}

func TestCookieAuth_LogoutClearsCookie(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie4"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	loginResp := doReq(t, ts, "POST", "/api/cookie4/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Verify cookie exists
	cookies := loginResp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie before logout")
	}

	// Call logout endpoint
	logoutReq, _ := http.NewRequest("POST", ts.URL+"/api/logout", nil)
	logoutReq.AddCookie(authCookie)
	logoutResp, err := http.DefaultClient.Do(logoutReq)
	if err != nil {
		t.Fatalf("logout request failed: %v", err)
	}
	expectStatus(t, logoutResp, http.StatusOK)

	// Verify cookie is cleared (MaxAge should be -1)
	logoutCookies := logoutResp.Cookies()
	var clearedCookie *http.Cookie
	for _, c := range logoutCookies {
		if c.Name == "webpass_auth" {
			clearedCookie = c
			break
		}
	}
	if clearedCookie == nil {
		t.Fatal("expected webpass_auth cookie in logout response")
	}
	if clearedCookie.MaxAge != -1 {
		t.Fatalf("expected MaxAge=-1 to clear cookie, got %d", clearedCookie.MaxAge)
	}
}

func TestCookieAuth_WithoutCookie_ReturnsUnauthorized(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie5"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Try to access protected endpoint without cookie
	resp = doReq(t, ts, "GET", "/api/cookie5/entries", "", "")
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestCookieAuth_SecureFlag(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie6"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	loginResp := doReq(t, ts, "POST", "/api/cookie6/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Verify Secure flag is set
	cookies := loginResp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie")
	}
	if !authCookie.Secure {
		t.Fatal("cookie should have the Secure flag")
	}
}

func TestCookieAuth_Disabled_FallsBackToBearer(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "false")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie7"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Login should return token (no cookie when disabled)
	loginResp := doReq(t, ts, "POST", "/api/cookie7/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Verify no cookie is set
	cookies := loginResp.Cookies()
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			t.Fatal("should not set cookie when COOKIE_AUTH_ENABLED=false")
		}
	}

	// Get token from response
	var loginData map[string]string
	decodeJSON(t, loginResp, &loginData)
	token := loginData["token"]

	// Access protected endpoint with Bearer token
	resp = doReq(t, ts, "GET", "/api/cookie7/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
}

func TestCookieAuth_CookieDomain(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")
	t.Setenv("COOKIE_DOMAIN", ".example.com")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookie8"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	loginResp := doReq(t, ts, "POST", "/api/cookie8/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)

	// Verify domain is set
	cookies := loginResp.Cookies()
	var authCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == "webpass_auth" {
			authCookie = c
			break
		}
	}
	if authCookie == nil {
		t.Fatal("expected webpass_auth cookie")
	}
	// http.Cookie normalizes domain (removes leading dot)
	if authCookie.Domain != "example.com" {
		t.Fatalf("expected domain example.com, got %s", authCookie.Domain)
	}
}

// testCookieJar is a simple cookie jar for testing
type testCookieJar struct {
	cookies []*http.Cookie
}

func (j *testCookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.cookies = append(j.cookies, cookies...)
}

func (j *testCookieJar) Cookies(u *url.URL) []*http.Cookie {
	return j.cookies
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func doReq(t *testing.T, ts *httptest.Server, method, path, body, token string) *http.Response {
	t.Helper()
	return doReqWithCSRF(t, ts, method, path, body, token, "")
}

func doReqWithCSRF(t *testing.T, ts *httptest.Server, method, path, body, token, csrfToken string) *http.Response {
	t.Helper()
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, bodyReader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if csrfToken != "" {
		req.Header.Set("X-CSRF-Token", csrfToken)
	}
	// Add CSRF cookie if present
	if csrfToken != "" {
		req.AddCookie(&http.Cookie{
			Name:  "webpass_csrf",
			Value: csrfToken,
			Path:  "/api",
		})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

func doReqRawWithCSRF(t *testing.T, ts *httptest.Server, method, path string, body []byte, token, csrfToken string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if csrfToken != "" {
		req.Header.Set("X-CSRF-Token", csrfToken)
		req.AddCookie(&http.Cookie{
			Name:  "webpass_csrf",
			Value: csrfToken,
			Path:  "/api",
		})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

// getCSRFToken makes a GET request to obtain a CSRF token from the server
func getCSRFToken(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatalf("get csrf token: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Find CSRF cookie
	for _, cookie := range resp.Cookies() {
		if cookie.Name == "webpass_csrf" {
			return cookie.Value
		}
	}
	t.Fatal("no CSRF cookie found")
	return ""
}

// ---------------------------------------------------------------------------
// Bcrypt Cost Tests
// ---------------------------------------------------------------------------

func TestBcryptCost_Default(t *testing.T) {
	// When BCRYPT_COST is not set, should default to 12
	t.Setenv("BCRYPT_COST", "")
	s := newTestServerRaw(t)
	if s.bcryptCost != 12 {
		t.Fatalf("expected default bcrypt cost 12, got %d", s.bcryptCost)
	}
}

func TestBcryptCost_Custom(t *testing.T) {
	t.Setenv("BCRYPT_COST", "14")
	s := newTestServerRaw(t)
	if s.bcryptCost != 14 {
		t.Fatalf("expected bcrypt cost 14, got %d", s.bcryptCost)
	}
}

func TestBcryptCost_InvalidValues(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		expected int
	}{
		{"too_low", "9", 12},
		{"too_high", "16", 12},
		{"not_number", "abc", 12},
		{"empty", "", 12},
		{"valid_min", "10", 10},
		{"valid_max", "15", 15},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("BCRYPT_COST", tt.envValue)
			s := newTestServerRaw(t)
			if s.bcryptCost != tt.expected {
				t.Errorf("env=%q: expected cost %d, got %d", tt.envValue, tt.expected, s.bcryptCost)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Path Traversal Tests
// ---------------------------------------------------------------------------

func TestPathTraversal_Rejected(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"ptrav1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Login
	resp = doReq(t, ts, "POST", "/api/ptrav1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]

	// Test paths that should be rejected after normalization
	tests := []struct {
		name string
		path string
	}{
		{"dot_only", "."},
		{"slash_only", "/"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// PUT should reject invalid paths
			resp = doReqRawWithCSRF(t, ts, "PUT", "/api/ptrav1/entries/"+tt.path, []byte("data"), token, csrf)
			expectStatus(t, resp, http.StatusBadRequest)

			// DELETE should reject invalid paths
			resp = doReqWithCSRF(t, ts, "DELETE", "/api/ptrav1/entries/"+tt.path, "", token, csrf)
			expectStatus(t, resp, http.StatusBadRequest)
		})
	}
}

func TestPathTraversal_MoveEntry(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"ptrav2"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api/ptrav2/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]

	// Create a valid entry first
	resp = doReqRawWithCSRF(t, ts, "PUT", "/api/ptrav2/entries/valid-entry", []byte("data"), token, csrf)
	expectStatus(t, resp, http.StatusNoContent)

	// Move with invalid "to" path should fail
	resp = doReqWithCSRF(t, ts, "POST", "/api/ptrav2/entries/move", `{"from":"valid-entry","to":"../bad-path"}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)

	// Move with invalid "from" path should fail
	resp = doReqWithCSRF(t, ts, "POST", "/api/ptrav2/entries/move", `{"from":"../bad-path","to":"new-path"}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
}

func TestPathTraversal_ValidPaths(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"ptrav3"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api/ptrav3/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]

	validPaths := []string{
		"simple",
		"Email/gmail",
		"Social/github",
		"Work/email/work-account",
		"a/b/c/d",
	}

	for _, path := range validPaths {
		t.Run(path, func(t *testing.T) {
			// PUT should accept valid paths
			resp = doReqRawWithCSRF(t, ts, "PUT", "/api/ptrav3/entries/"+path, []byte("encrypted-data"), token, csrf)
			expectStatus(t, resp, http.StatusNoContent)

			// GET should return the entry
			resp = doReqWithCSRF(t, ts, "GET", "/api/ptrav3/entries/"+path, "", token, csrf)
			expectStatus(t, resp, http.StatusOK)

			// DELETE should succeed
			resp = doReqWithCSRF(t, ts, "DELETE", "/api/ptrav3/entries/"+path, "", token, csrf)
			expectStatus(t, resp, http.StatusNoContent)
		})
	}
}

func expectStatus(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	if resp.StatusCode != expected {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s %s: expected status %d, got %d; body: %s",
			resp.Request.Method, resp.Request.URL.Path, expected, resp.StatusCode, string(body))
	}
}

// ---------------------------------------------------------------------------
// Fingerprint validation (regression: traversal via registration)
// ---------------------------------------------------------------------------

func TestValidateFingerprint(t *testing.T) {
	valid := []string{
		"ABCDEF0123456789ABCDEF0123456789ABCDEF01", // v4 PGP fingerprint
		strings.Repeat("A", 64),                    // v5/v6 PGP fingerprint
		"abc123",
		"test-fp",
		"test_fp",
		"a.b",
	}
	for _, fp := range valid {
		if err := validateFingerprint(fp); err != nil {
			t.Errorf("expected %q to be valid, got %v", fp, err)
		}
	}

	invalid := []string{
		"",
		".",
		"..",
		"../escape",
		"../../data/db",
		"a/b",
		`a\b`,
		"a..b",
		".hidden",
		"a b",
		"a%2fb",
		"a\x00b",
		strings.Repeat("a", 129),
	}
	for _, fp := range invalid {
		if err := validateFingerprint(fp); err == nil {
			t.Errorf("expected %q to be rejected", fp)
		}
	}
}

func TestCreateUser_RejectsUnsafeFingerprint(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	for _, fp := range []string{"../escape", "a/b", "..", ".hidden", "a..b"} {
		t.Run(fp, func(t *testing.T) {
			body := `{"password":"password1234","public_key":"pk","fingerprint":` + strconv.Quote(fp) + `}`
			resp := doReq(t, ts, "POST", "/api", body, "")
			expectStatus(t, resp, http.StatusBadRequest)
			_ = resp.Body.Close()
		})
	}

	// A normal fingerprint must still be accepted.
	resp := doReq(t, ts, "POST", "/api",
		`{"password":"password1234","public_key":"pk","fingerprint":"ABCDEF0123456789ABCDEF0123456789ABCDEF01"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// Import path validation (regression: traversal written to git repo)
// ---------------------------------------------------------------------------

func TestImportJSON_RejectsUnsafePaths(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"imptrav1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/imptrav1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	body := `[
		{"path":"../../escape","content":"aGVsbG8="},
		{"path":"..","content":"aGVsbG8="},
		{"path":"ok","content":"aGVsbG8="}
	]`
	resp = doReqWithCSRF(t, ts, "POST", "/api/imptrav1/import", body, token, csrf)
	expectStatus(t, resp, http.StatusOK)

	var result struct {
		Imported int `json:"imported"`
		Errors   []struct {
			Path string `json:"path"`
		} `json:"errors"`
	}
	decodeJSON(t, resp, &result)
	if result.Imported != 1 {
		t.Fatalf("expected 1 imported entry, got %d", result.Imported)
	}
	if len(result.Errors) != 2 {
		t.Fatalf("expected 2 rejected paths, got %d", len(result.Errors))
	}

	// Only the safe path may be stored.
	resp = doReq(t, ts, "GET", "/api/imptrav1/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
	var list struct {
		Entries []struct{ Path string } `json:"entries"`
	}
	decodeJSON(t, resp, &list)
	if len(list.Entries) != 1 || list.Entries[0].Path != "ok" {
		t.Fatalf("expected only safe entry 'ok', got %+v", list.Entries)
	}
}

func TestImportTarGz_RejectsUnsafePaths(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"imptrav2"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/imptrav2/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Build a tar.gz containing a traversal entry and a safe entry.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for _, name := range []string{"../../escape.gpg", "ok.gpg"} {
		data := []byte("payload")
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data))}); err != nil {
			t.Fatalf("tar header: %v", err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatalf("tar write: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	req, err := http.NewRequest("POST", ts.URL+"/api/imptrav2/import", bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/gzip")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-CSRF-Token", csrf)
	req.AddCookie(&http.Cookie{Name: "webpass_csrf", Value: csrf, Path: "/api"})
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("import request: %v", err)
	}
	expectStatus(t, resp, http.StatusOK)
	var importResp map[string]int
	decodeJSON(t, resp, &importResp)
	if importResp["imported"] != 1 {
		t.Fatalf("expected 1 imported entry, got %d", importResp["imported"])
	}

	resp = doReq(t, ts, "GET", "/api/imptrav2/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
	var list struct {
		Entries []struct{ Path string } `json:"entries"`
	}
	decodeJSON(t, resp, &list)
	if len(list.Entries) != 1 || list.Entries[0].Path != "ok" {
		t.Fatalf("expected only safe entry 'ok', got %+v", list.Entries)
	}
}

func decodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// Client IP / trusted proxy handling (#7)
// ---------------------------------------------------------------------------

func TestGetClientIP(t *testing.T) {
	tests := []struct {
		name    string
		remote  string
		xff     string
		xri     string
		trusted string
		want    string
	}{
		{
			name:   "spoofed XFF is ignored without trusted proxy",
			remote: "192.0.2.10:1234",
			xff:    "203.0.113.9",
			want:   "192.0.2.10",
		},
		{
			name:    "XFF is used when the peer is a trusted proxy",
			remote:  "127.0.0.1:1234",
			xff:     "203.0.113.9, 10.0.0.1",
			trusted: "127.0.0.1,10.0.0.0/8",
			want:    "203.0.113.9",
		},
		{
			name:   "IPv6 RemoteAddr is parsed correctly",
			remote: "[2001:db8::1]:443",
			want:   "2001:db8::1",
		},
		{
			name:    "X-Real-IP is used from a trusted CIDR",
			remote:  "127.0.0.1:1",
			xri:     "198.51.100.7",
			trusted: "127.0.0.0/8",
			want:    "198.51.100.7",
		},
		{
			name:    "invalid XFF falls back to remote",
			remote:  "127.0.0.1:1",
			xff:     "not-an-ip",
			trusted: "127.0.0.1",
			want:    "127.0.0.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TRUSTED_PROXIES", tt.trusted)
			req := httptest.NewRequest("POST", "/", nil)
			req.RemoteAddr = tt.remote
			if tt.xff != "" {
				req.Header.Set("X-Forwarded-For", tt.xff)
			}
			if tt.xri != "" {
				req.Header.Set("X-Real-IP", tt.xri)
			}
			if got := getClientIP(req); got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func TestRateLimit_RegistrationValidate(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "2")
	t.Setenv("RATE_LIMIT_WINDOW_MINUTES", "1")
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("REGISTRATION_TOTP_SECRET", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
	t.Setenv("GIT_REPO_ROOT", filepath.Join(t.TempDir(), "git-repos"))

	dbPath := filepath.Join(t.TempDir(), "test.sqlite3")
	s, err := New(dbPath, []byte("test-secret-key-32-bytes-long!!!"), 5, 5)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(func() { _ = s.DB.Close() })

	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	for i := 0; i < 2; i++ {
		resp := doReq(t, ts, "POST", "/api/registration/validate", `{"code":"000000"}`, "")
		expectStatus(t, resp, http.StatusUnauthorized)
		_ = resp.Body.Close()
	}
	resp := doReq(t, ts, "POST", "/api/registration/validate", `{"code":"000000"}`, "")
	expectStatus(t, resp, http.StatusTooManyRequests)
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// Request body limits (#8)
// ---------------------------------------------------------------------------

func TestBodyLimit_RejectsOversizedBody(t *testing.T) {
	t.Setenv("MAX_REQUEST_BODY_BYTES", "1048576")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	big := `{"password":"` + strings.Repeat("a", 1<<20) + `"}`
	resp := doReq(t, ts, "POST", "/api", big, "")
	expectStatus(t, resp, http.StatusRequestEntityTooLarge)
	_ = resp.Body.Close()
}

func TestBodyLimit_AllowsNormalBody(t *testing.T) {
	t.Setenv("MAX_REQUEST_BODY_BYTES", "1048576")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"bodylimit1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// Cookie / CSRF consistency (#9)
// ---------------------------------------------------------------------------

func TestCookieAuth_DoesNotExposeJWT(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookiejwt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/cookiejwt1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)

	var body map[string]any
	decodeJSON(t, resp, &body)
	if _, ok := body["token"]; ok {
		t.Fatal("cookie auth must not return the JWT in the response body")
	}
	if exp, ok := body["expires_at"].(float64); !ok || exp <= float64(time.Now().Unix()) {
		t.Fatalf("expected a future expires_at, got %v", body["expires_at"])
	}
}

func TestCookieAuth_CSRFNotBypassedByBearerHeader(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookiessrf1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	loginResp := doReq(t, ts, "POST", "/api/cookiessrf1/login", `{"password":"password1234"}`, "")
	expectStatus(t, loginResp, http.StatusOK)
	var authCookie *http.Cookie
	for _, c := range loginResp.Cookies() {
		if c.Name == "webpass_auth" {
			authCookie = c
		}
	}
	_ = loginResp.Body.Close()
	if authCookie == nil {
		t.Fatal("expected auth cookie")
	}

	// Cookie mode + a bogus Authorization header must NOT skip CSRF.
	req, _ := http.NewRequest("POST", ts.URL+"/api/cookiessrf1/totp/setup", nil)
	req.AddCookie(authCookie)
	req.Header.Set("Authorization", "Bearer bogus")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	expectStatus(t, resp, http.StatusForbidden)
	_ = resp.Body.Close()
}

func TestLogout_ClearsGitSessionToken(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"logoutgit1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/logoutgit1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	s.GitService.SetSessionToken("logoutgit1", "plaintext-pat")
	if _, ok := s.GitService.getSessionToken("logoutgit1"); !ok {
		t.Fatal("expected cached git token before logout")
	}

	resp = doReq(t, ts, "POST", "/api/logout", "", token)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	if _, ok := s.GitService.getSessionToken("logoutgit1"); ok {
		t.Fatal("cached git token should be cleared on logout")
	}
}

func TestCookieAuth_SecureDetectedFromForwardedProto(t *testing.T) {
	t.Setenv("COOKIE_AUTH_ENABLED", "true")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"cookiehttps1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	req, err := http.NewRequest("POST", ts.URL+"/api/cookiehttps1/login", strings.NewReader(`{"password":"password1234"}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")

	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("login request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	expectStatus(t, resp, http.StatusOK)

	var authCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "webpass_auth" {
			authCookie = c
		}
	}
	if authCookie == nil {
		t.Fatal("expected auth cookie")
	}
	if !authCookie.Secure {
		t.Fatal("cookie should be Secure when X-Forwarded-Proto is https")
	}
}

// ---------------------------------------------------------------------------
// P1: session revocation, password policy, TOTP protection, re-auth
// ---------------------------------------------------------------------------

func TestSessionRevokeEndpoint(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"revoke1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/revoke1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReq(t, ts, "GET", "/api/revoke1/entries", "", token)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/revoke1/sessions/revoke", "", token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "GET", "/api/revoke1/entries", "", token)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestPasswordPolicy(t *testing.T) {
	for _, pw := range []string{"", "short", "12345678901"} {
		if err := validatePassword(pw); err == nil {
			t.Errorf("expected %q to be rejected", pw)
		}
	}
	for _, pw := range []string{"123456789012", "correct horse battery staple"} {
		if err := validatePassword(pw); err != nil {
			t.Errorf("expected %q to be valid, got %v", pw, err)
		}
	}
	if err := validatePassword(strings.Repeat("a", 73)); err == nil {
		t.Error("expected >72 bytes to be rejected")
	}

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := doReq(t, ts, "POST", "/api", `{"password":"short","public_key":"pk","fingerprint":"shortpw1"}`, "")
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()
}

func TestTOTPSecretEncryptedAndReplayProtected(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"totpsec1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/totpsec1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "POST", "/api/totpsec1/totp/setup", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var setup map[string]string
	decodeJSON(t, resp, &setup)
	secret := setup["secret"]

	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp: %v", err)
	}
	confirmBody := `{"secret":"` + secret + `","code":"` + code + `","current_password":"password1234"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/totpsec1/totp/confirm", confirmBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	user, err := s.Q.GetUser(context.Background(), "totpsec1")
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if user.TotpSecret == nil || !strings.HasPrefix(*user.TotpSecret, totpSecretPrefix) {
		t.Fatalf("expected encrypted TOTP secret, got %v", user.TotpSecret)
	}

	login2fa := `{"password":"password1234","totp_code":"` + code + `"}`
	resp = doReq(t, ts, "POST", "/api/totpsec1/login/2fa", login2fa, "")
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()

	// Replaying the same step must be rejected.
	resp = doReq(t, ts, "POST", "/api/totpsec1/login/2fa", login2fa, "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestTOTPSetupRequiresPassword(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"totpreauth1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/totpreauth1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "POST", "/api/totpreauth1/totp/setup", `{}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/totpreauth1/totp/setup", `{"current_password":"wrongpassword"}`, token, csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestDeleteAccountRequiresPassword(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"delreauth1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/delreauth1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/delreauth1/account", `{}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/delreauth1/account", `{"current_password":"wrongpassword"}`, token, csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/delreauth1/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	_ = resp.Body.Close()
}

// ---------------------------------------------------------------------------
// P2: security headers
// ---------------------------------------------------------------------------

func TestSecurityHeaders(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()

	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected Cache-Control no-store for API, got %q", got)
	}
	if got := resp.Header.Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
		t.Fatalf("expected COOP same-origin, got %q", got)
	}
	if got := resp.Header.Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
		t.Fatalf("expected CORP same-origin, got %q", got)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "object-src 'none'") {
		t.Fatalf("expected object-src 'none' in CSP, got %q", csp)
	}
	if got := resp.Header.Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("did not expect HSTS over plain HTTP, got %q", got)
	}
}

func TestHSTSOnlyOverHTTPS(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()

	if got := resp.Header.Get("Strict-Transport-Security"); got == "" {
		t.Fatal("expected HSTS header over HTTPS")
	}
}

func TestRequireHTTPS(t *testing.T) {
	t.Setenv("REQUIRE_HTTPS", "true")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	noRedirect := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	// API over plain HTTP with a public host must be rejected.
	req, _ := http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Host = "example.com"
	resp, err := noRedirect.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for plain HTTP API, got %d", resp.StatusCode)
	}

	// A proxy signalling HTTPS is accepted.
	req, _ = http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Host = "example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err = noRedirect.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with X-Forwarded-Proto=https, got %d", resp.StatusCode)
	}

	// Browser navigation is redirected.
	req, _ = http.NewRequest("GET", ts.URL+"/", nil)
	req.Host = "example.com"
	resp, err = noRedirect.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusPermanentRedirect {
		t.Fatalf("expected 308 redirect, got %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "https://example.com/" {
		t.Fatalf("unexpected redirect location: %q", loc)
	}

	// Localhost is exempt for development.
	req, _ = http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Host = "127.0.0.1"
	resp, err = noRedirect.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected localhost to be exempt, got %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// P6a: audit log
// ---------------------------------------------------------------------------

func TestAuditLogEvents(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Unknown account failure
	resp := doReq(t, ts, "POST", "/api/nobody/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"audit1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/audit1/login", `{"password":"wrongpassword"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/audit1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReq(t, ts, "GET", "/api/audit1/audit", "", token)
	expectStatus(t, resp, http.StatusOK)
	var result struct {
		Logs []struct {
			Event  string `json:"event"`
			Detail string `json:"detail"`
		} `json:"logs"`
	}
	decodeJSON(t, resp, &result)

	events := map[string]bool{}
	for _, l := range result.Logs {
		events[l.Event] = true
		if strings.Contains(l.Detail, "password1234") || strings.Contains(l.Detail, "wrongpassword") {
			t.Fatalf("audit detail leaked a password: %q", l.Detail)
		}
	}
	for _, want := range []string{"register", "login_failed", "login_success"} {
		if !events[want] {
			t.Errorf("expected audit event %q, got %+v", want, events)
		}
	}
}

func TestAuditLogPurgedOnAccountDelete(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"auditdel1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/auditdel1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/auditdel1/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	_ = resp.Body.Close()

	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE fingerprint = ? AND event != 'account_delete'`, "auditdel1").Scan(&count); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected old audit rows to be purged, found %d", count)
	}
	var deletion int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE fingerprint = ? AND event = 'account_delete'`, "auditdel1").Scan(&deletion); err != nil {
		t.Fatalf("count deletion rows: %v", err)
	}
	if deletion != 1 {
		t.Fatalf("expected one account_delete row, found %d", deletion)
	}
}

// ---------------------------------------------------------------------------
// P6c: recovery codes
// ---------------------------------------------------------------------------

func TestRecoveryCodeLoginFlow(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"recovery1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/recovery1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "POST", "/api/recovery1/totp/setup", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var setup map[string]string
	decodeJSON(t, resp, &setup)
	secret := setup["secret"]

	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate totp: %v", err)
	}
	confirmBody := `{"secret":"` + secret + `","code":"` + code + `","current_password":"password1234"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/recovery1/totp/confirm", confirmBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var confirm struct {
		Enabled       bool     `json:"enabled"`
		RecoveryCodes []string `json:"recovery_codes"`
	}
	decodeJSON(t, resp, &confirm)
	if !confirm.Enabled || len(confirm.RecoveryCodes) != recoveryCodeCount {
		t.Fatalf("expected enabled and %d recovery codes, got %+v", recoveryCodeCount, confirm)
	}

	// Hashes are stored, not plaintext.
	var plainCount int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM recovery_codes WHERE fingerprint = ? AND code_hash = ?`, "recovery1", confirm.RecoveryCodes[0]).Scan(&plainCount); err != nil {
		t.Fatalf("query plaintext hash: %v", err)
	}
	if plainCount != 0 {
		t.Fatal("recovery code was stored in plaintext")
	}

	recoveryCode := confirm.RecoveryCodes[0]
	loginBody := `{"password":"password1234","recovery_code":"` + recoveryCode + `"}`
	resp = doReq(t, ts, "POST", "/api/recovery1/login/recovery", loginBody, "")
	expectStatus(t, resp, http.StatusOK)
	var recoveryLogin map[string]string
	decodeJSON(t, resp, &recoveryLogin)
	if recoveryLogin["token"] == "" {
		t.Fatal("expected token from recovery login")
	}

	// Same code cannot be reused.
	resp = doReq(t, ts, "POST", "/api/recovery1/login/recovery", loginBody, "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	// Wrong password is rejected.
	wrongBody := `{"password":"wrongpassword","recovery_code":"` + confirm.RecoveryCodes[1] + `"}`
	resp = doReq(t, ts, "POST", "/api/recovery1/login/recovery", wrongBody, "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestRecoveryCodesPurgedOnAccountDelete(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"recoverydel1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/recoverydel1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	resp = doReqWithCSRF(t, ts, "POST", "/api/recoverydel1/totp/setup", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var setup map[string]string
	decodeJSON(t, resp, &setup)
	secret := setup["secret"]
	code, _ := totp.GenerateCode(secret, time.Now())
	confirmBody := `{"secret":"` + secret + `","code":"` + code + `","current_password":"password1234"}`
	resp = doReqWithCSRF(t, ts, "POST", "/api/recoverydel1/totp/confirm", confirmBody, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var confirm struct {
		Enabled bool   `json:"enabled"`
		Token   string `json:"token"`
	}
	decodeJSON(t, resp, &confirm)
	if confirm.Token != "" {
		token = confirm.Token
	}

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/recoverydel1/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	_ = resp.Body.Close()

	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM recovery_codes WHERE fingerprint = ?`, "recoverydel1").Scan(&count); err != nil {
		t.Fatalf("count recovery codes: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected recovery codes to be purged, found %d", count)
	}
}
