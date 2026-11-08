package srv

import (
	"reflect"
	"testing"
)

func TestOpenBSDPromises(t *testing.T) {
	t.Setenv("OPENBSD_PLEDGE_PROMISES", "")
	if got := openBSDPromises(); got != defaultOpenBSDPromises {
		t.Fatalf("expected default promises %q, got %q", defaultOpenBSDPromises, got)
	}

	t.Setenv("OPENBSD_PLEDGE_PROMISES", "stdio rpath")
	if got := openBSDPromises(); got != "stdio rpath" {
		t.Fatalf("expected override, got %q", got)
	}
}

func TestExtraUnveilEntries(t *testing.T) {
	t.Run("unset", func(t *testing.T) {
		t.Setenv("OPENBSD_UNVEIL_EXTRA_PATHS", "")
		got, err := extraUnveilEntries()
		if err != nil || got != nil {
			t.Fatalf("expected nil/nil, got %v/%v", got, err)
		}
	})

	t.Run("valid", func(t *testing.T) {
		t.Setenv("OPENBSD_UNVEIL_EXTRA_PATHS", "/etc/certs:r, /var/cache:rwc, /tmp/plain")
		got, err := extraUnveilEntries()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []unveilEntry{
			{Path: "/etc/certs", Flags: "r"},
			{Path: "/var/cache", Flags: "rwc"},
			{Path: "/tmp/plain", Flags: "r"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("expected %+v, got %+v", want, got)
		}
	})

	t.Run("empty flags default to r", func(t *testing.T) {
		t.Setenv("OPENBSD_UNVEIL_EXTRA_PATHS", "/tmp/plain:")
		got, err := extraUnveilEntries()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 || got[0].Flags != "r" {
			t.Fatalf("expected default r flags, got %+v", got)
		}
	})

	t.Run("invalid flags", func(t *testing.T) {
		for _, raw := range []string{"/tmp/x:x", "/tmp/x:rZ", "/tmp/x:rwcz"} {
			t.Setenv("OPENBSD_UNVEIL_EXTRA_PATHS", raw)
			if _, err := extraUnveilEntries(); err == nil {
				t.Fatalf("expected %q to be rejected", raw)
			}
		}
	})

	t.Run("empty path", func(t *testing.T) {
		t.Setenv("OPENBSD_UNVEIL_EXTRA_PATHS", ":rwc")
		if _, err := extraUnveilEntries(); err == nil {
			t.Fatal("expected empty path to be rejected")
		}
	})
}
