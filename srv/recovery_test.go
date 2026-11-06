package srv

import (
	"strings"
	"testing"
)

func TestGenerateRecoveryCodes(t *testing.T) {
	plain, hashes, err := generateRecoveryCodes()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(plain) != recoveryCodeCount || len(hashes) != recoveryCodeCount {
		t.Fatalf("expected %d codes/hashes, got %d/%d", recoveryCodeCount, len(plain), len(hashes))
	}
	seen := map[string]bool{}
	for i, code := range plain {
		if seen[code] {
			t.Fatalf("duplicate recovery code %q", code)
		}
		seen[code] = true
		if len(code) != 19 { // 4-4-4-4 plus 3 dashes
			t.Fatalf("unexpected code format %q", code)
		}
		if hashes[i] != hashRecoveryCode(code) {
			t.Fatalf("hash mismatch for %q", code)
		}
		// Normalisation accepts lowercase and missing dashes.
		if hashRecoveryCode(strings.ToLower(strings.ReplaceAll(code, "-", ""))) != hashes[i] {
			t.Fatalf("normalisation mismatch for %q", code)
		}
	}
}
