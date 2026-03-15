package srv

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// newTestServer creates a Server backed by a temp SQLite DB.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.sqlite3")
	t.Cleanup(func() { _ = os.Remove(dbPath) })

	// Set temp git repo root for tests
	gitRepoRoot := filepath.Join(t.TempDir(), "git-repos")
	t.Setenv("GIT_REPO_ROOT", gitRepoRoot)

	key := []byte("test-secret-key-32-bytes-long!!!") // exactly 32 bytes
	srv, err := New(dbPath, key)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(func() { _ = srv.DB.Close() })
	return srv
}

func TestFullCRUDFlow(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// 1. Create user
	body := `{"password":"hunter2","public_key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test","fingerprint":"abc123"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)
	var createResp map[string]string
	decodeJSON(t, resp, &createResp)
	if createResp["fingerprint"] != "abc123" {
		t.Fatalf("expected fingerprint abc123, got %s", createResp["fingerprint"])
	}
	fp := createResp["fingerprint"]

	// 2. Login
	resp = doReq(t, ts, "POST", "/api/"+fp+"/login", `{"password":"hunter2"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var loginResp map[string]string
	decodeJSON(t, resp, &loginResp)
	token := loginResp["token"]
	if token == "" {
		t.Fatal("expected token in login response")
	}

	// 3. PUT entry
	resp = doReqRaw(t, ts, "PUT", "/api/"+fp+"/entries/Email/gmail", []byte("encrypted-blob-data"), token)
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

	// 6. Move entry
	resp = doReq(t, ts, "POST", "/api/"+fp+"/entries/move", `{"from":"Email/gmail","to":"Email/gmail-moved"}`, token)
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

	// 7. Delete entry
	resp = doReq(t, ts, "DELETE", "/api/"+fp+"/entries/Email/gmail-moved", "", token)
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

	tokenA := createUserAndGetToken("userA", "passA")
	createUserAndGetToken("userB", "passB")

	// userA's token trying to access userB's entries
	resp = doReq(t, ts, "GET", "/api/userB/entries", "", tokenA)
	expectStatus(t, resp, http.StatusForbidden)
}

func TestLoginWrongPassword(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user
	resp := doReq(t, ts, "POST", "/api", `{"password":"correct","public_key":"pk1","fingerprint":"fp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	// Wrong password
	resp = doReq(t, ts, "POST", "/api/fp1/login", `{"password":"wrong"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestDuplicateUser(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	body := `{"password":"pw","public_key":"pk","fingerprint":"dup1"}`
	resp := doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api", body, "")
	expectStatus(t, resp, http.StatusConflict)
}

func TestTOTPFlow(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"pw","public_key":"pk","fingerprint":"totp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)

	resp = doReq(t, ts, "POST", "/api/totp1/login", `{"password":"pw"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Setup TOTP
	resp = doReq(t, ts, "POST", "/api/totp1/totp/setup", "", token)
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

	// Confirm TOTP
	confirmBody := `{"secret":"` + secret + `","code":"` + code + `"}`
	resp = doReq(t, ts, "POST", "/api/totp1/totp/confirm", confirmBody, token)
	expectStatus(t, resp, http.StatusOK)
	var confirmResp map[string]bool
	decodeJSON(t, resp, &confirmResp)
	if !confirmResp["enabled"] {
		t.Fatal("expected enabled=true")
	}

	// Now login should require 2FA
	resp = doReq(t, ts, "POST", "/api/totp1/login", `{"password":"pw"}`, "")
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
		`{"password":"pw","totp_code":"`+code2+`"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var token2Resp map[string]string
	decodeJSON(t, resp, &token2Resp)
	if token2Resp["token"] == "" {
		t.Fatal("expected token from 2fa login")
	}

	// 2FA with wrong code
	resp = doReq(t, ts, "POST", "/api/totp1/login/2fa",
		`{"password":"pw","totp_code":"000000"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)

	// 2FA with wrong password
	resp = doReq(t, ts, "POST", "/api/totp1/login/2fa",
		`{"password":"wrong","totp_code":"`+code2+`"}`, "")
	expectStatus(t, resp, http.StatusUnauthorized)
}

func TestExportImport(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"pw","public_key":"pk","fingerprint":"exp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/exp1/login", `{"password":"pw"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create some entries
	resp = doReqRaw(t, ts, "PUT", "/api/exp1/entries/Email/gmail", []byte("blob1"), token)
	expectStatus(t, resp, http.StatusNoContent)
	resp = doReqRaw(t, ts, "PUT", "/api/exp1/entries/Social/github", []byte("blob2"), token)
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
	resp = doReq(t, ts, "POST", "/api", `{"password":"pw","public_key":"pk2","fingerprint":"imp1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/imp1/login", `{"password":"pw"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr2 map[string]string
	decodeJSON(t, resp, &lr2)
	token2 := lr2["token"]

	// Import the tar.gz
	resp = doReqRaw(t, ts, "POST", "/api/imp1/import", exportData, token2)
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

	resp := doReq(t, ts, "POST", "/api", `{"password":"pw","public_key":"my-public-key"}`, "")
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

	// With no CORS_ORIGINS env, all origins should be allowed (dev mode)
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/api", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("options request: %v", err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for OPTIONS, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("expected CORS origin header, got %q", resp.Header.Get("Access-Control-Allow-Origin"))
	}
}

func TestUpsertEntryUpdates(t *testing.T) {
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Create user and login
	resp := doReq(t, ts, "POST", "/api", `{"password":"pw","public_key":"pk","fingerprint":"upd1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	resp = doReq(t, ts, "POST", "/api/upd1/login", `{"password":"pw"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]

	// Create entry
	resp = doReqRaw(t, ts, "PUT", "/api/upd1/entries/test", []byte("v1"), token)
	expectStatus(t, resp, http.StatusNoContent)

	// Update same path
	resp = doReqRaw(t, ts, "PUT", "/api/upd1/entries/test", []byte("v2"), token)
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
// helpers
// ---------------------------------------------------------------------------

func doReq(t *testing.T, ts *httptest.Server, method, path, body, token string) *http.Response {
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
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

func doReqRaw(t *testing.T, ts *httptest.Server, method, path string, body []byte, token string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

func expectStatus(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	if resp.StatusCode != expected {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s %s: expected status %d, got %d; body: %s",
			resp.Request.Method, resp.Request.URL.Path, expected, resp.StatusCode, string(body))
	}
}

func decodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	_ = resp.Body.Close()
}
