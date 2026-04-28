package srv

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"strconv"
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
	DB           *sql.DB
	Q            *dbgen.Queries
	JWTKey       []byte
	StaticDir    string // path to frontend dist/ directory (optional)
	GitService   *GitService
	Registration *RegistrationService
	RateLimiter  *RateLimiter  // rate limiter for auth endpoints
	hardLimit    time.Duration // hard limit (max session time)
	softLimit    time.Duration // soft limit (browser closed detection)
	cookieAuth   bool          // whether to use httpOnly cookies instead of localStorage
	cookieSecure bool          // whether to set Secure flag on cookies
	cookieDomain string        // optional cookie domain
	bcryptCost   int           // bcrypt cost factor for password hashing
	// Version info (set from main package)
	Version   string
	BuildTime string
	Commit    string
}

// CloseDB closes the database connection for graceful shutdown.
func (s *Server) CloseDB() error {
	if s.DB != nil {
		return s.DB.Close()
	}
	return nil
}

// New creates a new Server, opening the database and running migrations.
func New(dbPath string, jwtKey []byte, hardLimitMin int, softLimitMin int) (*Server, error) {
	wdb, err := db.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if err := db.RunMigrations(wdb); err != nil {
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	// Check if cookie-based auth is enabled (default: false for local dev without HTTPS)
	cookieAuthEnv := strings.TrimSpace(os.Getenv("COOKIE_AUTH_ENABLED"))
	cookieAuth := cookieAuthEnv == "1" || strings.EqualFold(cookieAuthEnv, "true")

	// Cookie Secure flag: set to true if running on HTTPS (check HTTPS environment or addr)
	cookieSecureEnv := strings.TrimSpace(os.Getenv("COOKIE_SECURE"))
	cookieSecure := cookieSecureEnv == "1" || strings.EqualFold(cookieSecureEnv, "true")

	// Cookie domain (optional)
	cookieDomain := strings.TrimSpace(os.Getenv("COOKIE_DOMAIN"))

	// Bcrypt cost factor for password hashing (default: 12, range: 10-15)
	bcryptCost := 12
	bcryptCostEnv := strings.TrimSpace(os.Getenv("BCRYPT_COST"))
	if bcryptCostEnv != "" {
		if val, err := strconv.Atoi(bcryptCostEnv); err == nil && val >= 10 && val <= 15 {
			bcryptCost = val
		} else {
			slog.Warn("Invalid BCRYPT_COST value, using default 12", "value", bcryptCostEnv)
		}
	}

	s := &Server{
		DB:           wdb,
		Q:            dbgen.New(wdb),
		JWTKey:       jwtKey,
		cookieAuth:   cookieAuth,
		cookieSecure: cookieSecure,
		cookieDomain: cookieDomain,
		bcryptCost:   bcryptCost,
	}
	s.hardLimit = time.Duration(hardLimitMin) * time.Minute
	s.softLimit = time.Duration(softLimitMin) * time.Minute

	// Initialize Git service
	repoRoot := os.Getenv("GIT_REPO_ROOT")
	if repoRoot == "" {
		repoRoot = "/data/git-repos"
	}
	if err := os.MkdirAll(repoRoot, 0700); err != nil {
		return nil, fmt.Errorf("create repo root: %w", err)
	}
	s.GitService = NewGitService(dbPath, dbgen.New(wdb), repoRoot)

	// Initialize Registration service
	s.Registration = NewRegistrationService()

	// Initialize Rate Limiter
	s.RateLimiter = NewRateLimiter()

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

	// Public routes (no rate limiting)
	mux.HandleFunc("GET /api/{fingerprint}", s.handleGetUser)
	mux.HandleFunc("GET /api/registration/mode", s.handleGetRegistrationMode)
	mux.HandleFunc("POST /api/registration/validate", s.handleValidateRegistrationCode)

	// Rate-limited routes (authentication endpoints)
	mux.HandleFunc("POST /api", s.rateLimitMiddleware(s.handleCreateUser))
	mux.HandleFunc("POST /api/{fingerprint}/login", s.rateLimitMiddleware(s.handleLogin))
	mux.HandleFunc("POST /api/{fingerprint}/login/2fa", s.rateLimitMiddleware(s.handleLogin2FA))
	mux.HandleFunc("POST /api/logout", s.handleLogout)

	// Authenticated routes (no rate limiting - already protected by JWT)
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

	// Apply middleware chain: CORS -> Security Headers -> CSRF -> Router
	handler := http.Handler(mux)
	handler = s.csrfMiddleware(handler)
	handler = securityHeadersMiddleware(handler)
	handler = s.corsMiddleware(handler)
	return handler
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
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
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

// ---------------------------------------------------------------------------
// Security Headers
// ---------------------------------------------------------------------------

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prevent MIME type sniffing
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Prevent clickjacking
		w.Header().Set("X-Frame-Options", "DENY")
		// Control referrer information
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// Content Security Policy - restrict resource loading
		// Note: worker-src must include 'self' and blob: for OpenPGP.js web workers
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		// Prevent browsers from applying XSS filtering
		w.Header().Set("X-XSS-Protection", "0")
		// Permissions Policy - restrict browser features
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// CSRF Protection
// ---------------------------------------------------------------------------

// csrfTokenHeader is the header the client sends with the CSRF token
const csrfTokenHeader = "X-CSRF-Token"

// csrfTokenCookie is the name of the cookie holding the CSRF token
const csrfTokenCookie = "webpass_csrf"

// generateCSRFToken creates a random CSRF token
func generateCSRFToken() string {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic("csrf token generation failed: " + err.Error())
	}
	return base64.StdEncoding.EncodeToString(b)
}

// csrfMiddleware issues a CSRF token via cookie on GET requests and validates it on state-changing requests
func (s *Server) csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip CSRF for safe methods (GET, HEAD, OPTIONS)
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			// Issue CSRF token if not already present
			_, err := r.Cookie(csrfTokenCookie)
			if err != nil {
				token := generateCSRFToken()
				cookie := &http.Cookie{
					Name:     csrfTokenCookie,
					Value:    token,
					Path:     "/",   // Must match frontend app path so document.cookie can read it
					HttpOnly: false, // Must be readable by JavaScript
					Secure:   s.cookieSecure,
					SameSite: http.SameSiteStrictMode,
					Domain:   s.cookieDomain,
					MaxAge:   int(s.hardLimit.Seconds()),
				}
				http.SetCookie(w, cookie)
			}
			next.ServeHTTP(w, r)
			return
		}

		// Paths exempt from CSRF validation (authentication endpoints where user isn't logged in yet)
		path := r.URL.Path
		if path == "/api" || // POST /api (create user)
			path == "/api/logout" || // POST /api/logout
			path == "/api/registration/validate" || // POST /api/registration/validate
			strings.HasSuffix(path, "/login") || // POST /api/{fingerprint}/login
			strings.HasSuffix(path, "/login/2fa") { // POST /api/{fingerprint}/login/2fa
			next.ServeHTTP(w, r)
			return
		}

		// For state-changing requests (POST, PUT, DELETE, PATCH), validate CSRF token
		token := r.Header.Get(csrfTokenHeader)
		if token == "" {
			// Also check form parameter as fallback
			token = r.FormValue("csrf_token")
		}
		if token == "" {
			slog.Warn("CSRF validation failed: missing CSRF token",
				"method", r.Method,
				"path", r.URL.Path,
				"remote_addr", r.RemoteAddr,
			)
			jsonError(w, "missing csrf token", http.StatusForbidden)
			return
		}

		cookie, err := r.Cookie(csrfTokenCookie)
		if err != nil {
			slog.Warn("CSRF validation failed: missing CSRF cookie",
				"method", r.Method,
				"path", r.URL.Path,
				"remote_addr", r.RemoteAddr,
			)
			jsonError(w, "missing csrf cookie", http.StatusForbidden)
			return
		}

		if !compareTokenSecure(token, cookie.Value) {
			slog.Warn("CSRF validation failed: invalid CSRF token",
				"method", r.Method,
				"path", r.URL.Path,
				"remote_addr", r.RemoteAddr,
			)
			jsonError(w, "invalid csrf token", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// compareTokenSecure performs constant-time comparison to prevent timing attacks
func compareTokenSecure(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
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
		"exp": time.Now().Add(s.hardLimit).Unix(),
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

		// Check session limits (hard limit and soft limit)
		if err := s.checkSessionLimits(r.Context(), fp); err != nil {
			slog.Warn("session limit check failed", "fingerprint", fp, "error", err)
			jsonError(w, err.Error(), http.StatusUnauthorized)
			return
		}

		// Update last activity timestamp
		if err := s.Q.UpdateLastActivity(r.Context(), fp); err != nil {
			slog.Error("update last activity", "error", err)
		}

		next(w, r)
	}
}

// rateLimitMiddleware wraps a handler, checking rate limits before processing.
// It extracts the key (fingerprint or IP) and checks if the request is allowed.
func (s *Server) rateLimitMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract key: prefer fingerprint from path, fallback to IP
		key := r.PathValue("fingerprint")
		if key == "" {
			// Fallback to IP address if no fingerprint in path
			key = getClientIP(r)
		}

		if !s.RateLimiter.Allow(key) {
			// Rate limiter already logs the rejection with details
			http.Error(w, "too many attempts, please try again later", http.StatusTooManyRequests)
			return
		}

		next(w, r)
	}
}

// getClientIP extracts the client IP address from the request.
// It checks X-Forwarded-For and X-Real-IP headers first, then falls back to RemoteAddr.
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header (for reverse proxy setups)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP in the list
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}

	// Check X-Real-IP header
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}

	// Fallback to RemoteAddr (may include port)
	ip := r.RemoteAddr
	// Remove port if present
	if colonIdx := strings.LastIndex(ip, ":"); colonIdx != -1 {
		ip = ip[:colonIdx]
	}
	return ip
}

func (s *Server) verifyToken(r *http.Request) (string, error) {
	// Try cookie first (when cookie auth is enabled)
	if s.cookieAuth {
		cookie, err := r.Cookie("webpass_auth")
		if err == nil && cookie.Value != "" {
			tokenStr := cookie.Value
			token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method")
				}
				return s.JWTKey, nil
			})
			if err == nil && token.Valid {
				claims, ok := token.Claims.(jwt.MapClaims)
				if ok {
					fp, ok := claims["fp"].(string)
					if ok {
						return fp, nil
					}
				}
			}
		}
		return "", fmt.Errorf("missing auth cookie")
	}

	// Fallback to Authorization header (when cookie auth is disabled)
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

// checkSessionLimits verifies the session hasn't exceeded hard or soft limits.
// Hard limit: sessionDuration (e.g., 30 min) from login_time
// Soft limit: softLimit (5 min) from last_activity (browser close detection)
func (s *Server) checkSessionLimits(ctx context.Context, fp string) error {
	sessionInfo, err := s.Q.GetSessionInfo(ctx, fp)
	if err != nil {
		// If user doesn't exist, don't block - let the handler decide
		return nil
	}

	now := time.Now()

	// If no login_time, this is a new session - allow access (will be set on login)
	if sessionInfo.LoginTime == nil {
		return nil
	}

	// Check hard limit: session must not exceed sessionDuration from login_time
	hardExpiry := sessionInfo.LoginTime.Add(s.hardLimit)
	if now.After(hardExpiry) {
		return fmt.Errorf("session expired (hard limit)")
	}

	// Check soft limit: must not be away for more than softLimit from last_activity
	// Only check if last_activity exists and is not too old
	if sessionInfo.LastActivity != nil {
		softExpiry := sessionInfo.LastActivity.Add(s.softLimit)
		if now.After(softExpiry) {
			return fmt.Errorf("session expired (please login again)")
		}
	}

	return nil
}

// setAuthCookie sets the httpOnly authentication cookie
func (s *Server) setAuthCookie(w http.ResponseWriter, token string) {
	if !s.cookieAuth {
		return
	}

	cookie := &http.Cookie{
		Name:     "webpass_auth",
		Value:    token,
		Path:     "/api",
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteStrictMode,
		Domain:   s.cookieDomain,
		MaxAge:   int(s.hardLimit.Seconds()),
	}
	http.SetCookie(w, cookie)
}

// clearAuthCookie clears the authentication cookie
func (s *Server) clearAuthCookie(w http.ResponseWriter) {
	cookie := &http.Cookie{
		Name:     "webpass_auth",
		Value:    "",
		Path:     "/api",
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteStrictMode,
		Domain:   s.cookieDomain,
		MaxAge:   -1, // Delete immediately
	}
	http.SetCookie(w, cookie)
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonAPIErr(w http.ResponseWriter, err APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.StatusCode())
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Message, "code": string(err.Code)})
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
	// Determine registration mode for logging
	mode := "open"
	if s.Registration != nil {
		if !s.Registration.IsEnabled() {
			mode = "disabled"
		} else if s.Registration.IsProtected() {
			mode = "protected"
		}
	}

	// Check if registration is enabled
	if s.Registration != nil && !s.Registration.IsEnabled() {
		jsonError(w, "registration is disabled", http.StatusForbidden)
		return
	}

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

	// If registration is protected (TOTP secret set), validate registration code
	if s.Registration != nil && s.Registration.IsProtected() {
		code := r.Header.Get("X-Registration-Code")
		if code == "" {
			slog.Warn("registration rejected: code missing", "fingerprint", body.Fingerprint)
			jsonError(w, "registration code required", http.StatusUnauthorized)
			return
		}
		if !s.Registration.ValidateCode(code) {
			slog.Warn("registration rejected: invalid code", "fingerprint", body.Fingerprint)
			jsonError(w, "invalid or expired registration code", http.StatusUnauthorized)
			return
		}
	}

	fp := body.Fingerprint
	if fp == "" {
		fp = fingerprintFromKey(body.PublicKey)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), s.bcryptCost)
	if err != nil {
		slog.Error("bcrypt hash", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := s.Q.CreateUser(r.Context(), dbgen.CreateUserParams{
		Fingerprint:  fp,
		PasswordHash: string(hash),
		PublicKey:    body.PublicKey,
		GpgID:        &fp,
	}); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			jsonError(w, "user already exists", http.StatusConflict)
			return
		}
		slog.Error("create user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Log successful registration with mode
	slog.Info("registration: new account created", "mode", mode, "fingerprint", fp)

	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"fingerprint": fp})
}

// ---------------------------------------------------------------------------
// GET /api/{fingerprint} — check if user exists
// ---------------------------------------------------------------------------

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if fp == "" {
		jsonError(w, "fingerprint required", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		if err == sql.ErrNoRows {
			jsonError(w, "user not found", http.StatusNotFound)
			return
		}
		slog.Error("get user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{
		"exists":      "true",
		"public_key":  user.PublicKey,
		"fingerprint": user.Fingerprint,
	})
}

// ---------------------------------------------------------------------------
// GET /api/registration/mode — get registration mode
// ---------------------------------------------------------------------------

func (s *Server) handleGetRegistrationMode(w http.ResponseWriter, r *http.Request) {
	var mode string
	if s.Registration == nil || !s.Registration.IsEnabled() {
		mode = "disabled"
	} else if s.Registration.IsProtected() {
		mode = "protected"
	} else {
		mode = "open"
	}
	jsonOK(w, map[string]string{"mode": mode})
}

// ---------------------------------------------------------------------------
// POST /api/registration/validate — validate registration code
// ---------------------------------------------------------------------------

func (s *Server) handleValidateRegistrationCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	// If registration is not protected, code validation is not needed
	if s.Registration == nil || !s.Registration.IsProtected() {
		jsonOK(w, map[string]bool{"valid": true})
		return
	}

	// Validate the code
	if body.Code == "" {
		slog.Warn("registration validation rejected: code missing")
		jsonError(w, "registration code required", http.StatusUnauthorized)
		return
	}

	if !s.Registration.ValidateCode(body.Code) {
		slog.Warn("registration validation rejected: invalid code")
		jsonError(w, "invalid or expired registration code", http.StatusUnauthorized)
		return
	}

	// Code is valid
	slog.Debug("registration code validated successfully")
	jsonOK(w, map[string]bool{"valid": true})
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

	// Update login_time on successful login
	if err := s.Q.UpdateLoginTime(r.Context(), fp); err != nil {
		slog.Error("update login time", "error", err)
	}

	token, err := s.createToken(fp)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Set httpOnly cookie
	s.setAuthCookie(w, token)

	// Return token in response for backward compatibility (client can ignore)
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

	// Update login_time on successful 2FA login
	if err := s.Q.UpdateLoginTime(r.Context(), fp); err != nil {
		slog.Error("update login time", "error", err)
	}

	token, err := s.createToken(fp)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Set httpOnly cookie
	s.setAuthCookie(w, token)

	// Return token in response for backward compatibility (client can ignore)
	jsonOK(w, map[string]string{"token": token})
}

// ---------------------------------------------------------------------------
// POST /api/logout — clear auth cookie
// ---------------------------------------------------------------------------

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.clearAuthCookie(w)
	jsonOK(w, map[string]string{"status": "logged out"})
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
// Path validation
// ---------------------------------------------------------------------------

// validateEntryPath validates and cleans an entry path.
// It rejects path traversal (..), null bytes, absolute paths, and empty segments.
func validateEntryPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path is required")
	}

	// Reject null bytes
	if strings.ContainsRune(path, '\x00') {
		return "", fmt.Errorf("invalid characters in path")
	}

	// Reject path traversal
	if strings.Contains(path, "..") {
		return "", fmt.Errorf("path traversal not allowed")
	}

	// Reject absolute paths
	if strings.HasPrefix(path, "/") {
		return "", fmt.Errorf("absolute paths not allowed")
	}

	// Clean and validate structure
	cleaned := filepath.Clean(path)
	if cleaned == "." || cleaned == "/" {
		return "", fmt.Errorf("invalid path")
	}

	// Validate path segments
	segments := strings.Split(cleaned, "/")
	for _, seg := range segments {
		if seg == "" {
			return "", fmt.Errorf("empty path segment")
		}
		// Reject control characters
		for _, c := range seg {
			if c < 32 || c == 127 {
				return "", fmt.Errorf("invalid characters in path")
			}
		}
	}

	return cleaned, nil
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

	cleanPath, err := validateEntryPath(path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	entry, err := s.Q.GetEntry(r.Context(), dbgen.GetEntryParams{
		Fingerprint: fp,
		Path:        cleanPath,
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

	cleanPath, err := validateEntryPath(path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
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
		Path:        cleanPath,
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

	cleanPath, err := validateEntryPath(path)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.Q.DeleteEntry(r.Context(), dbgen.DeleteEntryParams{
		Fingerprint: fp,
		Path:        cleanPath,
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
	newHash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), s.bcryptCost)
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

	cleanFrom, err := validateEntryPath(body.From)
	if err != nil {
		jsonError(w, "invalid from path: "+err.Error(), http.StatusBadRequest)
		return
	}

	cleanTo, err := validateEntryPath(body.To)
	if err != nil {
		jsonError(w, "invalid to path: "+err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.Q.MoveEntry(r.Context(), dbgen.MoveEntryParams{
		Path:        cleanTo,
		Fingerprint: fp,
		Path_2:      cleanFrom,
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
