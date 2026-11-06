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

func TestWriteCodeFilePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "code.txt")
	rs := &RegistrationService{codeFile: path}
	if err := rs.writeCodeFile("123456"); err != nil {
		t.Fatalf("writeCodeFile: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("expected 0600, got %04o", perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "123456" {
		t.Fatalf("unexpected contents: %q", data)
	}
}

func TestWriteCodeFileRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.txt")
	if err := os.WriteFile(target, []byte("do-not-touch"), 0600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	link := filepath.Join(dir, "code.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks not supported: %v", err)
	}

	rs := &RegistrationService{codeFile: link}
	if err := rs.writeCodeFile("123456"); err == nil {
		t.Fatal("expected symlink write to be refused")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(data) != "do-not-touch" {
		t.Fatalf("symlink target was modified: %q", data)
	}
}
