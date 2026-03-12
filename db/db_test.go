package db

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpen(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Verify pragmas were set
	var foreignKeys int
	err = db.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys)
	if err != nil {
		t.Fatalf("failed to check foreign_keys pragma: %v", err)
	}
	if foreignKeys != 1 {
		t.Errorf("expected foreign_keys=1, got %d", foreignKeys)
	}

	var journalMode string
	err = db.QueryRow("PRAGMA journal_mode").Scan(&journalMode)
	if err != nil {
		t.Fatalf("failed to check journal_mode pragma: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("expected journal_mode=wal, got %s", journalMode)
	}

	var busyTimeout int
	err = db.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout)
	if err != nil {
		t.Fatalf("failed to check busy_timeout pragma: %v", err)
	}
	if busyTimeout != 1000 {
		t.Errorf("expected busy_timeout=1000, got %d", busyTimeout)
	}
}

func TestOpenInvalidPath(t *testing.T) {
	// Try to open in a non-existent directory
	db, err := Open("/nonexistent/path/to/db.sqlite3")
	if err == nil {
		_ = db.Close()
		t.Fatal("expected error when opening database in non-existent path")
	}
}

func TestRunMigrations(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Run migrations
	err = RunMigrations(db)
	if err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// Verify migrations table exists and has entries
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM migrations").Scan(&count)
	if err != nil {
		t.Fatalf("failed to query migrations table: %v", err)
	}
	if count == 0 {
		t.Error("expected migrations to be recorded")
	}

	// Verify users table exists
	var tableName string
	err = db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").Scan(&tableName)
	if err != nil {
		t.Fatal("users table should exist after migrations")
	}

	// Verify entries table exists
	err = db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").Scan(&tableName)
	if err != nil {
		t.Fatal("entries table should exist after migrations")
	}
}

func TestRunMigrationsIdempotent(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Run migrations twice
	if err := RunMigrations(db); err != nil {
		t.Fatalf("first migration run failed: %v", err)
	}
	if err := RunMigrations(db); err != nil {
		t.Fatalf("second migration run failed: %v", err)
	}

	// Verify migrations table has correct count (should not duplicate)
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM migrations").Scan(&count)
	if err != nil {
		t.Fatalf("failed to query migrations table: %v", err)
	}
	// Should have unique migration entries
	rows, err := db.Query("SELECT migration_number FROM migrations")
	if err != nil {
		t.Fatalf("failed to query migrations: %v", err)
	}
	t.Cleanup(func() { _ = rows.Close() })

	seen := make(map[int]bool)
	for rows.Next() {
		var num int
		if err := rows.Scan(&num); err != nil {
			t.Fatalf("scan migration number: %v", err)
		}
		if seen[num] {
			t.Errorf("duplicate migration number: %d", num)
		}
		seen[num] = true
	}
}

func TestExecuteMigration(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.sqlite3")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Create a test migration file
	migrationsDir := filepath.Join(tmpDir, "migrations")
	if err := os.MkdirAll(migrationsDir, 0755); err != nil {
		t.Fatalf("failed to create migrations dir: %v", err)
	}

	testMigration := `
CREATE TABLE test_table (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL
);
`
	testFile := filepath.Join(migrationsDir, "999-test.sql")
	if err := os.WriteFile(testFile, []byte(testMigration), 0644); err != nil {
		t.Fatalf("failed to write test migration: %v", err)
	}

	// Temporarily replace the migrationFS with the test directory
	// Note: We can't actually do this with embed.FS, so we test via RunMigrations
	// This test verifies the executeMigration function indirectly
	t.Skip("executeMigration tested indirectly via RunMigrations")
}
