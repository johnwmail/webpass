package srv

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	recoveryCodeCount = 10
	recoveryCodeBytes = 10 // 80 bits of entropy
)

var recoveryEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// generateRecoveryCodes returns human-readable one-time codes and their hashes.
// Codes are stored as SHA-256 hashes; the plaintext is shown only once.
func generateRecoveryCodes() ([]string, []string, error) {
	plain := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)

	for i := 0; i < recoveryCodeCount; i++ {
		buf := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(buf); err != nil {
			return nil, nil, err
		}
		raw := recoveryEncoding.EncodeToString(buf) // 16 base32 chars
		formatted := raw[0:4] + "-" + raw[4:8] + "-" + raw[8:12] + "-" + raw[12:16]
		plain = append(plain, formatted)
		hashes = append(hashes, hashRecoveryCode(formatted))
	}
	return plain, hashes, nil
}

func normalizeRecoveryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "-", "")
	code = strings.ReplaceAll(code, " ", "")
	return code
}

func hashRecoveryCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeRecoveryCode(code)))
	return hex.EncodeToString(sum[:])
}

// POST /api/{fingerprint}/login/recovery — log in with a one-time recovery code
func (s *Server) handleLoginRecovery(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		Password     string `json:"password"`
		RecoveryCode string `json:"recovery_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Password == "" || body.RecoveryCode == "" {
		jsonError(w, "password and recovery_code required", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(body.Password))
		s.audit(r, fp, "login_recovery_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		s.audit(r, fp, "login_recovery_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	codes, err := s.Q.ListUnusedRecoveryCodes(r.Context(), fp)
	if err != nil {
		slog.Error("list recovery codes", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	target := hashRecoveryCode(body.RecoveryCode)
	var matchedID int64
	for _, c := range codes {
		if subtle.ConstantTimeCompare([]byte(c.CodeHash), []byte(target)) == 1 {
			matchedID = c.ID
		}
	}
	if matchedID == 0 {
		s.audit(r, fp, "login_recovery_failed", "invalid_code")
		jsonError(w, "invalid recovery code", http.StatusUnauthorized)
		return
	}

	// Consume the code atomically; rows == 0 means it was already used.
	rows, err := s.Q.MarkRecoveryCodeUsed(r.Context(), matchedID)
	if err != nil || rows != 1 {
		s.audit(r, fp, "login_recovery_failed", "code_used")
		jsonError(w, "invalid recovery code", http.StatusUnauthorized)
		return
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
	s.audit(r, fp, "login_recovery_success", "")

	if s.cookieAuth {
		jsonOK(w, map[string]any{"expires_at": time.Now().Add(s.hardLimit).Unix()})
		return
	}
	jsonOK(w, map[string]string{"token": token})
}
