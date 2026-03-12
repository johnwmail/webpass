package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"

	"srv.exe.dev/srv"
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

	jwtKey := make([]byte, 32)
	if key := os.Getenv("JWT_SECRET"); key != "" {
		jwtKey = []byte(key)
	} else {
		if _, err := rand.Read(jwtKey); err != nil {
			return fmt.Errorf("generate jwt key: %w", err)
		}
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "/data/db/db.sqlite3"
	}

	server, err := srv.New(dbPath, jwtKey)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}

	// Serve frontend static files if directory exists and not disabled
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "frontend/dist"
	}

	// Check if frontend serving is disabled
	disableFrontend := os.Getenv("DISABLE_FRONTEND")
	if disableFrontend == "" || disableFrontend == "0" || disableFrontend == "false" {
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			server.StaticDir = staticDir
		}
	}

	// Allow PORT env var to override default listen address
	listenAddr := *flagListenAddr
	if port := os.Getenv("PORT"); port != "" {
		listenAddr = ":" + port
	}

	return server.Serve(listenAddr)
}
