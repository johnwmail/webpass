package srv

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SandboxPaths lists the filesystem locations the process needs after startup.
// On OpenBSD these are unveiled before pledge(2) is applied; on other platforms
// they are ignored.
type SandboxPaths struct {
	DBPath               string
	RepoRoot             string
	DataKeyPath          string
	RegistrationCodeFile string
	StaticDir            string
}

// DataEncryptionKeyPath returns the persisted key file path used when
// DATA_ENCRYPTION_KEY is not set, or "" when no file is used.
func DataEncryptionKeyPath(dbPath string) string {
	if strings.TrimSpace(os.Getenv("DATA_ENCRYPTION_KEY")) != "" || isMemoryDB(dbPath) {
		return ""
	}
	return filepath.Join(filepath.Dir(dbPath), "data_encryption.key")
}

// defaultOpenBSDPromises is the pledge promise set used when
// OPENBSD_PLEDGE_PROMISES is not set.
const defaultOpenBSDPromises = "stdio rpath wpath cpath inet dns unix flock fattr"

// openBSDPromises returns the configured pledge promise set.
func openBSDPromises() string {
	if raw := strings.TrimSpace(os.Getenv("OPENBSD_PLEDGE_PROMISES")); raw != "" {
		return raw
	}
	return defaultOpenBSDPromises
}

type unveilEntry struct {
	Path  string
	Flags string
}

// extraUnveilEntries parses OPENBSD_UNVEIL_EXTRA_PATHS.
// Format: comma-separated "path[:flags]" where flags are a subset of r/w/c.
func extraUnveilEntries() ([]unveilEntry, error) {
	raw := strings.TrimSpace(os.Getenv("OPENBSD_UNVEIL_EXTRA_PATHS"))
	if raw == "" {
		return nil, nil
	}

	var entries []unveilEntry
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		path, flags := part, "r"
		if i := strings.LastIndex(part, ":"); i >= 0 {
			suffix := strings.TrimSpace(part[i+1:])
			switch {
			case suffix == "":
				path = strings.TrimSpace(part[:i])
			case isUnveilFlags(suffix):
				path = strings.TrimSpace(part[:i])
				flags = suffix
			case isASCIILetters(suffix):
				return nil, fmt.Errorf("invalid unveil flags %q for %q", suffix, strings.TrimSpace(part[:i]))
			}
		}
		if path == "" {
			return nil, fmt.Errorf("empty unveil path in OPENBSD_UNVEIL_EXTRA_PATHS")
		}
		entries = append(entries, unveilEntry{Path: path, Flags: flags})
	}
	return entries, nil
}

func isUnveilFlags(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r != 'r' && r != 'w' && r != 'c' {
			return false
		}
	}
	return true
}

func isASCIILetters(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}
