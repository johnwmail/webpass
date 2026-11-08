//go:build openbsd

package srv

import (
	"fmt"
	"path/filepath"

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

	promises := "stdio rpath wpath cpath inet dns unix flock fattr"
	if err := unix.PledgePromises(promises); err != nil {
		return fmt.Errorf("pledge(%q): %w", promises, err)
	}
	return nil
}
