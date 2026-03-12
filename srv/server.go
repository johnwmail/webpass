package srv

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
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
	DB         *sql.DB
	Q          *dbgen.Queries
	JWTKey     []byte
	StaticDir  string // path to frontend dist/ directory (optional)
	GitService *GitService
}

// New creates a new Server, opening the database and running migrations.
func New(dbPath string, jwtKey []byte) (*Server, error) {
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
	mux.HandleFunc("POST /api/users", s.handleCreateUser)
	mux.HandleFunc("POST /api/users/{fp}/login", s.handleLogin)
	mux.HandleFunc("POST /api/users/{fp}/login/2fa", s.handleLogin2FA)

	// Authenticated routes
	mux.HandleFunc("POST /api/users/{fp}/totp/setup", s.requireAuth(s.handleTOTPSetup))
	mux.HandleFunc("POST /api/users/{fp}/totp/confirm", s.requireAuth(s.handleTOTPConfirm))
	mux.HandleFunc("GET /api/users/{fp}/entries", s.requireAuth(s.handleListEntries))
	mux.HandleFunc("POST /api/users/{fp}/entries/move", s.requireAuth(s.handleMoveEntry))
	mux.HandleFunc("GET /api/users/{fp}/export", s.requireAuth(s.handleExport))
	mux.HandleFunc("POST /api/users/{fp}/import", s.requireAuth(s.handleImport))
	// Git sync routes
	mux.HandleFunc("GET /api/users/{fp}/git/status", s.requireAuth(s.handleGitStatus))
	mux.HandleFunc("POST /api/users/{fp}/git/config", s.requireAuth(s.handleGitConfig))
	mux.HandleFunc("POST /api/users/{fp}/git/session", s.requireAuth(s.handleGitSession))
	mux.HandleFunc("POST /api/users/{fp}/git/push", s.requireAuth(s.handleGitPush))
	mux.HandleFunc("POST /api/users/{fp}/git/pull", s.requireAuth(s.handleGitPull))
	mux.HandleFunc("POST /api/users/{fp}/git/toggle-sync", s.requireAuth(s.handleGitToggleSync))
	mux.HandleFunc("GET /api/users/{fp}/git/log", s.requireAuth(s.handleGitLog))
	// Wildcard entry routes — {path...} captures the rest
	mux.HandleFunc("GET /api/users/{fp}/entries/{path...}", s.requireAuth(s.handleGetEntry))
	mux.HandleFunc("PUT /api/users/{fp}/entries/{path...}", s.requireAuth(s.handlePutEntry))
	mux.HandleFunc("DELETE /api/users/{fp}/entries/{path...}", s.requireAuth(s.handleDeleteEntry))

	// Health check
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

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
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.JWTKey)
}

// requireAuth wraps a handler, verifying JWT and that the token fingerprint
// matches the {fp} path variable.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fp := r.PathValue("fp")
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
// POST /api/users — create user
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
// POST /api/users/{fp}/login — login
// ---------------------------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// POST /api/users/{fp}/login/2fa — complete 2FA login
// ---------------------------------------------------------------------------

func (s *Server) handleLogin2FA(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// POST /api/users/{fp}/totp/setup — begin TOTP setup
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// POST /api/users/{fp}/totp/confirm — confirm TOTP setup
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// GET /api/users/{fp}/entries — list entries
// ---------------------------------------------------------------------------

func (s *Server) handleListEntries(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// GET /api/users/{fp}/entries/{path...} — get entry blob
// ---------------------------------------------------------------------------

func (s *Server) handleGetEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// PUT /api/users/{fp}/entries/{path...} — create/update entry
// ---------------------------------------------------------------------------

func (s *Server) handlePutEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// DELETE /api/users/{fp}/entries/{path...} — delete entry
// ---------------------------------------------------------------------------

func (s *Server) handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// POST /api/users/{fp}/entries/move — move/rename entry
// ---------------------------------------------------------------------------

func (s *Server) handleMoveEntry(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
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
// GET /api/users/{fp}/export — export all entries as tar.gz
// ---------------------------------------------------------------------------

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")
	entries, err := s.Q.ListEntriesContent(r.Context(), fp)
	if err != nil {
		slog.Error("export entries", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

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
			slog.Error("tar write header", "error", err)
			return
		}
		if _, err := tw.Write(e.Content); err != nil {
			slog.Error("tar write content", "error", err)
			return
		}
	}
}

// ---------------------------------------------------------------------------
// POST /api/users/{fp}/import — import tar.gz
// ---------------------------------------------------------------------------

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

	gr, err := gzip.NewReader(r.Body)
	if err != nil {
		jsonError(w, "invalid gzip", http.StatusBadRequest)
		return
	}
	defer func() { _ = gr.Close() }()

	tr := tar.NewReader(gr)
	var count int
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
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
			jsonError(w, "read entry failed", http.StatusBadRequest)
			return
		}

		if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        path,
			Content:     content,
		}); err != nil {
			slog.Error("import upsert", "error", err, "path", path)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		count++
	}

	jsonOK(w, map[string]int{"imported": count})
}

// ---------------------------------------------------------------------------
// Git Sync Handlers
// ---------------------------------------------------------------------------

// GET /api/users/{fp}/git/status — get git sync status
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

	status, err := s.GitService.GetStatus(r.Context(), fp)
	if err != nil {
		slog.Error("get git status", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, status)
}

// POST /api/users/{fp}/git/config — configure git sync
func (s *Server) handleGitConfig(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

	var body struct {
		RepoURL      string `json:"repo_url"`
		EncryptedPAT string `json:"encrypted_pat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.RepoURL == "" {
		jsonError(w, "repo_url required", http.StatusBadRequest)
		return
	}

	if err := s.GitService.Configure(r.Context(), fp, body.RepoURL, body.EncryptedPAT); err != nil {
		slog.Error("configure git", "error", err)
		jsonError(w, "config failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"status": "configured"})
}

// POST /api/users/{fp}/git/session — set session token (called after login)
func (s *Server) handleGitSession(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

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

// POST /api/users/{fp}/git/push — push to remote
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

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

// POST /api/users/{fp}/git/pull — pull from remote
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

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

// POST /api/users/{fp}/git/toggle-sync — deprecated, kept for compatibility
func (s *Server) handleGitToggleSync(w http.ResponseWriter, r *http.Request) {
	// This endpoint is deprecated - manual sync only
	jsonOK(w, map[string]string{"status": "deprecated", "message": "manual sync only"})
}

// GET /api/users/{fp}/git/log — get sync log
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fp")

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
		if log.Message.Valid {
			msg = log.Message.String
		}
		entries[i] = logEntry{
			ID:             log.ID,
			Operation:      log.Operation,
			Status:         log.Status,
			Message:        msg,
			EntriesChanged: log.EntriesChanged,
			CreatedAt:      log.CreatedAt,
		}
	}

	jsonOK(w, map[string]any{"logs": entries})
}
