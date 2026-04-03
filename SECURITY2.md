# WebPass Security Recommendations

This document outlines security recommendations for the WebPass password manager, organized by priority.

---

## 🔴 Critical Security Issues

### 1. JWT Token Storage in localStorage

**Location:** `frontend/src/lib/session.ts`

**Issue:** JWT tokens are stored in `localStorage`, making them vulnerable to XSS attacks.

**Recommendation:**
- Use `httpOnly` cookies instead of localStorage for token storage
- Add `Secure`, `SameSite=Strict`, and `HttpOnly` flags
- This requires backend changes to set cookies on login

---

### 2. Missing Rate Limiting on Authentication Endpoints

**Location:** `server.go` - `handleLogin`, `handleLogin2FA`, `handleCreateUser`

**Issue:** No rate limiting allows brute-force attacks on passwords and TOTP codes.

**Recommendation:**
- Implement rate limiting per-fingerprint (e.g., 5 attempts per 15 minutes)
- Use a sliding window or token bucket algorithm
- Consider adding exponential backoff

---

### 4. Weak CORS Configuration

**Location:** `server.go` - `corsMiddleware`

**Issue:** By default, all origins are allowed when `CORS_ORIGINS` is not set.

**Recommendation:**
- Default to restrictive CORS (deny all unless explicitly configured)
- Require explicit `CORS_ORIGINS` in production
- Document this as a security requirement

---

## 🟠 High Priority Issues

### 5. No Input Validation on Entry Path

**Location:** `server.go` - `handleGetEntry`, `handlePutEntry`, `handleDeleteEntry`

**Issue:** Path traversal attacks possible via `../` in entry paths.

**Recommendation:**
- Validate and sanitize entry paths
- Reject paths containing `..`, absolute paths, or null bytes
- Use `filepath.Clean` and validate against allowed patterns

---

### 6. Missing Content-Length Validation

**Location:** `server.go` - `handlePutEntry`

**Issue:** Only has 1MB limit via `io.LimitReader`, but no minimum validation.

**Recommendation:**
- Add maximum size configuration (currently hardcoded to 1MB)
- Consider per-user storage quotas
- Validate content isn't empty before database write

---

### 7. Session Duration Stored Client-Side

**Location:** `session.ts` - `SESSION_DURATION_MS`

**Issue:** Client determines session expiry, not just server.

**Recommendation:**
- Remove client-side duration constant
- Rely solely on server JWT `exp` claim
- Client should check token validity via server response

---

### 8. Git PAT Token Caching

**Location:** `git.go` - `SessionToken` cache

**Issue:** Git PAT tokens cached in memory for 5 minutes.

**Recommendation:**
- Ensure tokens are cleared on logout/account deletion
- Consider shorter cache duration (1-2 minutes)
- Add explicit "clear git session" on lock

---

## 🟡 Medium Priority Issues

### 9. No CSRF Protection

**Issue:** No CSRF tokens for state-changing operations.

**Recommendation:**
- Implement double-submit cookie pattern or CSRF tokens
- Especially important if switching to cookie-based auth
- Add `X-CSRF-Token` header requirement

---

### 10. Missing Security Headers

**Location:** `server.go` - CORS middleware

**Issue:** No security headers like:
- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy`

**Recommendation:** Add standard security headers to all responses.

---

### 11. Bcrypt Cost Factor

**Location:** `server.go` - `bcrypt.GenerateFromPassword`

**Issue:** Uses `bcrypt.DefaultCost` (currently 10).

**Recommendation:**
- Increase to 12-14 for better protection
- Make configurable via environment variable
- Consider argon2 for new deployments

---

### 12. TOTP Secret Storage

**Location:** Database stores TOTP secrets

**Issue:** TOTP secrets stored without encryption.

**Recommendation:**
- Encrypt TOTP secrets at rest using user's public key
- Or derive encryption key from password
- Store encrypted blob in database

---

### 13. Export Without Re-encryption

**Location:** `handleExport`

**Issue:** Export returns entries as-is (already PGP encrypted, which is correct).

**Recommendation:**
- Document that export contains PGP-encrypted data
- Consider adding integrity check (HMAC) to detect tampering
- Add export audit logging

---

## 🟢 Low Priority / Best Practices

### 14. Memory Clearing for Sensitive Data

**Location:** `crypto.ts` - `clearSensitiveData`

**Issue:** JavaScript `gc()` is non-standard and unreliable.

**Recommendation:**
- Document limitation clearly
- Consider WebAssembly for sensitive operations (better memory control)
- Minimize time sensitive data lives in memory

---

### 15. Error Message Information Leakage

**Location:** Various error handlers

**Issue:** Some errors may reveal too much (e.g., "user exists" vs "not found").

**Recommendation:**
- Use generic error messages for auth failures
- "Invalid credentials" for both user-not-found and wrong-password
- Log detailed errors server-side only

---

### 16. Audit Logging

**Issue:** Limited audit trail for security events.

**Recommendation:**
- Log all authentication attempts (success/failure)
- Log password changes, TOTP changes, account deletion
- Add structured logging with correlation IDs
- Consider audit log export for users

---

### 17. Docker Security Enhancements

**Location:** `Dockerfile`, `k8s/deployment.yaml`

**Recommendations:**
- Add `seccomp` profile
- Consider AppArmor profile
- Drop all capabilities (already done in K8s)
- Add health check with authentication bypass for `/api/health` only

---

### 18. Dependency Updates

**Recommendation:**
- Enable Dependabot or Renovate for automated security updates
- Regularly audit `npm audit` and `go list -m -u`
- Pin dependency versions in production

---

## Summary Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 🔴 Critical | JWT in localStorage | Medium | High |
| 🔴 Critical | No rate limiting | Medium | High |
| 🔴 Critical | Registration code logging | Low | High |
| 🔴 Critical | Permissive CORS default | Low | Medium |
| 🟠 High | Path traversal vulnerability | Low | High |
| 🟠 High | Missing security headers | Low | Medium |
| 🟠 High | TOTP secret encryption | Medium | High |
| 🟡 Medium | CSRF protection | Medium | Medium |
| 🟡 Medium | Bcrypt cost increase | Low | Low |
| 🟡 Medium | Input validation | Low | Medium |

---

## Implementation Phases

### Phase 1: Critical Fixes (Week 1)
1. Remove registration code from logs
2. Add path traversal validation
3. Implement rate limiting
4. Fix CORS default
5. Add security headers

### Phase 2: Authentication Hardening (Week 2-3)
6. Migrate JWT to httpOnly cookies
7. Encrypt TOTP secrets at rest
8. Increase bcrypt cost

### Phase 3: Defense in Depth (Week 3-4)
9. Add CSRF protection
10. Implement audit logging
11. Add input validation layer
12. Memory management improvements

### Phase 4: Infrastructure Security (Week 4+)
13. Docker/K8s hardening
14. Dependency automation
15. Security-focused E2E tests

**Estimated Total Effort:** 4-6 weeks for full implementation
