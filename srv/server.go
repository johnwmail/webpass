package srv

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"srv.exe.dev/db"
	"srv.exe.dev/db/dbgen"
)

// Server is the WebPass API server.
type Server struct {
	DB              *sql.DB
	Q               *dbgen.Queries
	JWTKey          []byte
	StaticDir       string // path to frontend dist/ directory (optional)
	GitService      *GitService
	sessionDuration time.Duration
	// Version info (set from main package)
	Version   string
	BuildTime string
	Commit    string
}

// New creates a new Server, opening the database and running migrations.
func New(dbPath string, jwtKey []byte, sessionDurationMin int) (*Server, error) {
	wdb, err := db.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if err := db.RunMigrations(wdb); err != nil {
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	s := &Server{
		DB:     wdb,
		Q:      dbgen.New(wdb),
		JWTKey: jwtKey,
	}
	s.sessionDuration = time.Duration(sessionDurationMin) * time.Minute

	// Initialize Git service
	repoRoot := os.Getenv("GIT_REPO_ROOT")
	if repoRoot == "" {
		repoRoot = "/data/git-repos"
	}
	if err := os.MkdirAll(repoRoot, 0700); err != nil {
		return nil, fmt.Errorf("create repo root: %w", err)
	}
	s.GitService = NewGitService(dbPath, dbgen.New(wdb), repoRoot)

	return s, nil
}

// Serve starts the HTTP server.
func (s *Server) Serve(addr string) error {
	slog.Info("starting server", "addr", addr)
	return http.ListenAndServe(addr, s.Handler())
}

// Handler returns the root http.Handler with CORS and routing.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public routes
	mux.HandleFunc("POST /api", s.handleCreateUser)
	mux.HandleFunc("POST /api/{fingerprint}/login", s.handleLogin)
	mux.HandleFunc("POST /api/{fingerprint}/login/2fa", s.handleLogin2FA)

	// Authenticated routes
	mux.HandleFunc("POST /api/{fingerprint}/totp/setup", s.requireAuth(s.handleTOTPSetup))
	mux.HandleFunc("POST /api/{fingerprint}/totp/confirm", s.requireAuth(s.handleTOTPConfirm))
	mux.HandleFunc("GET /api/{fingerprint}/entries", s.requireAuth(s.handleListEntries))
	mux.HandleFunc("POST /api/{fingerprint}/entries/move", s.requireAuth(s.handleMoveEntry))
	mux.HandleFunc("GET /api/{fingerprint}/export", s.requireAuth(s.handleExport))
	mux.HandleFunc("POST /api/{fingerprint}/import", s.requireAuth(s.handleImport))
	// Git sync routes
	mux.HandleFunc("GET /api/{fingerprint}/git/status", s.requireAuth(s.handleGitStatus))
	mux.HandleFunc("GET /api/{fingerprint}/git/config", s.requireAuth(s.handleGitGetConfig))
	mux.HandleFunc("POST /api/{fingerprint}/git/config", s.requireAuth(s.handleGitConfig))
	mux.HandleFunc("POST /api/{fingerprint}/git/session", s.requireAuth(s.handleGitSession))
	mux.HandleFunc("POST /api/{fingerprint}/git/push", s.requireAuth(s.handleGitPush))
	mux.HandleFunc("POST /api/{fingerprint}/git/pull", s.requireAuth(s.handleGitPull))
	mux.HandleFunc("POST /api/{fingerprint}/git/toggle-sync", s.requireAuth(s.handleGitToggleSync))
	mux.HandleFunc("GET /api/{fingerprint}/git/log", s.requireAuth(s.handleGitLog))
	// Wildcard entry routes — {path...} captures the rest
	mux.HandleFunc("GET /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handleGetEntry))
	mux.HandleFunc("PUT /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handlePutEntry))
	mux.HandleFunc("DELETE /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handleDeleteEntry))

	// Account deletion
	mux.HandleFunc("DELETE /api/{fingerprint}/account", s.requireAuth(s.handleDeleteAccount))

	// Password change
	mux.HandleFunc("POST /api/{fingerprint}/password", s.requireAuth(s.handleChangePassword))

	// Health check
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Version info
	mux.HandleFunc("GET /api/version", s.handleVersion)

	// Serve frontend SPA if StaticDir is set
	if s.StaticDir != "" {
		fs := http.FileServer(http.Dir(s.StaticDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			// Try to serve the file directly
			path := r.URL.Path
			if path == "/" {
				http.ServeFile(w, r, s.StaticDir+"/index.html")
				return
			}
			// Check if file exists
			if _, err := os.Stat(s.StaticDir + path); err == nil {
				fs.ServeHTTP(w, r)
				return
			}
			// SPA fallback: serve index.html for all other routes
			http.ServeFile(w, r, s.StaticDir+"/index.html")
		})
	}

	return s.corsMiddleware(mux)
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	allowed := parseCORSOrigins(os.Getenv("CORS_ORIGINS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if len(allowed) == 0 || allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Max-Age", "86400")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func parseCORSOrigins(raw string) map[string]bool {
	if raw == "" {
		return nil // nil = allow all
	}
	m := make(map[string]bool)
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			m[o] = true
		}
	}
	return m
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

func (s *Server) createToken(fingerprint string) (string, error) {
	claims := jwt.MapClaims{
		"fp":  fingerprint,
		"exp": time.Now().Add(s.sessionDuration).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.JWTKey)
}

// requireAuth wraps a handler, verifying JWT and that the token fingerprint
// matches the {fp} path variable.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fp := r.PathValue("fingerprint")
		tokenFP, err := s.verifyToken(r)
		if err != nil {
			jsonError(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if tokenFP != fp {
			jsonError(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (s *Server) verifyToken(r *http.Request) (string, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", fmt.Errorf("missing bearer token")
	}
	tokenStr := strings.TrimPrefix(auth, "Bearer ")
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.JWTKey, nil
	})
	if err != nil {
		return "", err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return "", fmt.Errorf("invalid token")
	}
	fp, ok := claims["fp"].(string)
	if !ok {
		return "", fmt.Errorf("missing fp claim")
	}
	return fp, nil
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// fingerprintFromKey computes a short fingerprint from a public key string.
func fingerprintFromKey(publicKey string) string {
	h := sha256.Sum256([]byte(publicKey))
	return hex.EncodeToString(h[:8]) // first 16 hex chars
}

// ---------------------------------------------------------------------------
// POST /api — create user
// ---------------------------------------------------------------------------

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password    string `json:"password"`
		PublicKey   string `json:"public_key"`
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Password == "" || body.PublicKey == "" {
		jsonError(w, "password and public_key required", http.StatusBadRequest)
		return
	}

	fp := body.Fingerprint
	if fp == "" {
		fp = fingerprintFromKey(body.PublicKey)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("bcrypt hash", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := s.Q.CreateUser(r.Context(), dbgen.CreateUserParams{
		Fingerprint:  fp,
		PasswordHash: string(hash),
		PublicKey:    body.PublicKey,
	}); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			jsonError(w, "user already exists", http.StatusConflict)
			return
		}
		slog.Error("create user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"fingerprint": fp})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/login — login
// ---------------------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if user.TotpEnabled != nil && *user.TotpEnabled == 1 {
		jsonOK(w, map[string]bool{"requires_2fa": true})
		return
	}

	token, err := s.createToken(fp)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"token": token})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/login/2fa — complete 2FA login
// ---------------------------------------------------------------------------

func (s *Server) handleLogin2FA(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if user.TotpSecret == nil || !totp.Validate(body.TOTPCode, *user.TotpSecret) {
		jsonError(w, "invalid 2fa code", http.StatusUnauthorized)
		return
	}

	token, err := s.createToken(fp)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"token": token})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/totp/setup — begin TOTP setup
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "WebPass",
		AccountName: fp,
	})
	if err != nil {
		slog.Error("generate totp", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{
		"secret": key.Secret(),
		"url":    key.URL(),
	})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/totp/confirm — confirm TOTP setup
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		Secret string `json:"secret"`
		Code   string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if !totp.Validate(body.Code, body.Secret) {
		jsonError(w, "invalid totp code", http.StatusBadRequest)
		return
	}

	enabled := int64(1)
	if err := s.Q.UpdateUserTOTP(r.Context(), dbgen.UpdateUserTOTPParams{
		TotpSecret:  &body.Secret,
		TotpEnabled: &enabled,
		Fingerprint: fp,
	}); err != nil {
		slog.Error("update totp", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]bool{"enabled": true})
}

// ---------------------------------------------------------------------------
// GET /api/version — get version information
// ---------------------------------------------------------------------------

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]string{
		"version":    s.Version,
		"commit":     s.Commit,
		"build_time": s.BuildTime,
	})
}

// ---------------------------------------------------------------------------
// GET /api/{fingerprint}/entries — list entries
// ---------------------------------------------------------------------------

func (s *Server) handleListEntries(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	entries, err := s.Q.ListEntries(r.Context(), fp)
	if err != nil {
		slog.Error("list entries", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	type entryItem struct {
		Path    string     `json:"path"`
		Created *time.Time `json:"created"`
		Updated *time.Time `json:"updated"`
	}
	items := make([]entryItem, len(entries))
	for i, e := range entries {
		items[i] = entryItem{Path: e.Path, Created: e.Created, Updated: e.Updated}
	}
	jsonOK(w, map[string]any{"entries": items})
}

// ---------------------------------------------------------------------------
// GET /api/{fingerprint}/entries/{path...} — get entry blob
// ---------------------------------------------------------------------------

func (s *Server) handleGetEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	path := r.PathValue("path")
	if path == "" {
		jsonError(w, "path required", http.StatusBadRequest)
		return
	}

	entry, err := s.Q.GetEntry(r.Context(), dbgen.GetEntryParams{
		Fingerprint: fp,
		Path:        path,
	})
	if err != nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(entry.Content)
}

// ---------------------------------------------------------------------------
// PUT /api/{fingerprint}/entries/{path...} — create/update entry
// ---------------------------------------------------------------------------

func (s *Server) handlePutEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	path := r.PathValue("path")
	if path == "" {
		jsonError(w, "path required", http.StatusBadRequest)
		return
	}

	content, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
	if err != nil {
		jsonError(w, "read body failed", http.StatusBadRequest)
		return
	}
	if len(content) == 0 {
		jsonError(w, "empty body", http.StatusBadRequest)
		return
	}

	if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
		Fingerprint: fp,
		Path:        path,
		Content:     content,
	}); err != nil {
		slog.Error("upsert entry", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// DELETE /api/{fingerprint}/entries/{path...} — delete entry
// ---------------------------------------------------------------------------

func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	path := r.PathValue("path")
	if path == "" {
		jsonError(w, "path required", http.StatusBadRequest)
		return
	}

	if err := s.Q.DeleteEntry(r.Context(), dbgen.DeleteEntryParams{
		Fingerprint: fp,
		Path:        path,
	}); err != nil {
		slog.Error("delete entry", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// DELETE /api/{fingerprint}/account — delete user account
// ---------------------------------------------------------------------------

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if fp == "" {
		jsonError(w, "fingerprint required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Get all entries for this user and delete them
	entries, err := s.Q.ListEntries(ctx, fp)
	if err != nil {
		slog.Error("list entries", "error", err)
	}
	for _, entry := range entries {
		if err := s.Q.DeleteEntry(ctx, dbgen.DeleteEntryParams{
			Fingerprint: fp,
			Path:        entry.Path,
		}); err != nil {
			slog.Error("delete entry", "path", entry.Path, "error", err)
		}
	}

	// Delete user account
	if err := s.Q.DeleteUser(ctx, fp); err != nil {
		slog.Error("delete user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Delete git repo folder if it exists
	if s.GitService != nil {
		repoPath := filepath.Join(s.GitService.repoRoot, fp)
		if _, err := os.Stat(repoPath); err == nil {
			if err := os.RemoveAll(repoPath); err != nil {
				slog.Error("delete git repo", "error", err)
			}
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/password — change password
// ---------------------------------------------------------------------------

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if fp == "" {
		jsonError(w, "fingerprint required", http.StatusBadRequest)
		return
	}

	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.CurrentPassword == "" || body.NewPassword == "" {
		jsonError(w, "current_password and new_password required", http.StatusBadRequest)
		return
	}

	// Get user to verify current password
	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	// Verify current password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	// Generate new password hash
	newHash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("bcrypt hash", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Update password
	if err := s.Q.UpdatePassword(r.Context(), dbgen.UpdatePasswordParams{
		PasswordHash: string(newHash),
		Fingerprint:  fp,
	}); err != nil {
		slog.Error("update password", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	slog.Info("password changed successfully", "fingerprint", fp)
	jsonOK(w, map[string]string{"status": "success"})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/entries/move — move/rename entry
// ---------------------------------------------------------------------------

func (s *Server) handleMoveEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.From == "" || body.To == "" {
		jsonError(w, "from and to required", http.StatusBadRequest)
		return
	}

	if err := s.Q.MoveEntry(r.Context(), dbgen.MoveEntryParams{
		Path:        body.To,
		Fingerprint: fp,
		Path_2:      body.From,
	}); err != nil {
		slog.Error("move entry", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// GET /api/{fingerprint}/export — export all entries as tar.gz
// ---------------------------------------------------------------------------

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	entries, err := s.Q.ListEntriesContent(r.Context(), fp)
	if err != nil {
		slog.Error("EXPORT: failed", "fingerprint", fp, "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	slog.Info("EXPORT: exporting entries", "fingerprint", fp, "entries", len(entries))

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"password-store.tar.gz\"")

	gw := gzip.NewWriter(w)
	defer func() { _ = gw.Close() }()
	tw := tar.NewWriter(gw)
	defer func() { _ = tw.Close() }()

	for _, e := range entries {
		hdr := &tar.Header{
			Name: e.Path + ".gpg",
			Mode: 0600,
			Size: int64(len(e.Content)),
		}
		if e.Updated != nil {
			hdr.ModTime = *e.Updated
		}
		if err := tw.WriteHeader(hdr); err != nil {
			slog.Error("EXPORT: tar write header failed", "fingerprint", fp, "error", err)
			return
		}
		if _, err := tw.Write(e.Content); err != nil {
			slog.Error("EXPORT: tar write content failed", "fingerprint", fp, "error", err)
			return
		}
	}

	slog.Info("EXPORT: completed", "fingerprint", fp, "entries", len(entries))
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/import — import tar.gz or JSON batch
// ---------------------------------------------------------------------------

// handleImport supports two formats:
// 1. Content-Type: application/gzip — binary tar.gz (legacy, for WebPass-to-WebPass)
// 2. Content-Type: application/json — JSON array [{path, content}] (new, for import with re-encryption)
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	contentType := r.Header.Get("Content-Type")

	// Check content type to determine format
	if strings.HasPrefix(contentType, "application/json") {
		// New JSON batch format (client-side decrypted and re-encrypted)
		s.handleImportJSON(w, r, fp)
	} else {
		// Legacy tar.gz format (server-side parsing, no re-encryption)
		s.handleImportTarGz(w, r, fp)
	}
}

// handleImportJSON handles JSON batch import (new format)
func (s *Server) handleImportJSON(w http.ResponseWriter, r *http.Request, fp string) {
	var entries []struct {
		Path    string `json:"path"`
		Content any    `json:"content"` // Support both string (armored/base64) and []byte
	}

	if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
		slog.Error("IMPORT JSON: decode failed", "fingerprint", fp, "error", err)
		jsonError(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	slog.Info("IMPORT JSON: importing entries", "fingerprint", fp, "total", len(entries))

	var count int
	var overwritten int
	var errors []map[string]interface{}

	for _, e := range entries {
		// Check if entry already exists (for overwrite count)
		existing, err := s.Q.GetEntry(r.Context(), dbgen.GetEntryParams{
			Fingerprint: fp,
			Path:        e.Path,
		})
		if err == nil && existing.Path != "" {
			overwritten++
		}

		// Convert content to bytes (support multiple formats)
		content, err := parseImportContent(e.Content)
		if err != nil {
			slog.Error("IMPORT JSON: content parse failed", "fingerprint", fp, "path", e.Path, "error", err)
			errors = append(errors, map[string]interface{}{
				"path":  e.Path,
				"error": "Invalid content format: " + err.Error(),
			})
			continue
		}

		if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        e.Path,
			Content:     content,
		}); err != nil {
			slog.Error("IMPORT JSON: upsert failed", "fingerprint", fp, "path", e.Path, "error", err)
			errors = append(errors, map[string]interface{}{
				"path":  e.Path,
				"error": err.Error(),
			})
		} else {
			count++
		}
	}

	slog.Info("IMPORT JSON: completed", "fingerprint", fp, "imported", count, "overwritten", overwritten, "errors", len(errors))

	// Return partial success (always 200, even with errors)
	jsonOK(w, map[string]interface{}{
		"imported":    count,
		"overwritten": overwritten,
		"errors":      errors,
	})
}

// parseImportContent converts import content from various formats to bytes
// Supports:
// - Base64 string (preferred)
// - Armored PGP text (-----BEGIN PGP MESSAGE-----)
// - Raw bytes
func parseImportContent(content any) ([]byte, error) {
	switch v := content.(type) {
	case string:
		// Check if it's armored PGP
		if strings.HasPrefix(v, "-----BEGIN PGP MESSAGE-----") {
			// Armored PGP text - decode from base64 internally
			// Remove armor headers and footers
			lines := strings.Split(v, "\n")
			var base64Lines []string
			inBody := false
			for _, line := range lines {
				if strings.HasPrefix(line, "-----BEGIN") || strings.HasPrefix(line, "-----END") {
					inBody = true
					continue
				}
				if inBody && line != "" {
					base64Lines = append(base64Lines, line)
				}
			}
			base64Data := strings.Join(base64Lines, "")
			return base64.StdEncoding.DecodeString(base64Data)
		}
		// Assume it's base64-encoded binary
		return base64.StdEncoding.DecodeString(v)
	case []byte:
		// Raw bytes - return as-is
		return v, nil
	default:
		return nil, fmt.Errorf("unsupported content type: %T", content)
	}
}

// handleImportTarGz handles legacy tar.gz import (original behavior)
func (s *Server) handleImportTarGz(w http.ResponseWriter, r *http.Request, fp string) {
	gr, err := gzip.NewReader(r.Body)
	if err != nil {
		slog.Error("IMPORT TAR.GZ: gzip decode failed", "fingerprint", fp, "error", err)
		jsonError(w, "invalid gzip: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer func() { _ = gr.Close() }()

	slog.Info("IMPORT TAR.GZ: importing", "fingerprint", fp)

	tr := tar.NewReader(gr)
	var count int
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			slog.Error("IMPORT TAR.GZ: tar read failed", "fingerprint", fp, "error", err)
			jsonError(w, "invalid tar", http.StatusBadRequest)
			return
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}

		// Strip .gpg suffix if present
		path := hdr.Name
		path = strings.TrimSuffix(path, ".gpg")
		path = strings.TrimPrefix(path, "./")
		path = strings.TrimPrefix(path, "/")
		if path == "" {
			continue
		}

		content, err := io.ReadAll(io.LimitReader(tr, 1<<20))
		if err != nil {
			slog.Error("IMPORT TAR.GZ: read entry failed", "fingerprint", fp, "path", path, "error", err)
			jsonError(w, "read entry failed", http.StatusBadRequest)
			return
		}

		if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        path,
			Content:     content,
		}); err != nil {
			slog.Error("IMPORT TAR.GZ: upsert failed", "fingerprint", fp, "path", path, "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		count++
	}

	slog.Info("IMPORT TAR.GZ: completed", "fingerprint", fp, "imported", count)
	jsonOK(w, map[string]int{"imported": count})
}

// ---------------------------------------------------------------------------
// Git Sync Handlers
// ---------------------------------------------------------------------------

// GET /api/{fingerprint}/git/status — get git sync status
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	status, err := s.GitService.GetStatus(r.Context(), fp)
	if err != nil {
		slog.Error("get git status", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, status)
}

// GET /api/{fingerprint}/git/config — get git config (including encrypted_pat)
func (s *Server) handleGitGetConfig(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	config, err := s.Q.GetGitConfig(r.Context(), fp)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonOK(w, map[string]interface{}{
				"configured":        false,
				"repo_url":          "",
				"branch":            "HEAD",
				"encrypted_pat":     "",
				"has_encrypted_pat": false,
			})
			return
		}
		slog.Error("get git config", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"configured":        true,
		"repo_url":          config.RepoUrl,
		"branch":            config.Branch,
		"encrypted_pat":     config.EncryptedPat,
		"has_encrypted_pat": config.EncryptedPat != "",
	})
}

// POST /api/{fingerprint}/git/config — configure git sync
func (s *Server) handleGitConfig(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		RepoURL      string `json:"repo_url"`
		EncryptedPAT string `json:"encrypted_pat"`
		Branch       string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.RepoURL == "" {
		jsonError(w, "repo_url required", http.StatusBadRequest)
		return
	}

	// Default branch to HEAD if not specified
	branch := body.Branch
	if branch == "" {
		branch = "HEAD"
	}

	if err := s.GitService.Configure(r.Context(), fp, body.RepoURL, body.EncryptedPAT, branch); err != nil {
		slog.Error("GIT CONFIG: failed", "fingerprint", fp, "error", err)
		jsonError(w, "config failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	slog.Info("GIT CONFIG: successfully configured", "fingerprint", fp, "repo", body.RepoURL, "branch", branch)
	jsonOK(w, map[string]string{"status": "configured"})
}

// POST /api/{fingerprint}/git/session — set session token (called after login)
func (s *Server) handleGitSession(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.Token == "" {
		jsonError(w, "token required", http.StatusBadRequest)
		return
	}

	s.GitService.SetSessionToken(fp, body.Token)
	jsonOK(w, map[string]string{"status": "ok"})
}

// POST /api/{fingerprint}/git/push — push to remote
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	// Try to get token from session cache
	token := body.Token
	if token == "" {
		token, _ = s.GitService.getSessionToken(fp)
	}

	if token == "" {
		jsonError(w, "git token required (provide in request or login first)", http.StatusBadRequest)
		return
	}

	result, err := s.GitService.Push(r.Context(), fp, token)
	if err != nil {
		slog.Error("git push", "error", err)
		jsonError(w, "push failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, result)
}

// POST /api/{fingerprint}/git/pull — pull from remote
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	// Try to get token from session cache
	token := body.Token
	if token == "" {
		token, _ = s.GitService.getSessionToken(fp)
	}

	if token == "" {
		jsonError(w, "git token required (provide in request or login first)", http.StatusBadRequest)
		return
	}

	result, err := s.GitService.Pull(r.Context(), fp, token)
	if err != nil {
		slog.Error("git pull", "error", err)
		jsonError(w, "pull failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, result)
}

// POST /api/{fingerprint}/git/toggle-sync — deprecated, kept for compatibility
func (s *Server) handleGitToggleSync(w http.ResponseWriter, r *http.Request) {
	// This endpoint is deprecated - manual sync only
	jsonOK(w, map[string]string{"status": "deprecated", "message": "manual sync only"})
}

// GET /api/{fingerprint}/git/log — get sync log
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	logs, err := s.Q.ListGitSyncLog(r.Context(), fp)
	if err != nil {
		slog.Error("get git log", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	type logEntry struct {
		ID             int64     `json:"id"`
		Operation      string    `json:"operation"`
		Status         string    `json:"status"`
		Message        string    `json:"message"`
		EntriesChanged int64     `json:"entries_changed"`
		CreatedAt      time.Time `json:"created_at"`
	}

	entries := make([]logEntry, len(logs))
	for i, log := range logs {
		msg := ""
		if log.Message != nil {
			msg = *log.Message
		}
		entriesChanged := int64(0)
		if log.EntriesChanged != nil {
			entriesChanged = *log.EntriesChanged
		}
		entries[i] = logEntry{
			ID:             log.ID,
			Operation:      log.Operation,
			Status:         log.Status,
			Message:        msg,
			EntriesChanged: entriesChanged,
			CreatedAt:      log.CreatedAt,
		}
	}

	jsonOK(w, map[string]any{"logs": entries})
}
