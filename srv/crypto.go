package srv

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// totpSecretPrefix marks secrets encrypted with SecretBox. Values without the
// prefix are legacy plaintext rows and are transparently upgraded on use.
const totpSecretPrefix = "enc:v1:"

// totpSecretAAD binds the ciphertext to its purpose.
var totpSecretAAD = []byte("webpass:totp-secret:v1")

// SecretBox provides AES-256-GCM encryption for small secrets stored at rest.
type SecretBox struct {
	aead cipher.AEAD
}

func newSecretBox(key []byte) (*SecretBox, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("data encryption key must be 32 bytes (got %d)", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretBox{aead: aead}, nil
}

func (b *SecretBox) EncryptString(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := b.aead.Seal(nil, nonce, []byte(plain), totpSecretAAD)
	buf := append(nonce, ct...)
	return totpSecretPrefix + base64.StdEncoding.EncodeToString(buf), nil
}

func (b *SecretBox) DecryptString(value string) (string, error) {
	// Legacy plaintext rows remain readable; callers re-encrypt after use.
	if !strings.HasPrefix(value, totpSecretPrefix) {
		return value, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, totpSecretPrefix))
	if err != nil {
		return "", fmt.Errorf("decode encrypted secret: %w", err)
	}
	ns := b.aead.NonceSize()
	if len(raw) < ns {
		return "", fmt.Errorf("encrypted secret is too short")
	}
	plain, err := b.aead.Open(nil, raw[:ns], raw[ns:], totpSecretAAD)
	if err != nil {
		return "", fmt.Errorf("decrypt secret: %w", err)
	}
	return string(plain), nil
}

// loadSecretBox returns the key used to encrypt secrets at rest.
//
// Priority:
//  1. DATA_ENCRYPTION_KEY (64 hex chars, base64, or >=32 raw bytes)
//  2. a persisted key file next to the SQLite database
//  3. a key derived from JWT_SECRET (dev / in-memory databases only)
func loadSecretBox(dbPath string, jwtKey []byte) (*SecretBox, error) {
	if raw := strings.TrimSpace(os.Getenv("DATA_ENCRYPTION_KEY")); raw != "" {
		key, err := parseEncryptionKey(raw)
		if err != nil {
			return nil, fmt.Errorf("DATA_ENCRYPTION_KEY: %w", err)
		}
		return newSecretBox(key)
	}

	// Key file next to the database gives zero-config persistence across
	// restarts without requiring a new environment variable.
	if isMemoryDB(dbPath) {
		return newSecretBox(deriveKey(jwtKey))
	}

	keyPath := filepath.Join(filepath.Dir(dbPath), "data_encryption.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, err := parseEncryptionKey(strings.TrimSpace(string(data)))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", keyPath, err)
		}
		return newSecretBox(key)
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read %s: %w", keyPath, err)
	}

	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, []byte(hex.EncodeToString(key)), 0600); err != nil {
		return nil, fmt.Errorf("write %s: %w", keyPath, err)
	}
	slog.Warn("generated data encryption key; back it up together with the database", "path", keyPath)
	return newSecretBox(key)
}

func parseEncryptionKey(raw string) ([]byte, error) {
	if decoded, err := hex.DecodeString(raw); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len(raw) >= 32 {
		return deriveKey([]byte(raw)), nil
	}
	return nil, fmt.Errorf("must be 32 bytes (64 hex chars), base64, or at least 32 raw characters")
}

func deriveKey(secret []byte) []byte {
	sum := sha256.Sum256(append(append([]byte(nil), secret...), []byte("webpass:data-encryption:v1")...))
	return sum[:]
}

func isMemoryDB(path string) bool {
	p := strings.TrimSpace(path)
	return p == "" || p == ":memory:" || strings.HasPrefix(p, "file::memory:") || strings.Contains(p, "mode=memory")
}
