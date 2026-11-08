package srv

import (
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
