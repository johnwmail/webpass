package main

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"srv.exe.dev/srv"
)

var (
	// Version information injected at build time via ldflags
	Version   = "vdev"
	BuildTime = "unknown"
	Commit    = "unknown"
)

var flagListenAddr = flag.String("listen", ":8080", "address to listen on")

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

	jwtKey := make([]byte, 32)
	if key := os.Getenv("JWT_SECRET"); key != "" {
		jwtKey = []byte(key)
	} else {
		if _, err := rand.Read(jwtKey); err != nil {
			return fmt.Errorf("generate jwt key: %w", err)
		}
	}

	server, err := srv.New(dbPath, jwtKey, hardLimitMin, softLimitMin)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}

	// Pass version info to server
	server.Version = Version
	server.BuildTime = BuildTime
	server.Commit = Commit

	// Serve frontend static files if directory exists and not disabled
	if disableFrontend == "" || disableFrontend == "0" || disableFrontend == "false" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			server.StaticDir = staticDir
		}
	}

	// Create HTTP server
	httpServer := &http.Server{
		Addr:    listenAddr,
		Handler: server.Handler(),
	}

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
