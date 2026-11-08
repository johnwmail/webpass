package srv

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecretBoxRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	box, err := newSecretBox(key)
	if err != nil {
		t.Fatalf("newSecretBox: %v", err)
	}

	plain := "JBSWY3DPEHPK3PXP"
	enc, err := box.EncryptString(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if enc == plain {
		t.Fatal("ciphertext equals plaintext")
	}
	got, err := box.DecryptString(enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != plain {
		t.Fatalf("expected %q, got %q", plain, got)
	}

	// Legacy plaintext values pass through unchanged.
	if legacy, err := box.DecryptString("PLAINTEXT"); err != nil || legacy != "PLAINTEXT" {
		t.Fatalf("legacy passthrough failed: %q %v", legacy, err)
	}
}

func TestSecretBoxRejectsTamperedCiphertext(t *testing.T) {
	key := make([]byte, 32)
	box, err := newSecretBox(key)
	if err != nil {
		t.Fatalf("newSecretBox: %v", err)
	}
	enc, err := box.EncryptString("secret")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// Flip the last base64 character.
	last := enc[len(enc)-1]
	repl := byte('A')
	if last == 'A' {
		repl = 'B'
	}
	tampered := enc[:len(enc)-1] + string(repl)
	if _, err := box.DecryptString(tampered); err == nil {
		t.Fatal("expected tampered ciphertext to fail")
	}
}

func TestLoadSecretBoxPersistsKeyFile(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.sqlite3")
	jwtKey := []byte("0123456789abcdef0123456789abcdef")

	box1, err := loadSecretBox(dbPath, jwtKey)
	if err != nil {
		t.Fatalf("loadSecretBox: %v", err)
	}
	enc, err := box1.EncryptString("value")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	keyPath := filepath.Join(dir, "data_encryption.key")
	if _, err := os.Stat(keyPath); err != nil {
		t.Fatalf("expected key file: %v", err)
	}

	// A second load must use the persisted key and decrypt the value.
	box2, err := loadSecretBox(dbPath, jwtKey)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	plain, err := box2.DecryptString(enc)
	if err != nil || plain != "value" {
		t.Fatalf("expected persisted key to decrypt, got %q %v", plain, err)
	}
}

func TestParseEncryptionKey(t *testing.T) {
	hexKey := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	key, err := parseEncryptionKey(hexKey)
	if err != nil {
		t.Fatalf("hex key: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(key))
	}
	if _, err := parseEncryptionKey("short"); err == nil {
		t.Fatal("expected short key to be rejected")
	}
}

func TestDataEncryptionKeyPath(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "db.sqlite3")

	t.Setenv("DATA_ENCRYPTION_KEY", "")
	if got := DataEncryptionKeyPath(dbPath); got != filepath.Join(dir, "data_encryption.key") {
		t.Fatalf("unexpected key path: %q", got)
	}
	if got := DataEncryptionKeyPath(":memory:"); got != "" {
		t.Fatalf("expected no key path for in-memory db, got %q", got)
	}

	t.Setenv("DATA_ENCRYPTION_KEY", "some-configured-key")
	if got := DataEncryptionKeyPath(dbPath); got != "" {
		t.Fatalf("expected no file path when DATA_ENCRYPTION_KEY is set, got %q", got)
	}
}
