package main

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/johnwmail/webpass/frontend"
	"github.com/johnwmail/webpass/srv"
)

var (
	// Version information injected at build time via ldflags
	Version   = "vdev"
	BuildTime = "unknown"
	Commit    = "unknown"
)

var flagListenAddr = flag.String("listen", ":8080", "address to listen on")

// minJWTSecretBytes is the minimum accepted length for a configured JWT_SECRET.
const minJWTSecretBytes = 32

// insecureJWTSecrets are well-known example values that must never be used.
var insecureJWTSecrets = map[string]bool{
	"change-me-to-random-32-byte-hex":     true,
	"your-random-32-byte-hex-string-here": true,
	"your-secret-key":                     true,
	"test":                                true,
	"secret":                              true,
	"changeme":                            true,
}

// loadJWTSecret validates a configured JWT secret, or generates an ephemeral
// random key when none is configured (suitable for single-instance dev).
func loadJWTSecret(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		key := make([]byte, minJWTSecretBytes)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("generate jwt key: %w", err)
		}
		slog.Warn("JWT_SECRET is not set; using an ephemeral random key. " +
			"Sessions will be invalidated on restart and multi-instance deployments will not share sessions.")
		return key, nil
	}
	if len(raw) < minJWTSecretBytes {
		return nil, fmt.Errorf("JWT_SECRET must be at least %d bytes (got %d); generate one with: openssl rand -hex 32",
			minJWTSecretBytes, len(raw))
	}
	if insecureJWTSecrets[strings.ToLower(raw)] {
		return nil, fmt.Errorf("JWT_SECRET is set to an example/placeholder value; generate one with: openssl rand -hex 32")
	}
	return []byte(raw), nil
}

// newHTTPServer builds the HTTP server with Slowloris/DoS-safe timeouts.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      10 * time.Minute, // git push/pull and exports can be slow
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	flag.Parse()

	// Print version information
	fmt.Printf("WebPass Server\n")
	fmt.Printf("  Version:   %s\n", Version)
	fmt.Printf("  Commit:    %s\n", Commit)
	fmt.Printf("  BuildTime: %s\n", BuildTime)
	fmt.Printf("  Runtime:   %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	fmt.Println()

	// Collect configuration
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "/data/db/db.sqlite3"
	}

	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "frontend/dist"
	}

	disableFrontend := os.Getenv("DISABLE_FRONTEND")
	if disableFrontend == "" {
		disableFrontend = "false"
	}

	gitRepoRoot := os.Getenv("GIT_REPO_ROOT")
	if gitRepoRoot == "" {
		gitRepoRoot = "/data/git-repos"
	}

	corsOrigins := os.Getenv("CORS_ORIGINS")
	if corsOrigins == "" {
		corsOrigins = "(not set)"
	}

	// Determine listen address
	listenAddr := *flagListenAddr
	if port := os.Getenv("PORT"); port != "" {
		listenAddr = ":" + port
	}

	// Hard limit (default 30 minutes, range: 5-480)
	hardLimitMin := 30 // default
	if hardLimitStr := os.Getenv("SESSION_HARDLIMIT_MINUTES"); hardLimitStr != "" {
		if hardLimit, err := strconv.Atoi(hardLimitStr); err == nil {
			if hardLimit >= 5 && hardLimit <= 480 {
				hardLimitMin = hardLimit
			} else if hardLimit < 5 {
				fmt.Printf("WARNING: SESSION_HARDLIMIT_MINUTES=%d too low, using minimum: 5\n", hardLimit)
			} else {
				fmt.Printf("WARNING: SESSION_HARDLIMIT_MINUTES=%d too high, using maximum: 480\n", hardLimit)
			}
		} else {
			fmt.Printf("WARNING: Invalid SESSION_HARDLIMIT_MINUTES=%s, using default: 30\n", hardLimitStr)
		}
	}

	// Soft limit (default 5 minutes, range: 1-60)
	softLimitMin := 5 // default
	if softLimitStr := os.Getenv("SESSION_SOFTLIMIT_MINUTES"); softLimitStr != "" {
		if softLimit, err := strconv.Atoi(softLimitStr); err == nil {
			if softLimit >= 1 && softLimit <= 60 {
				softLimitMin = softLimit
			} else if softLimit < 1 {
				fmt.Printf("WARNING: SESSION_SOFTLIMIT_MINUTES=%d too low, using minimum: 1\n", softLimit)
			} else {
				fmt.Printf("WARNING: SESSION_SOFTLIMIT_MINUTES=%d too high, using maximum: 60\n", softLimit)
			}
		} else {
			fmt.Printf("WARNING: Invalid SESSION_SOFTLIMIT_MINUTES=%s, using default: 5\n", softLimitStr)
		}
	}

	// Print configuration
	fmt.Println("Configuration:")
	fmt.Printf("  Listen Address:  %s\n", listenAddr)
	fmt.Printf("  Database Path:   %s\n", dbPath)
	fmt.Printf("  Static Dir:      %s\n", staticDir)
	fmt.Printf("  Disable Frontend:%s\n", disableFrontend)
	fmt.Printf("  Git Repo Root:   %s\n", gitRepoRoot)
	fmt.Printf("  CORS Origins:    %s\n", corsOrigins)
	fmt.Printf("  Hard Limit:      %d minutes (SESSION_HARDLIMIT_MINUTES)\n", hardLimitMin)
	fmt.Printf("  Soft Limit:      %d minutes (SESSION_SOFTLIMIT_MINUTES)\n", softLimitMin)
	fmt.Println()

	jwtKey, err := loadJWTSecret(os.Getenv("JWT_SECRET"))
	if err != nil {
		return err
	}

	// On OpenBSD, restrict the filesystem view and syscall surface before the
	// database and network are opened. No-op on other platforms.
	registrationCodeFile := strings.TrimSpace(os.Getenv("REGISTRATION_CODE_FILE"))
	if registrationCodeFile == "" {
		registrationCodeFile = srv.DefaultCodeFile()
	}
	sandboxPaths := srv.SandboxPaths{
		DBPath:               dbPath,
		RepoRoot:             gitRepoRoot,
		DataKeyPath:          srv.DataEncryptionKeyPath(dbPath),
		RegistrationCodeFile: registrationCodeFile,
		StaticDir:            staticDir,
	}
	if err := srv.HardenProcess(sandboxPaths); err != nil {
		return fmt.Errorf("apply OpenBSD sandbox: %w", err)
	}

	server, err := srv.New(dbPath, jwtKey, hardLimitMin, softLimitMin)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}

	// Pass version info to server
	server.Version = Version
	server.BuildTime = BuildTime
	server.Commit = Commit

	// Serve the frontend SPA unless disabled.
	// Priority: an existing on-disk STATIC_DIR (local dev / custom deployments)
	// takes precedence, otherwise fall back to the assets embedded in the binary.
	if disableFrontend == "" || disableFrontend == "0" || disableFrontend == "false" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			server.StaticDir = staticDir
			fmt.Printf("  Frontend Source: disk (%s)\n", staticDir)
		} else if embedded, err := frontend.Dist(); err == nil {
			if _, statErr := fs.Stat(embedded, "index.html"); statErr == nil {
				server.StaticFS = embedded
				fmt.Println("  Frontend Source: embedded")
			} else {
				fmt.Println("  Frontend Source: none (embedded assets missing; run `npm run build`)")
			}
		} else {
			fmt.Printf("  Frontend Source: none (embedded assets error: %v)\n", err)
		}
	} else {
		fmt.Println("  Frontend Source: disabled")
	}

	// Create HTTP server
	httpServer := newHTTPServer(listenAddr, server.Handler())

	// Start server in goroutine
	go func() {
		slog.Info("starting server", "addr", listenAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server...")

	// Give outstanding requests 30 seconds to complete
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	// Close database connection
	if err := server.CloseDB(); err != nil {
		slog.Error("database close error", "error", err)
	} else {
		slog.Info("database connection closed")
	}

	slog.Info("server stopped")
	return nil
}
