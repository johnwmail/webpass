package srv

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/johnwmail/webpass/db/dbgen"
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
	expiresAt := time.Now().Add(keyTransferTTL).UTC()

	// Only one active transfer per account.
	if err := s.Q.DeleteKeyTransfersForUser(r.Context(), fp); err != nil {
		slog.Error("key transfer: clear previous", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := s.Q.InsertKeyTransfer(r.Context(), dbgen.InsertKeyTransferParams{
		Fingerprint: fp,
		TokenHash:   tokenHash,
		Envelope:    data,
		Challenge:   challenge,
		ExpiresAt:   expiresAt,
		CreatedIp:   getClientIP(r),
		UserAgent:   r.UserAgent(),
	}); err != nil {
		slog.Error("key transfer: insert", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	_ = s.Q.DeleteExpiredKeyTransfers(r.Context())

	s.audit(r, fp, "key_transfer_created", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]any{
		"token":      token,
		"challenge":  challenge,
		"expires_at": expiresAt.Format(time.RFC3339),
	})
}

// GET /api/{fingerprint}/key-transfer/envelope — the target device fetches the
// ciphertext to verify the pairing code locally BEFORE requesting approval.
// The envelope stays encrypted; the server cannot decrypt it.
func (s *Server) handleFetchKeyTransferEnvelope(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	row, err := s.Q.GetKeyTransferEnvelope(r.Context(), fp)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, "transfer not found or expired", http.StatusNotFound)
			return
		}
		slog.Error("key transfer: fetch envelope", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if len(row.Envelope) == 0 {
		jsonError(w, "transfer not found or expired", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]any{
		"envelope":  json.RawMessage(row.Envelope),
		"challenge": row.Challenge,
	})
}

// POST /api/{fingerprint}/key-transfer/request — the target device announces
// itself; the source device must approve it before the envelope is released.
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
	_, err = s.Q.RequestKeyTransfer(r.Context(), dbgen.RequestKeyTransferParams{
		RequestedIp:        getClientIP(r),
		RequestedUserAgent: r.UserAgent(),
		RequestedProof:     body.Proof,
		TokenHash:          sum[:],
		Fingerprint:        fp,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, "transfer not found or expired", http.StatusNotFound)
			return
		}
		slog.Error("key transfer: request", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "key_transfer_requested", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "pending"})
}

// POST /api/{fingerprint}/key-transfer/approve — source device approval.
func (s *Server) handleApproveKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if _, err := s.Q.ApproveKeyTransfer(r.Context(), fp); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, "no pending transfer or pairing code not verified", http.StatusNotFound)
			return
		}
		slog.Error("key transfer: approve", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.audit(r, fp, "key_transfer_approved", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "approved"})
}

// POST /api/{fingerprint}/key-transfer/deny — source device rejection.
func (s *Server) handleDenyKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if _, err := s.Q.DenyKeyTransfer(r.Context(), fp); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, "no pending transfer", http.StatusNotFound)
			return
		}
		slog.Error("key transfer: deny", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.audit(r, fp, "key_transfer_denied", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]string{"status": "denied"})
}

// POST /api/{fingerprint}/key-transfer/redeem — atomically claim and delete the
// envelope. The pairing code is never sent to the server.
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
	row, err := s.Q.ClaimKeyTransfer(r.Context(), dbgen.ClaimKeyTransferParams{
		TokenHash:   sum[:],
		Fingerprint: fp,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			status, statusErr := s.Q.GetKeyTransferStatus(r.Context(), fp)
			if statusErr != nil {
				jsonError(w, "transfer not found or expired", http.StatusNotFound)
				return
			}
			switch {
			case status.DeniedAt != nil:
				jsonError(w, "transfer denied", http.StatusForbidden)
			case status.UsedAt != nil || !status.ExpiresAt.After(time.Now()):
				jsonError(w, "transfer not found or expired", http.StatusNotFound)
			case status.RequestedAt == nil:
				jsonError(w, "transfer not approved", http.StatusForbidden)
			case status.ApprovedAt == nil:
				jsonError(w, "waiting for approval on the source device", http.StatusForbidden)
			default:
				jsonError(w, "transfer not approved", http.StatusForbidden)
			}
			return
		}
		slog.Error("key transfer: claim", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// The ciphertext has been handed to the client; do not keep it around.
	if err := s.Q.ClearKeyTransferEnvelope(r.Context(), row.ID); err != nil {
		slog.Warn("key transfer: clear envelope", "error", err)
	}

	s.audit(r, fp, "key_transfer_redeemed", "")
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, map[string]json.RawMessage{"envelope": json.RawMessage(row.Envelope)})
}

// DELETE /api/{fingerprint}/key-transfer — revoke any active transfer.
func (s *Server) handleRevokeKeyTransfer(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if err := s.Q.DeleteKeyTransfersForUser(r.Context(), fp); err != nil {
		slog.Error("key transfer: revoke", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.audit(r, fp, "key_transfer_revoked", "")
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/{fingerprint}/key-transfer/status — used by the source device to
// show "transferred" / "expired".
func (s *Server) handleKeyTransferStatus(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	row, err := s.Q.GetKeyTransferStatus(r.Context(), fp)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
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
		slog.Error("key transfer: status", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	formatTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	jsonOK(w, map[string]any{
		"active":               row.UsedAt == nil && row.DeniedAt == nil && row.ExpiresAt.After(time.Now()),
		"requested":            row.RequestedAt != nil,
		"requested_at":         formatTime(row.RequestedAt),
		"requested_ip":         row.RequestedIp,
		"requested_user_agent": row.RequestedUserAgent,
		"requested_proof":      row.RequestedProof,
		"challenge":            row.Challenge,
		"approved":             row.ApprovedAt != nil,
		"denied":               row.DeniedAt != nil,
		"redeemed":             row.UsedAt != nil,
		"expires_at":           row.ExpiresAt.UTC().Format(time.RFC3339),
	})
}
