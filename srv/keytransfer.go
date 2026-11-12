package srv

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	keyTransferTTL           = 15 * time.Minute
	keyTransferMaxEnvelope   = 256 << 10 // 256 KiB of ciphertext
	keyTransferMinIterations = 600000
	keyTransferMaxIterations = 10_000_000
)

// keyTransferEnvelope is the client-encrypted private-key blob. The server
// validates the shape but cannot decrypt it: the pairing code and the PGP
// passphrase never leave the browser.
type keyTransferEnvelope struct {
	Version     int    `json:"version"`
	KDF         string `json:"kdf"`
	Iterations  int    `json:"iterations"`
	Salt        string `json:"salt"`
	Nonce       string `json:"nonce"`
	Ciphertext  string `json:"ciphertext"`
	Fingerprint string `json:"fingerprint"`
}

func validateKeyTransferEnvelope(env keyTransferEnvelope, fingerprint string) error {
	if env.Version != 1 {
		return fmt.Errorf("unsupported envelope version")
	}
	if env.KDF != "pbkdf2-sha256" {
		return fmt.Errorf("unsupported kdf")
	}
	if env.Iterations < keyTransferMinIterations || env.Iterations > keyTransferMaxIterations {
		return fmt.Errorf("invalid kdf iterations")
	}
	if env.Fingerprint != fingerprint {
		return fmt.Errorf("fingerprint mismatch")
	}
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil || len(salt) != 16 {
		return fmt.Errorf("invalid salt")
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil || len(nonce) != 12 {
		return fmt.Errorf("invalid nonce")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil || len(ciphertext) == 0 || len(ciphertext) > keyTransferMaxEnvelope {
		return fmt.Errorf("invalid ciphertext")
	}
	return nil
}

func newKeyTransferToken() (string, []byte, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:], nil
}

func newKeyTransferChallenge() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// POST /api/{fingerprint}/key-transfer — create a short-lived transfer.
func (s *Server) handleCreateKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var env keyTransferEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := validateKeyTransferEnvelope(env, fp); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := json.Marshal(env)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	token, tokenHash, err := newKeyTransferToken()
	if err != nil {
		slog.Error("key transfer: generate token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	challenge, err := newKeyTransferChallenge()
	if err != nil {
		slog.Error("key transfer: generate challenge", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	t := s.KeyTransfers.Create(fp, tokenHash, data, challenge, getClientIP(r), r.UserAgent())
	s.audit(r, fp, "key_transfer_created", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]any{
		"token":      token,
		"challenge":  challenge,
		"expires_at": t.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// GET /api/{fingerprint}/key-transfer/envelope — the target device fetches the
// ciphertext to verify the pairing code locally BEFORE requesting approval.
// The envelope stays encrypted and is never written to the database.
func (s *Server) handleFetchKeyTransferEnvelope(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	envelope, challenge, ok := s.KeyTransfers.Fetch(fp)
	if !ok {
		jsonError(w, "transfer not found or expired", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]any{
		"envelope":  json.RawMessage(envelope),
		"challenge": challenge,
	})
}

// POST /api/{fingerprint}/key-transfer/request — the target device announces
// itself with a pairing-code proof; the source device must approve it.
func (s *Server) handleRequestKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Token string `json:"token"`
		Proof string `json:"proof"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Token) == "" || strings.TrimSpace(body.Proof) == "" {
		jsonError(w, "token and proof required", http.StatusBadRequest)
		return
	}
	proof, err := base64.StdEncoding.DecodeString(body.Proof)
	if err != nil || len(proof) != 32 {
		jsonError(w, "invalid proof", http.StatusBadRequest)
		return
	}

	sum := sha256.Sum256([]byte(body.Token))
	if !s.KeyTransfers.Request(fp, sum[:], getClientIP(r), r.UserAgent(), body.Proof) {
		jsonError(w, "transfer not found or expired", http.StatusNotFound)
		return
	}

	s.audit(r, fp, "key_transfer_requested", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "pending"})
}

// POST /api/{fingerprint}/key-transfer/approve — source device approval.
func (s *Server) handleApproveKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if !s.KeyTransfers.Approve(fp) {
		jsonError(w, "no pending transfer or pairing code not verified", http.StatusNotFound)
		return
	}
	s.audit(r, fp, "key_transfer_approved", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "approved"})
}

// POST /api/{fingerprint}/key-transfer/deny — source device rejection.
func (s *Server) handleDenyKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if !s.KeyTransfers.Deny(fp) {
		jsonError(w, "no pending transfer", http.StatusNotFound)
		return
	}
	s.audit(r, fp, "key_transfer_denied", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "denied"})
}

// POST /api/{fingerprint}/key-transfer/redeem — atomically claim and clear the
// in-memory envelope. The pairing code is never sent to the server.
func (s *Server) handleRedeemKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Token) == "" {
		jsonError(w, "token required", http.StatusBadRequest)
		return
	}

	sum := sha256.Sum256([]byte(body.Token))
	envelope, ok := s.KeyTransfers.Claim(fp, sum[:])
	if !ok {
		st, found := s.KeyTransfers.Status(fp)
		if !found {
			jsonError(w, "transfer not found or expired", http.StatusNotFound)
			return
		}
		switch {
		case st.DeniedAt != nil:
			jsonError(w, "transfer denied", http.StatusForbidden)
		case st.UsedAt != nil || !st.ExpiresAt.After(time.Now()):
			jsonError(w, "transfer not found or expired", http.StatusNotFound)
		case st.RequestedAt == nil:
			jsonError(w, "transfer not approved", http.StatusForbidden)
		case st.ApprovedAt == nil:
			jsonError(w, "waiting for approval on the source device", http.StatusForbidden)
		default:
			jsonError(w, "transfer not approved", http.StatusForbidden)
		}
		return
	}

	s.audit(r, fp, "key_transfer_redeemed", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]json.RawMessage{"envelope": json.RawMessage(envelope)})
}

// DELETE /api/{fingerprint}/key-transfer — revoke any active transfer.
func (s *Server) handleRevokeKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	s.KeyTransfers.DeleteForUser(fp)
	s.audit(r, fp, "key_transfer_revoked", "")
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/{fingerprint}/key-transfer/status — used by both devices.
func (s *Server) handleKeyTransferStatus(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	st, ok := s.KeyTransfers.Status(fp)
	if !ok {
		jsonOK(w, map[string]any{
			"active":               false,
			"requested":            false,
			"requested_at":         nil,
			"requested_ip":         "",
			"requested_user_agent": "",
			"requested_proof":      "",
			"challenge":            "",
			"approved":             false,
			"denied":               false,
			"redeemed":             false,
			"expires_at":           nil,
		})
		return
	}
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	jsonOK(w, map[string]any{
		"active":               st.UsedAt == nil && st.DeniedAt == nil && st.ExpiresAt.After(time.Now()),
		"requested":            st.RequestedAt != nil,
		"requested_at":         formatTime(st.RequestedAt),
		"requested_ip":         st.RequestedIP,
		"requested_user_agent": st.RequestedUserAgent,
		"requested_proof":      st.RequestedProof,
		"challenge":            st.Challenge,
		"approved":             st.ApprovedAt != nil,
		"denied":               st.DeniedAt != nil,
		"redeemed":             st.UsedAt != nil,
		"expires_at":           st.ExpiresAt.UTC().Format(time.RFC3339),
	})
}
