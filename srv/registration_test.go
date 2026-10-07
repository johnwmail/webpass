package srv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistrationInvalidSecret(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("REGISTRATION_TOTP_SECRET", "not-base32!!!")
	t.Setenv("REGISTRATION_CODE_FILE", filepath.Join(t.TempDir(), "code.txt"))

	rs := NewRegistrationService()
	if !rs.IsProtected() {
		t.Fatal("expected protected mode")
	}
	if _, err := rs.getCurrentCode(); err == nil {
		t.Fatal("expected error for invalid base32 secret")
	}
}

func TestRegistrationValidSecret(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("REGISTRATION_TOTP_SECRET", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")
	t.Setenv("REGISTRATION_CODE_FILE", filepath.Join(t.TempDir(), "code.txt"))

	rs := NewRegistrationService()
	code, err := rs.getCurrentCode()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("expected 6-digit code, got %q", code)
	}
}

func TestRegistrationOpenMode(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("REGISTRATION_TOTP_SECRET", "")

	rs := NewRegistrationService()
	if !rs.IsEnabled() {
		t.Fatal("expected registration enabled")
	}
	if rs.IsProtected() {
		t.Fatal("expected open mode (not protected) without a secret")
	}
}

func TestRegistrationWriteCodeFile(t *testing.T) {
	codeFile := filepath.Join(t.TempDir(), "sub", "code.txt")
	rs := &RegistrationService{codeFile: codeFile}

	if err := rs.writeCodeFile("123456"); err != nil {
		t.Fatalf("writeCodeFile: %v", err)
	}

	got, err := os.ReadFile(codeFile)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if strings.TrimSpace(string(got)) != "123456" {
		t.Fatalf("unexpected file content: %q", got)
	}
}

func TestDirWritable(t *testing.T) {
	if !dirWritable(t.TempDir()) {
		t.Error("temp dir should be reported writable")
	}
	if dirWritable(filepath.Join(t.TempDir(), "does-not-exist")) {
		t.Error("nonexistent dir should not be reported writable")
	}
}
