package srv

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func keyTransferEnvelopeJSON(fp string) string {
	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	nonce := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 12))
	ciphertext := base64.StdEncoding.EncodeToString([]byte("test-ciphertext"))
	return fmt.Sprintf(`{"version":1,"kdf":"pbkdf2-sha256","iterations":600000,"salt":%q,"nonce":%q,"ciphertext":%q,"fingerprint":%q}`,
		salt, nonce, ciphertext, fp)
}

func createKeyTransfer(t *testing.T, ts *httptest.Server, fp, token, csrf string) (string, string) {
	t.Helper()
	resp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/key-transfer", keyTransferEnvelopeJSON(fp), token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var out struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	decodeJSON(t, resp, &out)
	if out.Token == "" || out.ExpiresAt == "" {
		t.Fatalf("unexpected create response: %+v", out)
	}
	return out.Token, out.ExpiresAt
}

func TestKeyTransferCreateRedeem(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"kt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
	token := loginToken(t, ts, "kt1", "password1234")

	transferToken, _ := createKeyTransfer(t, ts, "kt1", token, csrf)

	// Status: active, not redeemed.
	resp = doReq(t, ts, "GET", "/api/kt1/key-transfer/status", "", token)
	expectStatus(t, resp, http.StatusOK)
	var status struct {
		Active   bool `json:"active"`
		Redeemed bool `json:"redeemed"`
	}
	decodeJSON(t, resp, &status)
	if !status.Active || status.Redeemed {
		t.Fatalf("unexpected status before redeem: %+v", status)
	}

	// Redeem.
	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var out struct {
		Envelope keyTransferEnvelope `json:"envelope"`
	}
	decodeJSON(t, resp, &out)
	if out.Envelope.Fingerprint != "kt1" || out.Envelope.Ciphertext == "" {
		t.Fatalf("unexpected envelope: %+v", out.Envelope)
	}

	// Second redeem fails (single use).
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()

	// Status: not active, redeemed.
	resp = doReq(t, ts, "GET", "/api/kt1/key-transfer/status", "", token)
	expectStatus(t, resp, http.StatusOK)
	decodeJSON(t, resp, &status)
	if status.Active || !status.Redeemed {
		t.Fatalf("unexpected status after redeem: %+v", status)
	}
}

func TestKeyTransferRequiresAuth(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer", keyTransferEnvelopeJSON("kt1"), "", csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "GET", "/api/kt1/key-transfer/status", "", "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()
}

func TestKeyTransferFingerprintBinding(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	for _, fp := range []string{"kt1", "kt2"} {
		resp := doReq(t, ts, "POST", "/api", fmt.Sprintf(`{"password":"password1234","public_key":"pk","fingerprint":%q}`, fp), "")
		expectStatus(t, resp, http.StatusCreated)
		_ = resp.Body.Close()
	}
	token1 := loginToken(t, ts, "kt1", "password1234")
	token2 := loginToken(t, ts, "kt2", "password1234")

	transferToken, _ := createKeyTransfer(t, ts, "kt1", token1, csrf)

	// A different account cannot redeem the token.
	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp := doReqWithCSRF(t, ts, "POST", "/api/kt2/key-transfer/redeem", body, token2, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()

	// Envelope fingerprint must match the path.
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer", keyTransferEnvelopeJSON("kt2"), token1, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()
}

func TestKeyTransferValidation(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"kt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
	token := loginToken(t, ts, "kt1", "password1234")

	cases := []string{
		`{}`,
		`{"version":1,"kdf":"pbkdf2-sha256","iterations":1000,"salt":"","nonce":"","ciphertext":"","fingerprint":"kt1"}`,
		`{"version":2,"kdf":"pbkdf2-sha256","iterations":600000,"salt":"AAAAAAAAAAAAAAAAAAAAAA==","nonce":"AAAAAAAAAAAAAAAA","ciphertext":"YQ==","fingerprint":"kt1"}`,
	}
	for _, body := range cases {
		resp := doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer", body, token, csrf)
		expectStatus(t, resp, http.StatusBadRequest)
		_ = resp.Body.Close()
	}
}

func TestKeyTransferExpiry(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"kt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
	token := loginToken(t, ts, "kt1", "password1234")

	transferToken, _ := createKeyTransfer(t, ts, "kt1", token, csrf)
	if _, err := s.DB.Exec(`UPDATE key_transfers SET expires_at = datetime('now', '-1 minute') WHERE fingerprint = 'kt1'`); err != nil {
		t.Fatalf("expire transfer: %v", err)
	}

	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()
}

func TestKeyTransferRevoke(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"kt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
	token := loginToken(t, ts, "kt1", "password1234")

	transferToken, _ := createKeyTransfer(t, ts, "kt1", token, csrf)

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/kt1/key-transfer", "", token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	_ = resp.Body.Close()

	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()
}

func TestKeyTransferPurgedOnAccountDelete(t *testing.T) {
	t.Setenv("RATE_LIMIT_ATTEMPTS", "100")
	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"kt1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()
	token := loginToken(t, ts, "kt1", "password1234")
	createKeyTransfer(t, ts, "kt1", token, csrf)

	resp = doReqWithCSRF(t, ts, "DELETE", "/api/kt1/account", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusNoContent)
	_ = resp.Body.Close()

	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM key_transfers WHERE fingerprint = 'kt1'`).Scan(&count); err != nil {
		t.Fatalf("count transfers: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected key transfers to be purged, found %d", count)
	}
}

// loginToken logs in and returns the bearer token.
func loginToken(t *testing.T, ts *httptest.Server, fp, password string) string {
	t.Helper()
	resp := doReq(t, ts, "POST", "/api/"+fp+"/login", fmt.Sprintf(`{"password":%q}`, password), "")
	expectStatus(t, resp, http.StatusOK)
	var out map[string]string
	decodeJSON(t, resp, &out)
	if out["token"] == "" {
		t.Fatalf("login did not return a token: %+v", out)
	}
	return out["token"]
}
