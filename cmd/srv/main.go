package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"
	"runtime"

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

	// Print configuration
	fmt.Println("Configuration:")
	fmt.Printf("  Listen Address:  %s\n", listenAddr)
	fmt.Printf("  Database Path:   %s\n", dbPath)
	fmt.Printf("  Static Dir:      %s\n", staticDir)
	fmt.Printf("  Disable Frontend:%s\n", disableFrontend)
	fmt.Printf("  Git Repo Root:   %s\n", gitRepoRoot)
	fmt.Printf("  CORS Origins:    %s\n", corsOrigins)
	fmt.Println()

	jwtKey := make([]byte, 32)
	if key := os.Getenv("JWT_SECRET"); key != "" {
		jwtKey = []byte(key)
	} else {
		if _, err := rand.Read(jwtKey); err != nil {
			return fmt.Errorf("generate jwt key: %w", err)
		}
	}

	server, err := srv.New(dbPath, jwtKey)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}

	// Serve frontend static files if directory exists and not disabled
	if disableFrontend == "" || disableFrontend == "0" || disableFrontend == "false" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			server.StaticDir = staticDir
		}
	}

	return server.Serve(listenAddr)
}
