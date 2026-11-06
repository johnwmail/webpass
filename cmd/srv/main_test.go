package main

import (
	"net/http"
	"testing"
	"time"
)

func TestLoadJWTSecret(t *testing.T) {
	t.Run("unset generates ephemeral key", func(t *testing.T) {
		key, err := loadJWTSecret("")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(key) != minJWTSecretBytes {
			t.Fatalf("expected %d-byte key, got %d", minJWTSecretBytes, len(key))
		}
	})

	t.Run("too short is rejected", func(t *testing.T) {
		if _, err := loadJWTSecret("short-secret"); err == nil {
			t.Fatal("expected short secret to be rejected")
		}
	})

	t.Run("placeholder is rejected", func(t *testing.T) {
		for _, v := range []string{
			"change-me-to-random-32-byte-hex",
			"your-random-32-byte-hex-string-here",
		} {
			if _, err := loadJWTSecret(v); err == nil {
				t.Fatalf("expected placeholder %q to be rejected", v)
			}
		}
	})

	t.Run("valid secret is accepted", func(t *testing.T) {
		secret := "0123456789abcdef0123456789abcdef"
		key, err := loadJWTSecret(secret)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(key) != secret {
			t.Fatalf("expected key %q, got %q", secret, string(key))
		}
	})

	t.Run("surrounding whitespace is trimmed", func(t *testing.T) {
		secret := "0123456789abcdef0123456789abcdef"
		key, err := loadJWTSecret("  " + secret + "\n")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(key) != secret {
			t.Fatalf("expected trimmed key, got %q", string(key))
		}
	})
}

func TestNewHTTPServerTimeouts(t *testing.T) {
	srv := newHTTPServer(":0", http.NewServeMux())
	if srv.ReadHeaderTimeout <= 0 {
		t.Error("ReadHeaderTimeout must be set (Slowloris protection)")
	}
	if srv.ReadTimeout <= 0 {
		t.Error("ReadTimeout must be set")
	}
	if srv.WriteTimeout <= 0 {
		t.Error("WriteTimeout must be set")
	}
	if srv.IdleTimeout <= 0 {
		t.Error("IdleTimeout must be set")
	}
	if srv.MaxHeaderBytes <= 0 || srv.MaxHeaderBytes > 1<<20 {
		t.Errorf("unexpected MaxHeaderBytes: %d", srv.MaxHeaderBytes)
	}
	if srv.ReadHeaderTimeout > 30*time.Second {
		t.Errorf("ReadHeaderTimeout too generous: %v", srv.ReadHeaderTimeout)
	}
}
