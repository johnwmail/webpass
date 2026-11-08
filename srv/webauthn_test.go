package srv

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/johnwmail/webpass/db/dbgen"
)

func TestNewWebAuthnConfig(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "")
	w, err := newWebAuthn()
	if err != nil || w != nil {
		t.Fatalf("expected disabled webauthn, got %v/%v", w, err)
	}

	t.Setenv("WEBAUTHN_RP_ID", "localhost")
	t.Setenv("WEBAUTHN_RP_ORIGINS", "http://localhost:18080")
	w, err = newWebAuthn()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if w == nil {
		t.Fatal("expected webauthn to be enabled")
	}
}

func TestWebAuthnChallengeSingleUse(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	session := &webauthn.SessionData{
		Challenge: "test-challenge",
		UserID:    webauthnUserID("challenge-fp"),
		Expires:   time.Now().Add(time.Minute),
	}
	id, err := s.storeWebAuthnChallenge(ctx, "challenge-fp", "register", session)
	if err != nil {
		t.Fatalf("store challenge: %v", err)
	}

	got, err := s.takeWebAuthnChallenge(ctx, "challenge-fp", "register", id)
	if err != nil {
		t.Fatalf("take challenge: %v", err)
	}
	if got.Challenge != session.Challenge {
		t.Fatalf("challenge mismatch: %q", got.Challenge)
	}

	if _, err := s.takeWebAuthnChallenge(ctx, "challenge-fp", "register", id); err == nil {
		t.Fatal("expected challenge to be single-use")
	}
}

func TestWebAuthnChallengeExpires(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()

	session := &webauthn.SessionData{
		Challenge: "expired",
		Expires:   time.Now().Add(-time.Minute),
	}
	id, err := s.storeWebAuthnChallenge(ctx, "expired-fp", "login", session)
	if err != nil {
		t.Fatalf("store challenge: %v", err)
	}
	if _, err := s.takeWebAuthnChallenge(ctx, "expired-fp", "login", id); err == nil {
		t.Fatal("expected expired challenge to be rejected")
	}
}

func TestWebAuthnLoginRequirementAndRegistrationBegin(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "localhost")
	t.Setenv("WEBAUTHN_RP_ORIGINS", "http://localhost:18080")

	s := newTestServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	csrf := getCSRFToken(t, ts)

	resp := doReq(t, ts, "POST", "/api", `{"password":"password1234","public_key":"pk","fingerprint":"wa1"}`, "")
	expectStatus(t, resp, http.StatusCreated)
	_ = resp.Body.Close()

	resp = doReq(t, ts, "POST", "/api/wa1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var login map[string]any
	decodeJSON(t, resp, &login)
	if login["requires_2fa"] == true {
		t.Fatal("did not expect 2FA before a passkey is registered")
	}
	// Login again to obtain the token (the previous response is still a token response).
	resp = doReq(t, ts, "POST", "/api/wa1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var lr map[string]string
	decodeJSON(t, resp, &lr)
	token := lr["token"]
	if token == "" {
		t.Fatal("expected token")
	}

	// Registration begin requires the current password.
	resp = doReqWithCSRF(t, ts, "POST", "/api/wa1/webauthn/register/begin", `{}`, token, csrf)
	expectStatus(t, resp, http.StatusBadRequest)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/wa1/webauthn/register/begin", `{"current_password":"wrongpassword"}`, token, csrf)
	expectStatus(t, resp, http.StatusUnauthorized)
	_ = resp.Body.Close()

	resp = doReqWithCSRF(t, ts, "POST", "/api/wa1/webauthn/register/begin", `{"current_password":"password1234"}`, token, csrf)
	expectStatus(t, resp, http.StatusOK)
	var begin map[string]any
	decodeJSON(t, resp, &begin)
	if begin["challenge_id"] == "" || begin["options"] == nil {
		t.Fatalf("unexpected registration options: %+v", begin)
	}

	// Insert a dummy credential so the account now requires a second factor.
	cred := webauthn.Credential{ID: []byte{1, 2, 3, 4}, PublicKey: []byte{5, 6, 7, 8}}
	credJSON, _ := json.Marshal(cred)
	if err := s.Q.InsertWebAuthnCredential(context.Background(), dbgen.InsertWebAuthnCredentialParams{
		Fingerprint:    "wa1",
		CredentialID:   cred.ID,
		CredentialJson: credJSON,
		Name:           "Test passkey",
	}); err != nil {
		t.Fatalf("insert credential: %v", err)
	}

	resp = doReq(t, ts, "POST", "/api/wa1/login", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var login2 map[string]any
	decodeJSON(t, resp, &login2)
	if login2["requires_2fa"] != true || login2["webauthn"] != true {
		t.Fatalf("expected webauthn 2FA requirement, got %+v", login2)
	}

	resp = doReq(t, ts, "POST", "/api/wa1/login/webauthn/begin", `{"password":"password1234"}`, "")
	expectStatus(t, resp, http.StatusOK)
	var waBegin map[string]any
	decodeJSON(t, resp, &waBegin)
	if waBegin["challenge_id"] == "" || waBegin["options"] == nil {
		t.Fatalf("unexpected assertion options: %+v", waBegin)
	}
}
