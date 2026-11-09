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
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/golang-jwt/jwt/v5"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"github.com/johnwmail/webpass/db"
	"github.com/johnwmail/webpass/db/dbgen"
)

// Server is the WebPass API server.
type Server struct {
	DB           *sql.DB
	Q            *dbgen.Queries
	JWTKey       []byte
	StaticDir    string // path to an on-disk frontend dist/ directory (optional)
	StaticFS     fs.FS  // embedded frontend filesystem (optional; preferred over StaticDir)
	GitService   *GitService
	Registration *RegistrationService
	RateLimiter  *RateLimiter       // rate limiter for auth endpoints
	hardLimit    time.Duration      // hard limit (max session time)
	softLimit    time.Duration      // soft limit (browser closed detection)
	cookieAuth   bool               // whether to use httpOnly cookies instead of localStorage
	cookieSecure bool               // whether to set Secure flag on cookies
	cookieDomain string             // optional cookie domain
	bcryptCost   int                // bcrypt cost factor for password hashing
	maxBodyBytes int64              // maximum accepted request body size in bytes
	Secrets      *SecretBox         // encrypts secrets stored at rest (TOTP)
	WebAuthn     *webauthn.WebAuthn // passkey relying party (nil when disabled)
	dummyHash    []byte             // bcrypt hash used for timing-equalised login failures
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

	// Maximum request body size (default: 8 MiB, range: 1 MiB - 64 MiB)
	const (
		defaultMaxBodyBytes = int64(8 << 20)
		minMaxBodyBytes     = int64(1 << 20)
		maxMaxBodyBytes     = int64(64 << 20)
	)
	maxBodyBytes := defaultMaxBodyBytes
	if raw := strings.TrimSpace(os.Getenv("MAX_REQUEST_BODY_BYTES")); raw != "" {
		if val, err := strconv.ParseInt(raw, 10, 64); err == nil && val >= minMaxBodyBytes && val <= maxMaxBodyBytes {
			maxBodyBytes = val
		} else {
			slog.Warn("Invalid MAX_REQUEST_BODY_BYTES value, using default 8 MiB", "value", raw)
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
		maxBodyBytes: maxBodyBytes,
	}

	secrets, err := loadSecretBox(dbPath, jwtKey)
	if err != nil {
		_ = wdb.Close()
		return nil, fmt.Errorf("load data encryption key: %w", err)
	}
	s.Secrets = secrets

	// Precompute a hash so logins for unknown users still perform a bcrypt
	// comparison, preventing timing-based account enumeration.
	dummyHash, err := bcrypt.GenerateFromPassword([]byte("webpass-dummy-password"), bcryptCost)
	if err != nil {
		_ = wdb.Close()
		return nil, fmt.Errorf("generate dummy password hash: %w", err)
	}
	s.dummyHash = dummyHash

	wa, err := newWebAuthn()
	if err != nil {
		_ = wdb.Close()
		return nil, err
	}
	s.WebAuthn = wa
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
	s.GitService = NewGitService(dbPath, wdb, s.Q, repoRoot)

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
	mux.HandleFunc("POST /api/registration/validate", s.rateLimitMiddleware(s.handleValidateRegistrationCode))

	// Rate-limited routes (authentication endpoints)
	mux.HandleFunc("POST /api", s.rateLimitMiddleware(s.handleCreateUser))
	mux.HandleFunc("POST /api/{fingerprint}/login", s.rateLimitMiddleware(s.handleLogin))
	mux.HandleFunc("POST /api/{fingerprint}/login/2fa", s.rateLimitMiddleware(s.handleLogin2FA))
	mux.HandleFunc("POST /api/{fingerprint}/login/webauthn/begin", s.rateLimitMiddleware(s.handleLoginWebAuthnBegin))
	mux.HandleFunc("POST /api/{fingerprint}/login/webauthn/finish", s.rateLimitMiddleware(s.handleLoginWebAuthnFinish))
	mux.HandleFunc("POST /api/{fingerprint}/login/recovery", s.rateLimitMiddleware(s.handleLoginRecovery))
	mux.HandleFunc("POST /api/logout", s.handleLogout)

	// Authenticated routes (no rate limiting - already protected by JWT)
	mux.HandleFunc("POST /api/{fingerprint}/totp/setup", s.requireAuth(s.handleTOTPSetup))
	mux.HandleFunc("POST /api/{fingerprint}/totp/confirm", s.requireAuth(s.handleTOTPConfirm))
	mux.HandleFunc("POST /api/{fingerprint}/webauthn/register/begin", s.requireAuth(s.handleWebAuthnRegisterBegin))
	mux.HandleFunc("POST /api/{fingerprint}/webauthn/register/finish", s.requireAuth(s.handleWebAuthnRegisterFinish))
	mux.HandleFunc("GET /api/{fingerprint}/webauthn/credentials", s.requireAuth(s.handleListWebAuthnCredentials))
	mux.HandleFunc("DELETE /api/{fingerprint}/webauthn/credentials/{id}", s.requireAuth(s.handleDeleteWebAuthnCredential))
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
	// SSH known hosts routes
	mux.HandleFunc("POST /api/{fingerprint}/git/trust-hostkey", s.requireAuth(s.handleTrustHostKey))
	mux.HandleFunc("GET /api/{fingerprint}/git/trusted-hosts", s.requireAuth(s.handleListTrustedHosts))
	mux.HandleFunc("DELETE /api/{fingerprint}/git/trusted-hosts/{host}", s.requireAuth(s.handleDeleteTrustedHost))
	// Wildcard entry routes — {path...} captures the rest
	mux.HandleFunc("GET /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handleGetEntry))
	mux.HandleFunc("PUT /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handlePutEntry))
	mux.HandleFunc("DELETE /api/{fingerprint}/entries/{path...}", s.requireAuth(s.handleDeleteEntry))

	// Account deletion
	mux.HandleFunc("DELETE /api/{fingerprint}/account", s.requireAuth(s.handleDeleteAccount))

	// Password change
	mux.HandleFunc("POST /api/{fingerprint}/password", s.requireAuth(s.handleChangePassword))

	// Revoke all sessions (password/2FA changes also do this automatically)
	mux.HandleFunc("POST /api/{fingerprint}/sessions/revoke", s.requireAuth(s.handleRevokeSessions))

	// Security audit log
	mux.HandleFunc("GET /api/{fingerprint}/audit", s.requireAuth(s.handleAuditLog))

	// Health check
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Version info
	mux.HandleFunc("GET /api/version", s.handleVersion)

	// Serve frontend SPA if an embedded or on-disk filesystem is configured.
	// StaticFS (embedded assets) is used when set; otherwise StaticDir (an
	// on-disk override for local development and E2E tests) is used.
	staticFS := s.StaticFS
	if staticFS == nil && s.StaticDir != "" {
		staticFS = os.DirFS(s.StaticDir)
	}
	if staticFS != nil {
		fileServer := http.FileServerFS(staticFS)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
			if name == "" {
				name = "index.html"
			}
			if !fs.ValidPath(name) {
				http.NotFound(w, r)
				return
			}
			if _, err := fs.Stat(staticFS, name); err == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
			http.ServeFileFS(w, r, staticFS, "index.html")
		})
	}

	// Apply middleware chain: CORS -> Security Headers -> CSRF -> Router
	handler := http.Handler(mux)
	handler = s.csrfMiddleware(handler)
	handler = s.bodyLimitMiddleware(handler)
	handler = securityHeadersMiddleware(handler)
	handler = s.corsMiddleware(handler)
	handler = s.httpsRedirectMiddleware(handler)
	return handler
}

// ---------------------------------------------------------------------------
// HTTPS enforcement
// ---------------------------------------------------------------------------

// httpsRedirectMiddleware enforces HTTPS when REQUIRE_HTTPS=true. API requests
// receive a 403 (no redirect body), while browser navigation is redirected.
func (s *Server) httpsRedirectMiddleware(next http.Handler) http.Handler {
	if !envBool("REQUIRE_HTTPS") {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isHTTPSRequest(r) || isLocalRequestHost(r.Host) {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			jsonError(w, "https required", http.StatusForbidden)
			return
		}
		http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
}

func isLocalRequestHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	// CORS is deny-by-default: only origins explicitly listed in CORS_ORIGINS
	// may make cross-origin requests. An unset/empty value means same-origin
	// only (the SPA is normally served by this same server).
	allowed := parseCORSOrigins(os.Getenv("CORS_ORIGINS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			// Responses vary by Origin, so caches must key on it too.
			w.Header().Add("Vary", "Origin")
			if allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Registration-Code")
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
// Request body size limits
// ---------------------------------------------------------------------------

// bodyLimitMiddleware rejects oversized requests before any handler runs and
// caps chunked/unknown-length bodies with http.MaxBytesReader.
func (s *Server) bodyLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.maxBodyBytes > 0 {
			if r.ContentLength > s.maxBodyBytes {
				jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
				return
			}
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, s.maxBodyBytes)
			}
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
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		// Prevent browsers from applying XSS filtering
		w.Header().Set("X-XSS-Protection", "0")
		// Permissions Policy - restrict browser features
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-write=(self)")
		// Isolate the document from cross-origin windows/resources.
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		// Only enable HSTS on requests that actually arrived over HTTPS.
		if isHTTPSRequest(r) {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		// API responses contain tokens and encrypted blobs: never cache them.
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
		}

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
				// Path must match the frontend app path so document.cookie can read it;
				// HttpOnly must be false because the SPA echoes the token in a header.
				s.setCookie(w, r, s.newCookie(csrfTokenCookie, token, "/", false, int(s.hardLimit.Seconds())))
			}
			next.ServeHTTP(w, r)
			return
		}

		// Skip CSRF only in bearer-token mode. In cookie mode the browser
		// attaches credentials automatically, so the token must be validated
		// even if an Authorization header is also present.
		if !s.cookieAuth && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}

		// Paths exempt from CSRF validation (authentication endpoints where user isn't logged in yet)
		path := r.URL.Path
		if path == "/api" || // POST /api (create user)
			path == "/api/logout" || // POST /api/logout
			path == "/api/registration/validate" || // POST /api/registration/validate
			strings.HasSuffix(path, "/login") || // POST /api/{fingerprint}/login
			strings.HasSuffix(path, "/login/2fa") || // POST /api/{fingerprint}/login/2fa
			strings.HasSuffix(path, "/login/recovery") || // POST /api/{fingerprint}/login/recovery
			strings.HasSuffix(path, "/login/webauthn/begin") || // POST /api/{fingerprint}/login/webauthn/begin
			strings.HasSuffix(path, "/login/webauthn/finish") { // POST /api/{fingerprint}/login/webauthn/finish
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

const (
	tokenIssuer   = "webpass"
	tokenAudience = "webpass"
)

func (s *Server) createToken(fingerprint string, sessionVersion int64) (string, error) {
	now := time.Now()
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return "", fmt.Errorf("generate jti: %w", err)
	}
	claims := jwt.MapClaims{
		"fp":  fingerprint,
		"sv":  sessionVersion,
		"iss": tokenIssuer,
		"aud": tokenAudience,
		"iat": now.Unix(),
		"nbf": now.Unix(),
		"exp": now.Add(s.hardLimit).Unix(),
		"jti": hex.EncodeToString(jti),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.JWTKey)
}

// requireAuth wraps a handler, verifying JWT and that the token fingerprint
// matches the {fp} path variable.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fp := r.PathValue("fingerprint")
		tokenFP, tokenSV, err := s.verifyToken(r)
		if err != nil {
			jsonError(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if tokenFP != fp {
			jsonError(w, "forbidden", http.StatusForbidden)
			return
		}

		// Check session limits (hard limit, soft limit, and revocation)
		if err := s.checkSessionLimits(r.Context(), fp, tokenSV); err != nil {
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
// It enforces both a per-fingerprint and a per-IP budget: the fingerprint limit
// slows distributed password guessing against one account, while the IP limit
// protects registration and prevents a single source from spraying many users.
func (s *Server) rateLimitMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		scope := rateLimitScope(r.URL.Path)
		keys := make([]string, 0, 2)
		if fp := r.PathValue("fingerprint"); fp != "" {
			keys = append(keys, scope+":fp:"+fp)
		}
		keys = append(keys, scope+":ip:"+ip)

		for _, key := range keys {
			if !s.RateLimiter.Allow(key) {
				// Rate limiter already logs the rejection with details
				http.Error(w, "too many attempts, please try again later", http.StatusTooManyRequests)
				return
			}
		}

		next(w, r)
	}
}

// rateLimitScope partitions budgets so that e.g. registration attempts do not
// consume the login budget for the same IP address.
func rateLimitScope(path string) string {
	switch {
	case path == "/api":
		return "register"
	case strings.HasSuffix(path, "/login/2fa"):
		return "login2fa"
	case strings.HasSuffix(path, "/login/recovery"):
		return "recovery"
	case strings.HasSuffix(path, "/login/webauthn/begin"), strings.HasSuffix(path, "/login/webauthn/finish"):
		return "webauthn"
	case strings.HasSuffix(path, "/login"):
		return "login"
	case path == "/api/registration/validate":
		return "regvalidate"
	default:
		return "auth"
	}
}

// ipFromAddr extracts the IP from a "host:port" RemoteAddr, handling IPv6.
func ipFromAddr(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return strings.Trim(addr, "[]")
	}
	return host
}

// isTrustedProxy reports whether ip is listed in TRUSTED_PROXIES. Forwarded
// headers are only honored when the direct peer is a configured proxy.
func isTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	for _, raw := range strings.Split(os.Getenv("TRUSTED_PROXIES"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if strings.Contains(raw, "/") {
			if _, cidr, err := net.ParseCIDR(raw); err == nil && cidr.Contains(ip) {
				return true
			}
			continue
		}
		if proxy := net.ParseIP(raw); proxy != nil && proxy.Equal(ip) {
			return true
		}
	}
	return false
}

// getClientIP extracts the client IP address from the request.
//
// X-Forwarded-For / X-Real-IP are only trusted when the request comes from a
// proxy listed in TRUSTED_PROXIES; otherwise clients could spoof the header and
// bypass IP-based rate limiting.
func getClientIP(r *http.Request) string {
	remoteIP := ipFromAddr(r.RemoteAddr)
	if !isTrustedProxy(remoteIP) {
		return remoteIP
	}

	// Walk the chain right-to-left, skipping known proxies. The first address
	// that is not a trusted proxy is the real client.
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		ip := strings.TrimSpace(hops[i])
		if net.ParseIP(ip) == nil {
			continue
		}
		if i == 0 || !isTrustedProxy(ip) {
			return ip
		}
	}

	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(xri) != nil {
		return xri
	}
	return remoteIP
}

// parseToken validates a JWT and extracts the fingerprint and session version.
func (s *Server) parseToken(tokenStr string) (string, int64, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.JWTKey, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(tokenIssuer),
		jwt.WithAudience(tokenAudience),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return "", 0, err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return "", 0, fmt.Errorf("invalid token")
	}
	fp, ok := claims["fp"].(string)
	if !ok || fp == "" {
		return "", 0, fmt.Errorf("missing fp claim")
	}
	var sv int64
	if v, ok := claims["sv"].(float64); ok {
		sv = int64(v)
	}
	return fp, sv, nil
}

func (s *Server) verifyToken(r *http.Request) (string, int64, error) {
	// Try cookie first (when cookie auth is enabled)
	if s.cookieAuth {
		cookie, err := r.Cookie("webpass_auth")
		if err == nil && cookie.Value != "" {
			return s.parseToken(cookie.Value)
		}
		return "", 0, fmt.Errorf("missing auth cookie")
	}

	// Fallback to Authorization header (when cookie auth is disabled)
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", 0, fmt.Errorf("missing bearer token")
	}
	return s.parseToken(strings.TrimPrefix(auth, "Bearer "))
}

// checkSessionLimits verifies the session hasn't exceeded hard or soft limits,
// and that it has not been revoked via a session_version bump.
// Hard limit: sessionDuration (e.g., 30 min) from login_time
// Soft limit: softLimit (5 min) from last_activity (browser close detection)
func (s *Server) checkSessionLimits(ctx context.Context, fp string, tokenVersion int64) error {
	sessionInfo, err := s.Q.GetSessionInfo(ctx, fp)
	if err != nil {
		// If user doesn't exist, don't block - let the handler decide
		return nil
	}

	// A version mismatch means the token was issued before a password / 2FA
	// change or an explicit "log out everywhere".
	if tokenVersion != sessionInfo.SessionVersion {
		return fmt.Errorf("session revoked (please login again)")
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

// isHTTPSRequest reports whether the request reached us over HTTPS, either
// directly (TLS) or via a reverse proxy signalling X-Forwarded-Proto.
func isHTTPSRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// useSecureCookie reports whether cookies should carry the Secure flag.
// Explicit COOKIE_SECURE=true always wins; otherwise HTTPS is detected from
// the direct TLS connection or X-Forwarded-Proto (reverse proxy).
func (s *Server) useSecureCookie(r *http.Request) bool {
	if s.cookieSecure {
		return true
	}
	return isHTTPSRequest(r)
}

// newCookie builds a cookie with the shared attributes used by the server.
// Callers must write it with setCookie, which applies the Secure flag.
func (s *Server) newCookie(name, value, path string, httpOnly bool, maxAge int) http.Cookie {
	return http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		HttpOnly: httpOnly,
		SameSite: http.SameSiteStrictMode,
		Domain:   s.cookieDomain,
		MaxAge:   maxAge,
	}
}

// setCookie applies the Secure attribute (derived from the request) and writes
// the cookie. The attribute is assigned before writing so static analysis can
// verify it is never left at the insecure default.
func (s *Server) setCookie(w http.ResponseWriter, r *http.Request, cookie http.Cookie) {
	secure := s.useSecureCookie(r)
	cookie.Secure = secure
	http.SetCookie(w, &cookie)
}

// setAuthCookie sets the httpOnly authentication cookie
func (s *Server) setAuthCookie(w http.ResponseWriter, r *http.Request, token string) {
	if !s.cookieAuth {
		return
	}

	s.setCookie(w, r, s.newCookie("webpass_auth", token, "/api", true, int(s.hardLimit.Seconds())))
}

// clearAuthCookie clears the authentication cookie
func (s *Server) clearAuthCookie(w http.ResponseWriter, r *http.Request) {
	// MaxAge -1 deletes immediately.
	s.setCookie(w, r, s.newCookie("webpass_auth", "", "/api", true, -1))
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

// fingerprintPattern matches account identifiers accepted at registration.
// It allows PGP fingerprints (16-64 hex chars) as well as the shorter,
// human-readable IDs used by older clients, while excluding anything that
// could be interpreted as a path component or a traversal sequence.
var fingerprintPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// validateFingerprint rejects fingerprints that are unsafe to use as an
// account identifier. This is a security boundary: the fingerprint is later
// used as a directory name under GIT_REPO_ROOT.
func validateFingerprint(fp string) error {
	if !fingerprintPattern.MatchString(fp) {
		return fmt.Errorf("invalid fingerprint format")
	}
	// Reject traversal-like identifiers even though they match the charset.
	if strings.Contains(fp, "..") {
		return fmt.Errorf("invalid fingerprint format")
	}
	return nil
}

// validateRepoFingerprint is a stricter filesystem-safety check used on the
// git repo path. It intentionally accepts slightly more than
// validateFingerprint so that accounts created by older versions (which did
// not validate the fingerprint) keep working.
func validateRepoFingerprint(fp string) error {
	if fp == "" || fp == "." || fp == ".." {
		return fmt.Errorf("invalid fingerprint")
	}
	if strings.ContainsAny(fp, "/\\\x00") || strings.Contains(fp, "..") {
		return fmt.Errorf("invalid fingerprint")
	}
	if filepath.IsAbs(fp) {
		return fmt.Errorf("invalid fingerprint")
	}
	return nil
}

// validatePassword enforces the server-side password policy. bcrypt only uses
// the first 72 bytes, so longer inputs are rejected rather than silently
// truncated.
func validatePassword(pw string) error {
	if strings.TrimSpace(pw) == "" {
		return fmt.Errorf("password is required")
	}
	if len(pw) < minPasswordLength {
		return fmt.Errorf("password must be at least %d characters", minPasswordLength)
	}
	if len(pw) > maxPasswordLength {
		return fmt.Errorf("password must be at most %d bytes", maxPasswordLength)
	}
	return nil
}

const (
	minPasswordLength = 12
	maxPasswordLength = 72
)

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
	if err := validatePassword(body.Password); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
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
	if err := validateFingerprint(fp); err != nil {
		slog.Warn("registration rejected: invalid fingerprint", "fingerprint", fp)
		jsonError(w, "invalid fingerprint", http.StatusBadRequest)
		return
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
	s.audit(r, fp, "register", "mode="+mode)

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
		// Perform a dummy bcrypt comparison so unknown accounts take the same
		// time as wrong passwords (prevents timing-based enumeration).
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(body.Password))
		s.audit(r, fp, "login_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		s.audit(r, fp, "login_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	totpEnabled := user.TotpEnabled != nil && *user.TotpEnabled == 1
	webauthnEnabled := false
	if s.WebAuthn != nil {
		count, err := s.Q.CountWebAuthnCredentials(r.Context(), fp)
		if err != nil {
			slog.Error("count webauthn credentials", "error", err)
		} else {
			webauthnEnabled = count > 0
		}
	}
	if totpEnabled || webauthnEnabled {
		jsonOK(w, map[string]any{
			"requires_2fa": true,
			"totp":         totpEnabled,
			"webauthn":     webauthnEnabled,
		})
		return
	}

	// Update login_time on successful login
	if err := s.Q.UpdateLoginTime(r.Context(), fp); err != nil {
		slog.Error("update login time", "error", err)
	}
	s.audit(r, fp, "login_success", "")

	token, err := s.createToken(fp, user.SessionVersion)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Set httpOnly cookie
	s.setAuthCookie(w, r, token)

	if s.cookieAuth {
		// Never expose the JWT to JavaScript when httpOnly cookies are in use.
		jsonOK(w, map[string]any{"expires_at": time.Now().Add(s.hardLimit).Unix()})
		return
	}
	// Bearer-token mode: return the token for the Authorization header.
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
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(body.Password))
		s.audit(r, fp, "login_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		s.audit(r, fp, "login_failed", "invalid_credentials")
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if user.TotpSecret == nil || *user.TotpSecret == "" {
		s.audit(r, fp, "login_2fa_failed", "invalid_code")
		jsonError(w, "invalid 2fa code", http.StatusUnauthorized)
		return
	}

	secret, err := s.Secrets.DecryptString(*user.TotpSecret)
	if err != nil {
		slog.Error("decrypt totp secret", "fingerprint", fp, "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	step, ok := validateTOTPCode(secret, body.TOTPCode, user.LastTotpStep)
	if !ok {
		s.audit(r, fp, "login_2fa_failed", "invalid_code")
		jsonError(w, "invalid 2fa code", http.StatusUnauthorized)
		return
	}

	// Record the accepted step (replay protection). Legacy plaintext secrets
	// are transparently upgraded to the encrypted format.
	if strings.HasPrefix(*user.TotpSecret, totpSecretPrefix) {
		if err := s.Q.UpdateLastTOTPStep(r.Context(), dbgen.UpdateLastTOTPStepParams{
			LastTotpStep: step,
			Fingerprint:  fp,
		}); err != nil {
			slog.Error("update totp step", "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
	} else {
		encrypted, encErr := s.Secrets.EncryptString(secret)
		if encErr != nil {
			slog.Error("encrypt totp secret", "error", encErr)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		if err := s.Q.UpdateUserTOTP(r.Context(), dbgen.UpdateUserTOTPParams{
			TotpSecret:   &encrypted,
			TotpEnabled:  user.TotpEnabled,
			LastTotpStep: step,
			Fingerprint:  fp,
		}); err != nil {
			slog.Error("upgrade totp secret", "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
	}

	// Update login_time on successful 2FA login
	if err := s.Q.UpdateLoginTime(r.Context(), fp); err != nil {
		slog.Error("update login time", "error", err)
	}
	s.audit(r, fp, "login_2fa_success", "")

	token, err := s.createToken(fp, user.SessionVersion)
	if err != nil {
		slog.Error("create token", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Set httpOnly cookie
	s.setAuthCookie(w, r, token)

	if s.cookieAuth {
		// Never expose the JWT to JavaScript when httpOnly cookies are in use.
		jsonOK(w, map[string]any{"expires_at": time.Now().Add(s.hardLimit).Unix()})
		return
	}
	// Bearer-token mode: return the token for the Authorization header.
	jsonOK(w, map[string]string{"token": token})
}

// ---------------------------------------------------------------------------
// POST /api/logout — clear auth cookie
// ---------------------------------------------------------------------------

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: drop any cached plaintext git credential for this user.
	if fp, _, err := s.verifyToken(r); err == nil {
		s.audit(r, fp, "logout", "")
		if s.GitService != nil {
			s.GitService.ClearSessionToken(fp)
		}
	}

	s.clearAuthCookie(w, r)

	// Clear the CSRF cookie as well so a new one is issued on the next GET.
	// The CSRF cookie is a double-submit token, not an authentication
	// credential.
	s.setCookie(w, r, s.newCookie(csrfTokenCookie, "", "/", false, -1))

	jsonOK(w, map[string]string{"status": "logged out"})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/totp/setup — begin TOTP setup
// ---------------------------------------------------------------------------

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.CurrentPassword == "" {
		jsonError(w, "current_password required", http.StatusBadRequest)
		return
	}
	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	s.audit(r, fp, "totp_setup", "")
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
		Secret          string `json:"secret"`
		Code            string `json:"code"`
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.CurrentPassword == "" {
		jsonError(w, "current_password required", http.StatusBadRequest)
		return
	}

	user, err := s.Q.GetUser(r.Context(), fp)
	if err != nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	step, ok := matchTOTPCode(body.Secret, body.Code)
	if !ok {
		jsonError(w, "invalid totp code", http.StatusBadRequest)
		return
	}

	encrypted, err := s.Secrets.EncryptString(body.Secret)
	if err != nil {
		slog.Error("encrypt totp secret", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	enabled := int64(1)
	// Allow the confirmation code to be used once for the next login, but
	// reject it (and older steps) afterwards. Using the matched step (instead
	// of "current - 1") keeps this correct across a 30-second boundary.
	lastStep := step - 1
	if lastStep < 0 {
		lastStep = 0
	}

	codes, hashes, err := generateRecoveryCodes()
	if err != nil {
		slog.Error("generate recovery codes", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		slog.Error("begin totp transaction", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	qtx := s.Q.WithTx(tx)
	if err := qtx.UpdateUserTOTP(r.Context(), dbgen.UpdateUserTOTPParams{
		TotpSecret:   &encrypted,
		TotpEnabled:  &enabled,
		LastTotpStep: lastStep,
		Fingerprint:  fp,
	}); err != nil {
		_ = tx.Rollback()
		slog.Error("update totp", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := qtx.DeleteRecoveryCodes(r.Context(), fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete old recovery codes", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	for _, hash := range hashes {
		if err := qtx.InsertRecoveryCode(r.Context(), dbgen.InsertRecoveryCodeParams{
			Fingerprint: fp,
			CodeHash:    hash,
		}); err != nil {
			_ = tx.Rollback()
			slog.Error("insert recovery code", "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		slog.Error("commit totp transaction", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "totp_enabled", "")

	// Rotate the session so tokens issued before 2FA was enabled are no longer
	// valid, while keeping the current device logged in.
	if s.GitService != nil {
		s.GitService.ClearSessionToken(fp)
	}
	token, err := s.rotateSession(r, fp)
	if err != nil {
		slog.Error("rotate session after totp confirm", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.setAuthCookie(w, r, token)

	resp := map[string]any{"enabled": true, "recovery_codes": codes}
	if s.cookieAuth {
		resp["expires_at"] = time.Now().Add(s.hardLimit).Unix()
	} else {
		resp["token"] = token
	}
	jsonOK(w, resp)
}

// rotateSession bumps the user's session version (invalidating all existing
// tokens) and returns a fresh token for the new version.
func (s *Server) rotateSession(r *http.Request, fp string) (string, error) {
	ctx := r.Context()
	if err := s.Q.BumpSessionVersion(ctx, fp); err != nil {
		return "", err
	}
	info, err := s.Q.GetSessionInfo(ctx, fp)
	if err != nil {
		return "", err
	}
	return s.createToken(fp, info.SessionVersion)
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

	var body struct {
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.CurrentPassword == "" {
		jsonError(w, "current_password required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	user, err := s.Q.GetUser(ctx, fp)
	if err != nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
		jsonError(w, "invalid current password", http.StatusUnauthorized)
		return
	}

	// Delete entries and the user atomically.
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		slog.Error("delete account: begin tx", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	qtx := s.Q.WithTx(tx)
	if err := qtx.DeleteAuditLog(ctx, fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete account: purge audit log", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := qtx.DeleteRecoveryCodes(ctx, fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete account: purge recovery codes", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := qtx.DeleteWebAuthnCredentialsForUser(ctx, fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete account: purge passkeys", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := qtx.DeleteWebAuthnChallengesForUser(ctx, fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete account: purge webauthn challenges", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	entries, err := qtx.ListEntries(ctx, fp)
	if err != nil {
		_ = tx.Rollback()
		slog.Error("delete account: list entries", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	for _, entry := range entries {
		if err := qtx.DeleteEntry(ctx, dbgen.DeleteEntryParams{
			Fingerprint: fp,
			Path:        entry.Path,
		}); err != nil {
			_ = tx.Rollback()
			slog.Error("delete account: delete entry", "path", entry.Path, "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	if err := qtx.DeleteUser(ctx, fp); err != nil {
		_ = tx.Rollback()
		slog.Error("delete user", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		slog.Error("delete account: commit", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "account_delete", "")

	// Delete git repo folder if it exists
	if s.GitService != nil {
		s.GitService.ClearSessionToken(fp)
		repoPath, err := s.GitService.repoDir(fp)
		if err != nil {
			slog.Warn("delete git repo: refusing unsafe fingerprint", "fingerprint", fp, "error", err)
		} else if _, err := os.Stat(repoPath); err == nil {
			if err := os.RemoveAll(repoPath); err != nil {
				slog.Error("delete git repo", "error", err)
			}
			slog.Info("Permanently Delete Account: git repo removed from disk", "fingerprint", fp)
		}
	}

	slog.Info("Permanently Delete Account: user and entries removed from database", "fingerprint", fp)

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
	if err := validatePassword(body.NewPassword); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
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

	// Revoke every session issued with the old password.
	if err := s.Q.BumpSessionVersion(r.Context(), fp); err != nil {
		slog.Error("bump session version", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if s.GitService != nil {
		s.GitService.ClearSessionToken(fp)
	}
	s.clearAuthCookie(w, r)

	s.audit(r, fp, "password_change", "")
	slog.Info("password changed successfully", "fingerprint", fp)
	jsonOK(w, map[string]any{"status": "success", "reauth": true})
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/sessions/revoke — invalidate all sessions
// ---------------------------------------------------------------------------

func (s *Server) handleRevokeSessions(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	if fp == "" {
		jsonError(w, "fingerprint required", http.StatusBadRequest)
		return
	}

	if err := s.Q.BumpSessionVersion(r.Context(), fp); err != nil {
		slog.Error("bump session version", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if s.GitService != nil {
		s.GitService.ClearSessionToken(fp)
	}
	s.clearAuthCookie(w, r)

	s.audit(r, fp, "sessions_revoke", "")
	slog.Info("all sessions revoked", "fingerprint", fp)
	jsonOK(w, map[string]string{"status": "revoked"})
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

	s.audit(r, fp, "export", fmt.Sprintf("entries=%d", len(entries)))
	slog.Info("EXPORT: completed", "fingerprint", fp, "entries", len(entries))
}

// ---------------------------------------------------------------------------
// POST /api/{fingerprint}/import — import tar.gz or JSON batch
// ---------------------------------------------------------------------------

// Import limits: bound decompressed size and entry count to prevent gzip
// bombs and unbounded batch imports.
const (
	maxImportEntries    = 10000
	maxImportTotalBytes = int64(100 << 20) // 100 MiB decompressed
)

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
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			slog.Warn("IMPORT JSON: request body too large", "fingerprint", fp)
			jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		slog.Error("IMPORT JSON: decode failed", "fingerprint", fp, "error", err)
		jsonError(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	if len(entries) > maxImportEntries {
		slog.Warn("IMPORT JSON: too many entries", "fingerprint", fp, "count", len(entries))
		jsonError(w, "too many entries in import", http.StatusBadRequest)
		return
	}

	slog.Info("IMPORT JSON: importing entries", "fingerprint", fp, "total", len(entries))

	var count int
	var overwritten int
	var errors []map[string]interface{}

	for _, e := range entries {
		// Validate the destination path before touching the DB. Without this an
		// attacker could store traversal paths that later escape the git repo
		// directory during push (see GitService.exportPasswordStore).
		cleanPath, err := validateEntryPath(e.Path)
		if err != nil {
			slog.Warn("IMPORT JSON: rejected invalid path", "fingerprint", fp, "path", e.Path, "error", err)
			errors = append(errors, map[string]interface{}{
				"path":  e.Path,
				"error": "Invalid path: " + err.Error(),
			})
			continue
		}

		// Check if entry already exists (for overwrite count)
		existing, err := s.Q.GetEntry(r.Context(), dbgen.GetEntryParams{
			Fingerprint: fp,
			Path:        cleanPath,
		})
		if err == nil && existing.Path != "" {
			overwritten++
		}

		// Convert content to bytes (support multiple formats)
		content, err := parseImportContent(e.Content)
		if err != nil {
			slog.Error("IMPORT JSON: content parse failed", "fingerprint", fp, "path", cleanPath, "error", err)
			errors = append(errors, map[string]interface{}{
				"path":  cleanPath,
				"error": "Invalid content format: " + err.Error(),
			})
			continue
		}

		if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        cleanPath,
			Content:     content,
		}); err != nil {
			slog.Error("IMPORT JSON: upsert failed", "fingerprint", fp, "path", cleanPath, "error", err)
			errors = append(errors, map[string]interface{}{
				"path":  cleanPath,
				"error": err.Error(),
			})
		} else {
			count++
		}
	}

	s.audit(r, fp, "import", fmt.Sprintf("imported=%d overwritten=%d errors=%d", count, overwritten, len(errors)))
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
	var totalBytes int64
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
		if count >= maxImportEntries {
			slog.Warn("IMPORT TAR.GZ: too many entries", "fingerprint", fp)
			jsonError(w, "too many entries in import", http.StatusBadRequest)
			return
		}

		// Strip .gpg suffix if present
		path := hdr.Name
		path = strings.TrimSuffix(path, ".gpg")
		path = strings.TrimPrefix(path, "./")
		path = strings.TrimPrefix(path, "/")
		if path == "" {
			continue
		}

		// Reject traversal / absolute / control-character paths before they are
		// persisted. Imported paths are later written under the git repo dir.
		cleanPath, err := validateEntryPath(path)
		if err != nil {
			slog.Warn("IMPORT TAR.GZ: rejected invalid path", "fingerprint", fp, "path", path, "error", err)
			continue
		}

		content, err := io.ReadAll(io.LimitReader(tr, 1<<20))
		if err != nil {
			slog.Error("IMPORT TAR.GZ: read entry failed", "fingerprint", fp, "path", cleanPath, "error", err)
			jsonError(w, "read entry failed", http.StatusBadRequest)
			return
		}
		totalBytes += int64(len(content))
		if totalBytes > maxImportTotalBytes {
			slog.Warn("IMPORT TAR.GZ: import exceeds size limit", "fingerprint", fp, "bytes", totalBytes)
			jsonError(w, "import too large", http.StatusRequestEntityTooLarge)
			return
		}

		if err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
			Fingerprint: fp,
			Path:        cleanPath,
			Content:     content,
		}); err != nil {
			slog.Error("IMPORT TAR.GZ: upsert failed", "fingerprint", fp, "path", cleanPath, "error", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		count++
	}

	s.audit(r, fp, "import", fmt.Sprintf("imported=%d", count))
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
				"configured":            false,
				"repo_url":              "",
				"branch":                "HEAD",
				"auth_type":             "https",
				"encrypted_pat":         "",
				"has_encrypted_pat":     false,
				"encrypted_ssh_key":     "",
				"has_encrypted_ssh_key": false,
			})
			return
		}
		slog.Error("get git config", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"configured":            true,
		"repo_url":              config.RepoUrl,
		"branch":                config.Branch,
		"auth_type":             config.AuthType,
		"encrypted_pat":         config.EncryptedPat,
		"has_encrypted_pat":     config.EncryptedPat != "",
		"encrypted_ssh_key":     config.EncryptedSshKey,
		"has_encrypted_ssh_key": config.EncryptedSshKey != "",
	})
}

// POST /api/{fingerprint}/git/config — configure git sync
func (s *Server) handleGitConfig(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		RepoURL         string `json:"repo_url"`
		EncryptedPAT    string `json:"encrypted_pat"`
		EncryptedSSHKey string `json:"encrypted_ssh_key"`
		AuthType        string `json:"auth_type"`
		Branch          string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.RepoURL == "" {
		jsonError(w, "repo_url required", http.StatusBadRequest)
		return
	}

	// Auto-detect auth type from URL if not specified
	authType := body.AuthType
	if authType == "" {
		if strings.HasPrefix(body.RepoURL, "git@") || strings.HasPrefix(body.RepoURL, "ssh://") {
			authType = "ssh"
		} else {
			authType = "https"
		}
	}

	// Default branch to HEAD if not specified
	branch := body.Branch
	if branch == "" {
		branch = "HEAD"
	}

	if err := s.GitService.Configure(r.Context(), fp, body.RepoURL, body.EncryptedPAT, body.EncryptedSSHKey, authType, branch); err != nil {
		slog.Warn("GIT CONFIG: rejected", "fingerprint", fp, "error", err)
		jsonError(w, "invalid git configuration", http.StatusBadRequest)
		return
	}

	s.audit(r, fp, "git_config", "auth="+authType)
	slog.Info("GIT CONFIG: successfully configured", "fingerprint", fp, "repo", body.RepoURL, "branch", branch, "auth", authType)
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	result, err := s.GitService.Push(ctx, fp, token)
	if err != nil {
		slog.Error("git push", "error", err)
		// Check for structured host key errors
		var hkErr *HostKeyUnknownError
		if errors.As(err, &hkErr) {
			jsonOK(w, map[string]interface{}{
				"status":      "host_key_unknown",
				"host":        hkErr.Host,
				"port":        hkErr.Port,
				"fingerprint": hkErr.Fingerprint,
			})
			return
		}
		var hkcErr *HostKeyChangedError
		if errors.As(err, &hkcErr) {
			jsonOK(w, map[string]interface{}{
				"status":          "host_key_changed",
				"host":            hkcErr.Host,
				"port":            hkcErr.Port,
				"old_fingerprint": hkcErr.OldFingerprint,
				"new_fingerprint": hkcErr.NewFingerprint,
			})
			return
		}
		jsonError(w, "push failed", http.StatusInternalServerError)
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	result, err := s.GitService.Pull(ctx, fp, token)
	if err != nil {
		slog.Error("git pull", "error", err)
		// Check for structured host key errors
		var hkErr *HostKeyUnknownError
		if errors.As(err, &hkErr) {
			jsonOK(w, map[string]interface{}{
				"status":      "host_key_unknown",
				"host":        hkErr.Host,
				"port":        hkErr.Port,
				"fingerprint": hkErr.Fingerprint,
			})
			return
		}
		var hkcErr *HostKeyChangedError
		if errors.As(err, &hkcErr) {
			jsonOK(w, map[string]interface{}{
				"status":          "host_key_changed",
				"host":            hkcErr.Host,
				"port":            hkcErr.Port,
				"old_fingerprint": hkcErr.OldFingerprint,
				"new_fingerprint": hkcErr.NewFingerprint,
			})
			return
		}
		jsonError(w, "pull failed", http.StatusInternalServerError)
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

// ---------------------------------------------------------------------------
// SSH Known Hosts Handlers
// ---------------------------------------------------------------------------

// POST /api/{fingerprint}/git/trust-hostkey — trust a host key (TOFU)
func (s *Server) handleTrustHostKey(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	var body struct {
		Host        string `json:"host"`
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid json", http.StatusBadRequest)
		return
	}

	if body.Host == "" || body.Fingerprint == "" {
		jsonError(w, "host and fingerprint required", http.StatusBadRequest)
		return
	}

	if err := s.GitService.TrustHostKey(r.Context(), fp, body.Host, body.Fingerprint); err != nil {
		slog.Error("trust host key", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "git_trust_host", "host="+body.Host)
	jsonOK(w, map[string]string{"status": "trusted"})
}

// GET /api/{fingerprint}/git/trusted-hosts — list trusted hosts
func (s *Server) handleListTrustedHosts(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")

	hosts, err := s.GitService.GetTrustedHosts(r.Context(), fp)
	if err != nil {
		slog.Error("list trusted hosts", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	type hostEntry struct {
		Hostname           string    `json:"hostname"`
		HostKeyFingerprint string    `json:"host_key_fingerprint"`
		CreatedAt          time.Time `json:"created_at"`
	}

	entries := make([]hostEntry, len(hosts))
	for i, h := range hosts {
		entries[i] = hostEntry{
			Hostname:           h.Hostname,
			HostKeyFingerprint: h.HostKeyFingerprint,
			CreatedAt:          h.CreatedAt,
		}
	}

	jsonOK(w, map[string]interface{}{"hosts": entries})
}

// DELETE /api/{fingerprint}/git/trusted-hosts/{host} — remove a trusted host
func (s *Server) handleDeleteTrustedHost(w http.ResponseWriter, r *http.Request) {
	fp := r.PathValue("fingerprint")
	host := r.PathValue("host")

	if err := s.GitService.DeleteTrustedHost(r.Context(), fp, host); err != nil {
		slog.Error("delete trusted host", "error", err)
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	s.audit(r, fp, "git_untrust_host", "host="+host)
	jsonOK(w, map[string]string{"status": "deleted"})
}
