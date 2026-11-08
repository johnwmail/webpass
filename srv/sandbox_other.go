//go:build !openbsd

package srv

// HardenProcess is a no-op outside OpenBSD.
func HardenProcess(p SandboxPaths) error { return nil }
