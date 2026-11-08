package srv

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"golang.org/x/crypto/bcrypt"

	"github.com/johnwmail/webpass/db/dbgen"
)

const webauthnChallengeTTL = 5 * time.Minute

// newWebAuthn builds the relying-party configuration from the environment.
// When WEBAUTHN_RP_ID is unset, passkeys are disabled.
func newWebAuthn() (*webauthn.WebAuthn, error) {
	rpID := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_ID"))
	if rpID == "" {
		return nil, nil
	}
	rpName := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_NAME"))
	if rpName == "" {
		rpName = "WebPass"
	}
	var origins []string
	for _, origin := range strings.Split(os.Getenv("WEBAUTHN_RP_ORIGINS"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins = append(origins, origin)
		}
	}
	if len(origins) == 0 {
		origins = []string{"https://" + rpID}
	}

	rp, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: rpName,
		RPOrigins:     origins,
	})
	if err != nil {
		return nil, fmt.Errorf("webauthn config: %w", err)
	}
	slog.Info("webauthn enabled", "rp_id", rpID, "origins", origins)
	return rp, nil
}

// webAuthnUser adapts an account + stored credentials to the library's User.
type webAuthnUser struct {
	fp    string
	creds []webauthn.Credential
}

func webauthnUserID(fp string) []byte {
	sum := sha256.Sum256([]byte(fp))
	return sum[:32]
}

func (u *webAuthnUser) WebAuthnID() []byte          { return webauthnUserID(u.fp) }
func (u *webAuthnUser) WebAuthnName() string        { return u.fp }
func (u *webAuthnUser) WebAuthnDisplayName() string { return u.fp }
func (u *webAuthnUser) WebAuthnCredentials() []webauthn.Credential {
	return u.creds
}

func (s *Server) loadWebAuthnUser(ctx context.Context, fp string) (*webAuthnUser, error) {
	rows, err := s.Q.ListWebAuthnCredentials(ctx, fp)
	if err != nil {
		return nil, err
	}
	user := &webAuthnUser{fp: fp}
	for _, row := range rows {
		var cred webauthn.Credential
		if err := json.Unmarshal(row.CredentialJson, &cred); err != nil {
			slog.Warn("skipping malformed webauthn credential", "fingerprint", fp, "id", row.ID, "error", err)
			continue
		}
		user.creds = append(user.creds, cred)
	}
	return user, nil
}

func newWebAuthnChallengeID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (s *Server) storeWebAuthnChallenge(ctx context.Context, fp, purpose string, session *webauthn.SessionData) (string, error) {
	id, err := newWebAuthnChallengeID()
	if err != nil {
		return "", err
	}
	expires := session.Expires
	if expires.IsZero() {
		expires = time.Now().Add(webauthnChallengeTTL)
	}
	data, err := json.Marshal(session)
	if err != nil {
		return "", err
	}
	if err := s.Q.InsertWebAuthnChallenge(ctx, dbgen.InsertWebAuthnChallengeParams{
		ID:          id,
		Fingerprint: fp,
		Purpose:     purpose,
		SessionJson: data,
		ExpiresAt:   expires,
	}); err != nil {
		return "", err
	}
	_ = s.Q.DeleteExpiredWebAuthnChallenges(ctx)
	return id, nil
}

func (s *Server) takeWebAuthnChallenge(ctx context.Context, fp, purpose, id string) (*webauthn.SessionData, error) {
	data, err := s.Q.TakeWebAuthnChallenge(ctx, dbgen.TakeWebAuthnChallengeParams{
		ID:          id,
		Fingerprint: fp,
		Purpose:     purpose,
	})
	if err != nil {
		return nil, err
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, fmt.Errorf("decode webauthn session: %w", err)
	}
	return &session, nil
}

func sanitizePasskeyName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Passkey"
	}
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

// POST /api/{fingerprint}/webauthn/register/begin — start adding a passkey
func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if s.WebAuthn == nil {
		jsonError(w, "passkeys are not configured", http.StatusBadRequest)
		return
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.CurrentPassword == "" {
		jsonError(w, "current_password required", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		s.audit(r, fp, "webauthn_register_failed", "invalid_password")
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	waUser, err := s.loadWebAuthnUser(r.Context(), fp)
	if err != nil {
		slog.Error("load webauthn user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	creation, session, err := s.WebAuthn.BeginRegistration(waUser, webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
		UserVerification: protocol.VerificationRequired,
		ResidentKey:      protocol.ResidentKeyRequirementPreferred,
	}))
	if err != nil {
		slog.Error("begin webauthn registration", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	challengeID, err := s.storeWebAuthnChallenge(r.Context(), fp, "register", session)
	if err != nil {
		slog.Error("store webauthn challenge", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]any{
		"challenge_id": challengeID,
		"options":      creation.Response,
	})
}

// POST /api/{fingerprint}/webauthn/register/finish — finish adding a passkey
func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if s.WebAuthn == nil {
		jsonError(w, "passkeys are not configured", http.StatusBadRequest)
		return
	}
	var body struct {
		ChallengeID string          `json:"challenge_id"`
		Credential  json.RawMessage `json:"credential"`
		Name        string          `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.ChallengeID == "" || len(body.Credential) == 0 {
		jsonError(w, "challenge_id and credential required", http.StatusBadRequest)
		return
	}

	session, err := s.takeWebAuthnChallenge(r.Context(), fp, "register", body.ChallengeID)
	if err != nil {
		s.audit(r, fp, "webauthn_register_failed", "invalid_challenge")
		jsonError(w, "invalid or expired challenge", http.StatusBadRequest)
		return
	}

	waUser, err := s.loadWebAuthnUser(r.Context(), fp)
	if err != nil {
		slog.Error("load webauthn user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	parsed, err := protocol.ParseCredentialCreationResponseBytes(body.Credential)
	if err != nil {
		s.audit(r, fp, "webauthn_register_failed", "invalid_response")
		jsonError(w, "invalid credential response", http.StatusBadRequest)
		return
	}
	cred, err := s.WebAuthn.CreateCredential(waUser, *session, parsed)
	if err != nil {
		slog.Warn("webauthn registration failed", "fingerprint", fp, "error", err)
		s.audit(r, fp, "webauthn_register_failed", "verification_failed")
		jsonError(w, "registration failed", http.StatusBadRequest)
		return
	}

	credJSON, err := json.Marshal(cred)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	name := sanitizePasskeyName(body.Name)
	if err := s.Q.InsertWebAuthnCredential(r.Context(), dbgen.InsertWebAuthnCredentialParams{
		Fingerprint:    fp,
		CredentialID:   cred.ID,
		CredentialJson: credJSON,
		Name:           name,
	}); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			jsonError(w, "passkey already registered", http.StatusConflict)
			return
		}
		slog.Error("insert webauthn credential", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "webauthn_registered", "name="+name)
	jsonOK(w, map[string]string{"status": "registered"})
}

// GET /api/{fingerprint}/webauthn/credentials
func (s *Server) handleListWebAuthnCredentials(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	rows, err := s.Q.ListWebAuthnCredentials(r.Context(), fp)
	if err != nil {
		slog.Error("list webauthn credentials", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	type item struct {
		ID         int64      `json:"id"`
		Name       string     `json:"name"`
		CreatedAt  time.Time  `json:"created_at"`
		LastUsedAt *time.Time `json:"last_used_at"`
	}
	items := make([]item, len(rows))
	for i, row := range rows {
		items[i] = item{ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt, LastUsedAt: row.LastUsedAt}
	}
	jsonOK(w, map[string]any{"credentials": items})
}

// DELETE /api/{fingerprint}/webauthn/credentials/{id}
func (s *Server) handleDeleteWebAuthnCredential(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		jsonError(w, "invalid credential id", http.StatusBadRequest)
		return
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.CurrentPassword == "" {
		jsonError(w, "current_password required", http.StatusBadRequest)
		return
	}
	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	rows, err := s.Q.DeleteWebAuthnCredential(r.Context(), dbgen.DeleteWebAuthnCredentialParams{
		ID:          id,
		Fingerprint: fp,
	})
	if err != nil {
		slog.Error("delete webauthn credential", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if rows == 0 {
		jsonError(w, "passkey not found", http.StatusNotFound)
		return
	}
	s.audit(r, fp, "webauthn_removed", fmt.Sprintf("id=%d", id))
	jsonOK(w, map[string]string{"status": "deleted"})
}

// POST /api/{fingerprint}/login/webauthn/begin — start passkey 2FA
func (s *Server) handleLoginWebAuthnBegin(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if s.WebAuthn == nil {
		jsonError(w, "passkeys are not configured", http.StatusBadRequest)
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(body.Password))
		s.audit(r, fp, "login_webauthn_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		s.audit(r, fp, "login_webauthn_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	waUser, err := s.loadWebAuthnUser(r.Context(), fp)
	if err != nil {
		slog.Error("load webauthn user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if len(waUser.creds) == 0 {
		jsonError(w, "no passkeys registered", http.StatusBadRequest)
		return
	}

	assertion, session, err := s.WebAuthn.BeginLogin(waUser, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		slog.Error("begin webauthn login", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	challengeID, err := s.storeWebAuthnChallenge(r.Context(), fp, "login", session)
	if err != nil {
		slog.Error("store webauthn challenge", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]any{
		"challenge_id": challengeID,
		"options":      assertion.Response,
	})
}

// POST /api/{fingerprint}/login/webauthn/finish — finish passkey 2FA
func (s *Server) handleLoginWebAuthnFinish(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if s.WebAuthn == nil {
		jsonError(w, "passkeys are not configured", http.StatusBadRequest)
		return
	}
	var body struct {
		ChallengeID string          `json:"challenge_id"`
		Credential  json.RawMessage `json:"credential"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.ChallengeID == "" || len(body.Credential) == 0 {
		jsonError(w, "challenge_id and credential required", http.StatusBadRequest)
		return
	}

	session, err := s.takeWebAuthnChallenge(r.Context(), fp, "login", body.ChallengeID)
	if err != nil {
		s.audit(r, fp, "login_webauthn_failed", "invalid_challenge")
		jsonError(w, "invalid or expired challenge", http.StatusUnauthorized)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	waUser, err := s.loadWebAuthnUser(r.Context(), fp)
	if err != nil {
		slog.Error("load webauthn user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	parsed, err := protocol.ParseCredentialRequestResponseBytes(body.Credential)
	if err != nil {
		s.audit(r, fp, "login_webauthn_failed", "invalid_response")
		jsonError(w, "invalid credential response", http.StatusUnauthorized)
		return
	}
	cred, err := s.WebAuthn.ValidateLogin(waUser, *session, parsed)
	if err != nil {
		slog.Warn("webauthn login failed", "fingerprint", fp, "error", err)
		s.audit(r, fp, "login_webauthn_failed", "verification_failed")
		jsonError(w, "passkey verification failed", http.StatusUnauthorized)
		return
	}

	if credJSON, err := json.Marshal(cred); err == nil {
		if err := s.Q.UpdateWebAuthnCredential(r.Context(), dbgen.UpdateWebAuthnCredentialParams{
			CredentialJson: credJSON,
			CredentialID:   cred.ID,
		}); err != nil {
			slog.Warn("update webauthn credential", "error", err)
		}
	}

	if err := s.Q.UpdateLoginTime(r.Context(), fp); err != nil {
		slog.Error("update login time", "error", err)
	}
	token, err := s.createToken(fp, user.SessionVersion)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.setAuthCookie(w, r, token)
	s.audit(r, fp, "login_webauthn_success", "")

	if s.cookieAuth {
		jsonOK(w, map[string]any{"expires_at": time.Now().Add(s.hardLimit).Unix()})
		return
	}
	jsonOK(w, map[string]string{"token": token})
}
