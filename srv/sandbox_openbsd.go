//go:build openbsd

package srv

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// HardenProcess applies OpenBSD unveil(2) and pledge(2).
//
// unveil is set up first (only the paths the server actually uses), then
// pledge restricts the syscall surface. Set DISABLE_SANDBOX=1 to skip this
// (e.g. while debugging a deployment).
func HardenProcess(p SandboxPaths) error {
	if envBool("DISABLE_SANDBOX") {
		return nil
	}

	unveil := func(path, flags string) {
		if path == "" {
			return
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		// Missing paths are fine; the parent directory is unveiled
		// separately so the server can still create them.
		_ = unix.Unveil(path, flags)
	}
	unveilWithParent := func(path, flags string) {
		if path == "" {
			return
		}
		unveil(filepath.Dir(path), flags)
		unveil(path, flags)
	}

	// Database + WAL/SHM + data encryption key.
	unveilWithParent(p.DBPath, "rwc")
	unveilWithParent(p.DataKeyPath, "rwc")

	// Git sync worktrees/clones.
	unveilWithParent(p.RepoRoot, "rwc")

	// Rotating registration code file.
	unveilWithParent(p.RegistrationCodeFile, "rwc")

	// Optional on-disk frontend (embedded assets need nothing).
	unveil(p.StaticDir, "r")

	// Configured TMPDIR / CA locations and operator-provided extra paths.
	unveilWithParent(os.TempDir(), "rwc")
	if f := strings.TrimSpace(os.Getenv("SSL_CERT_FILE")); f != "" {
		unveil(f, "r")
	}
	if d := strings.TrimSpace(os.Getenv("SSL_CERT_DIR")); d != "" {
		unveil(d, "r")
	}
	extra, err := extraUnveilEntries()
	if err != nil {
		return err
	}
	for _, e := range extra {
		if strings.ContainsAny(e.Flags, "wc") {
			unveilWithParent(e.Path, e.Flags)
		} else {
			unveil(e.Path, e.Flags)
		}
	}

	// DNS, TLS roots, timezone and random devices used by the runtime.
	unveil("/etc/resolv.conf", "r")
	unveil("/etc/hosts", "r")
	unveil("/etc/services", "r")
	unveil("/etc/ssl", "r")
	unveil("/etc/localtime", "r")
	unveil("/dev/urandom", "r")
	unveil("/dev/null", "rw")
	unveil("/tmp", "rwc")

	unix.UnveilBlock()

	promises := openBSDPromises()
	if err := unix.PledgePromises(promises); err != nil {
		return fmt.Errorf("pledge(%q): %w", promises, err)
	}
	slog.Info("openbsd sandbox applied", "promises", promises, "extra_unveil_paths", len(extra))
	return nil
}
