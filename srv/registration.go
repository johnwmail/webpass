package srv

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// RegistrationService handles TOTP-based registration code generation and validation.
type RegistrationService struct {
	secret      string
	period      uint
	algorithm   otp.Algorithm
	codeFile    string
	enabled     bool
	lastCode    string
	lastRotated time.Time
}

// NewRegistrationService creates a new RegistrationService from environment variables.
func NewRegistrationService() *RegistrationService {
	// Check if registration is enabled
	enabledStr := os.Getenv("REGISTRATION_ENABLED")
	enabled := enabledStr == "true" || enabledStr == "1"

	// Get TOTP secret (empty means open registration when enabled)
	secret := os.Getenv("REGISTRATION_TOTP_SECRET")

	// Get period (default 30 seconds)
	period := uint(30)
	if periodStr := os.Getenv("REGISTRATION_TOTP_PERIOD"); periodStr != "" {
		if p, err := strconv.Atoi(periodStr); err == nil && p >= 15 && p <= 120 {
			period = uint(p)
		}
	}

	// Get algorithm (default SHA1 for Google Authenticator compatibility)
	algorithm := otp.AlgorithmSHA1
	if algoStr := os.Getenv("REGISTRATION_TOTP_ALGO"); algoStr != "" {
		switch strings.ToUpper(algoStr) {
		case "SHA256":
			algorithm = otp.AlgorithmSHA256
		case "SHA512":
			algorithm = otp.AlgorithmSHA512
		case "SHA1":
			algorithm = otp.AlgorithmSHA1
		}
	}

	// Get code file path
	codeFile := os.Getenv("REGISTRATION_CODE_FILE")
	if codeFile == "" {
		codeFile = "/data/registration_code.txt"
	}

	rs := &RegistrationService{
		secret:    secret,
		period:    period,
		algorithm: algorithm,
		codeFile:  codeFile,
		enabled:   enabled,
	}

	// Log registration mode
	if enabled {
		if secret == "" {
			slog.Info("registration: open (no TOTP secret configured)")
		} else {
			slog.Info("registration: protected (TOTP code required)",
				"period", period,
				"algorithm", algorithm.String())
			// Start code rotation monitoring
			go rs.monitorCodeRotation()
		}
	} else {
		slog.Info("registration: disabled")
	}

	return rs
}

// IsEnabled returns true if registration is enabled.
func (rs *RegistrationService) IsEnabled() bool {
	return rs.enabled
}

// IsProtected returns true if registration requires a TOTP code.
func (rs *RegistrationService) IsProtected() bool {
	return rs.enabled && rs.secret != ""
}

// ValidateCode validates a registration code against the current TOTP.
// Accepts codes from current and previous time window (grace period).
func (rs *RegistrationService) ValidateCode(code string) bool {
	if !rs.IsProtected() {
		return false
	}

	// Validate with grace period (current + previous window)
	// Skew=1 means accept current and previous time window
	valid, _ := totp.ValidateCustom(code, rs.secret, time.Now(), totp.ValidateOpts{
		Period:    rs.period,
		Skew:      1,
		Digits:    otp.DigitsSix,
		Algorithm: rs.algorithm,
	})

	return valid
}

// getCurrentCode returns the current TOTP code.
func (rs *RegistrationService) getCurrentCode() (string, error) {
	if rs.secret == "" {
		return "", fmt.Errorf("no secret configured")
	}

	code, err := totp.GenerateCodeCustom(rs.secret, time.Now(), totp.ValidateOpts{
		Period:    rs.period,
		Digits:    otp.DigitsSix,
		Algorithm: rs.algorithm,
	})
	if err != nil {
		return "", err
	}

	return code, nil
}

// writeCodeFile writes the current code to the configured file.
func (rs *RegistrationService) writeCodeFile(code string) error {
	// Ensure directory exists
	dir := strings.TrimSuffix(rs.codeFile, "/"+strings.Split(rs.codeFile[len(rs.codeFile)-10:], "/")[0])
	if idx := strings.LastIndex(rs.codeFile, "/"); idx > 0 {
		dir = rs.codeFile[:idx]
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	// Write code with restricted permissions
	return os.WriteFile(rs.codeFile, []byte(code), 0600)
}

// monitorCodeRotation monitors for code changes and logs/writes them.
func (rs *RegistrationService) monitorCodeRotation() {
	if !rs.IsProtected() {
		return
	}

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		code, err := rs.getCurrentCode()
		if err != nil {
			continue
		}

		// Check if code has changed
		if code != rs.lastCode {
			rs.lastCode = code
			rs.lastRotated = time.Now()

			// Calculate time until expiry
			now := time.Now()
			periodStart := now.Unix() / int64(rs.period)
			periodEnd := (periodStart + 1) * int64(rs.period)
			expiresIn := periodEnd - now.Unix()

			// Log the new code
			slog.Info("REGISTRATION CODE", "code", code, "expires_in", expiresIn, "period", rs.period)

			// Write to file
			if err := rs.writeCodeFile(code); err != nil {
				slog.Error("registration: failed to write code file", "error", err)
			} else {
				slog.Debug("registration: code file updated", "path", rs.codeFile)
			}
		}
	}
}
