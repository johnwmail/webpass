package srv

import (
	"crypto/subtle"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	totpPeriodSeconds = 30
	totpSkewSteps     = 1 // accept the current step and the previous one
)

// matchTOTPCode returns the time step matched by code (current or previous),
// without applying replay protection.
func matchTOTPCode(secret, code string) (int64, bool) {
	now := time.Now()
	currentStep := now.Unix() / totpPeriodSeconds

	for offset := int64(0); offset <= totpSkewSteps; offset++ {
		step := currentStep - offset
		expected, err := totp.GenerateCodeCustom(secret, time.Unix(step*totpPeriodSeconds, 0), totp.ValidateOpts{
			Period:    totpPeriodSeconds,
			Digits:    otp.DigitsSix,
			Algorithm: otp.AlgorithmSHA1,
		})
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// validateTOTPCode verifies a TOTP code against the current (and previous)
// time step and enforces replay protection: a step that has already been
// accepted is rejected even if its code is still within the validity window.
func validateTOTPCode(secret, code string, lastAcceptedStep int64) (int64, bool) {
	step, ok := matchTOTPCode(secret, code)
	if !ok || step <= lastAcceptedStep {
		return 0, false
	}
	return step, true
}
