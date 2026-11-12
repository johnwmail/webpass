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

type keyTransferStatus struct {
	Active             bool    `json:"active"`
	Requested          bool    `json:"requested"`
	RequestedAt        *string `json:"requested_at"`
	RequestedIP        string  `json:"requested_ip"`
	RequestedUserAgent string  `json:"requested_user_agent"`
	RequestedProof     string  `json:"requested_proof"`
	Challenge          string  `json:"challenge"`
	Approved           bool    `json:"approved"`
	Denied             bool    `json:"denied"`
	Redeemed           bool    `json:"redeemed"`
	ExpiresAt          *string `json:"expires_at"`
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

func keyTransferProof() string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
}

func requestKeyTransfer(t *testing.T, ts *httptest.Server, fp, transferToken, token, csrf string) {
	t.Helper()
	body := fmt.Sprintf(`{"token":%q,"proof":%q}`, transferToken, keyTransferProof())
	resp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/key-transfer/request", body, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()
}

func approveKeyTransfer(t *testing.T, ts *httptest.Server, fp, token, csrf string) {
	t.Helper()
	resp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/key-transfer/approve", "", token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()
}

func denyKeyTransfer(t *testing.T, ts *httptest.Server, fp, token, csrf string) {
	t.Helper()
	resp := doReqWithCSRF(t, ts, "POST", "/api/"+fp+"/key-transfer/deny", "", token, csrf)
	expectStatus(t, resp, http.StatusOK)
	_ = resp.Body.Close()
}

func getKeyTransferStatus(t *testing.T, ts *httptest.Server, fp, token string) keyTransferStatus {
	t.Helper()
	resp := doReq(t, ts, "GET", "/api/"+fp+"/key-transfer/status", "", token)
	expectStatus(t, resp, http.StatusOK)
	var status keyTransferStatus
	decodeJSON(t, resp, &status)
	return status
}

func TestKeyTransferCreateRequestApproveRedeem(t *testing.T) {
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

	// The target device can fetch the ciphertext to verify the pairing code
	// before requesting approval.
	resp = doReq(t, ts, "GET", "/api/kt1/key-transfer/envelope", "", token)
	expectStatus(t, resp, http.StatusOK)
	var fetched struct {
		Envelope  keyTransferEnvelope `json:"envelope"`
		Challenge string              `json:"challenge"`
	}
	decodeJSON(t, resp, &fetched)
	if fetched.Envelope.Fingerprint != "kt1" || fetched.Challenge == "" {
		t.Fatalf("unexpected fetched envelope: %+v", fetched)
	}

	// Status: active, no request yet.
	status := getKeyTransferStatus(t, ts, "kt1", token)
	if !status.Active || status.Requested || status.Approved || status.Redeemed {
		t.Fatalf("unexpected initial status: %+v", status)
	}

	// Redeem before the target device has requested approval.
	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusForbidden)
	_ = resp.Body.Close()

	// Target device announces itself; the source device can now see IP/UA.
	requestKeyTransfer(t, ts, "kt1", transferToken, token, csrf)
	status = getKeyTransferStatus(t, ts, "kt1", token)
	if !status.Requested || status.RequestedAt == nil || status.RequestedIP == "" || status.RequestedUserAgent == "" || status.RequestedProof == "" {
		t.Fatalf("expected request metadata, got %+v", status)
	}
	if status.Approved {
		t.Fatalf("unexpected approval before approve: %+v", status)
	}

	// Redeem before approval is still rejected.
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusForbidden)
	_ = resp.Body.Close()

	// Source device approves.
	approveKeyTransfer(t, ts, "kt1", token, csrf)
	status = getKeyTransferStatus(t, ts, "kt1", token)
	if !status.Approved || status.Denied {
		t.Fatalf("expected approved status, got %+v", status)
	}

	// Redeem succeeds and returns the envelope.
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var out struct {
		Envelope keyTransferEnvelope `json:"envelope"`
	}
	decodeJSON(t, resp, &out)
	if out.Envelope.Fingerprint != "kt1" || out.Envelope.Ciphertext == "" {
		t.Fatalf("unexpected envelope: %+v", out.Envelope)
	}

	// Single use.
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()

	status = getKeyTransferStatus(t, ts, "kt1", token)
	if status.Active || !status.Redeemed {
		t.Fatalf("unexpected status after redeem: %+v", status)
	}
}

func TestKeyTransferDeny(t *testing.T) {
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
	requestKeyTransfer(t, ts, "kt1", transferToken, token, csrf)
	denyKeyTransfer(t, ts, "kt1", token, csrf)

	status := getKeyTransferStatus(t, ts, "kt1", token)
	if !status.Denied || status.Active {
		t.Fatalf("expected denied status, got %+v", status)
	}

	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/redeem", body, token, csrf)
	expectStatus(t, resp, http.StatusForbidden)
	_ = resp.Body.Close()
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

	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/request", fmt.Sprintf(`{"token":"x","proof":%q}`, keyTransferProof()), "", csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/approve", "", "", csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/deny", "", "", csrf)
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

	// A different account cannot request or redeem the token.
	resp := doReqWithCSRF(t, ts, "POST", "/api/kt2/key-transfer/request", fmt.Sprintf(`{"token":%q,"proof":%q}`, transferToken, keyTransferProof()), token2, csrf)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()

	body := fmt.Sprintf(`{"token":%q}`, transferToken)
	resp = doReqWithCSRF(t, ts, "POST", "/api/kt2/key-transfer/redeem", body, token2, csrf)
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
	s.KeyTransfers.expireForTest("kt1")

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

	if s.KeyTransfers.HasForUser("kt1") {
		t.Fatal("expected key transfers to be purged from memory")
	}
}

func TestKeyTransferMemoryOnly(t *testing.T) {
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

	if !s.KeyTransfers.HasForUser("kt1") {
		t.Fatal("expected the transfer to be kept in memory")
	}

	var count int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='key_transfers'`).Scan(&count); err != nil {
		t.Fatalf("check key_transfers table: %v", err)
	}
	if count != 0 {
		t.Fatalf("key_transfers must not be persisted, found %d", count)
	}
}

func TestKeyTransferRequestProofValidation(t *testing.T) {
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

	for _, proof := range []string{"", "x", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 31))} {
		body := fmt.Sprintf(`{"token":%q,"proof":%q}`, transferToken, proof)
		resp := doReqWithCSRF(t, ts, "POST", "/api/kt1/key-transfer/request", body, token, csrf)
		expectStatus(t, resp, http.StatusBadRequest)
		_ = resp.Body.Close()
	}
}

func TestKeyTransferFetchEnvelopeAuthAndBinding(t *testing.T) {
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
	createKeyTransfer(t, ts, "kt1", token1, csrf)

	resp := doReq(t, ts, "GET", "/api/kt1/key-transfer/envelope", "", "")
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "GET", "/api/kt2/key-transfer/envelope", "", token2)
	expectStatus(t, resp, http.StatusNotFound)
	_ = resp.Body.Close()
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
