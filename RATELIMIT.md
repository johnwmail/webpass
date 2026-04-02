# Rate Limiting

WebPass implements rate limiting on authentication endpoints to protect against brute-force attacks and credential stuffing.

## Overview

The rate limiter uses a **sliding window** algorithm that tracks request timestamps per client (identified by fingerprint or IP address) and limits the number of requests within a configurable time window.

## Protected Endpoints

The following authentication endpoints are protected by rate limiting:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api` | POST | User registration (create account) |
| `/api/{fingerprint}/login` | POST | Login with password |
| `/api/{fingerprint}/login/2fa` | POST | Login with 2FA code |

### Why These Endpoints?

- **Registration**: Prevents spam account creation and abuse of the registration system
- **Login**: Prevents brute-force password guessing attacks
- **2FA Login**: Prevents brute-force attacks on TOTP codes

### Not Rate Limited

The following endpoints are **not** rate limited:

- **GET endpoints** (read-only operations)
- **JWT-authenticated endpoints** (already protected by authentication)
- **Registration code validation** (`POST /api/registration/validate`) - needed for legitimate users to validate codes

## How It Works

### Sliding Window Algorithm

1. Each request is identified by a **key** (fingerprint if available, otherwise IP address)
2. Request timestamps are stored per key
3. When a request arrives:
   - Expired timestamps (outside the window) are filtered out
   - If the count of valid timestamps >= limit, the request is **rejected** (HTTP 429)
   - Otherwise, the timestamp is recorded and the request is **allowed**

### Key Identification

The rate limiter identifies clients using:

1. **Fingerprint** (from URL path) - Preferred for authentication endpoints
2. **IP Address** - Fallback when no fingerprint is available

IP address extraction checks headers in this order:
1. `X-Forwarded-For` (first IP in list)
2. `X-Real-IP`
3. `RemoteAddr` (with port removed)

### Response on Rate Limit Exceeded

When rate limited, the server returns:

```
HTTP/1.1 429 Too Many Requests
Content-Type: text/plain; charset=utf-8

too many attempts, please try again later
```

The server also logs a warning:
```
WARN rate limit exceeded key=<fingerprint-or-ip> attempts=5 limit=5 window_minutes=15
```

## Configuration

Rate limiting is configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ATTEMPTS` | `5` | Maximum number of requests allowed per window |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Time window in minutes |

### Example Configuration

```bash
# Allow 10 attempts per 30 minutes
export RATE_LIMIT_ATTEMPTS=10
export RATE_LIMIT_WINDOW_MINUTES=30
```

### Configuration Guidelines

| Use Case | Attempts | Window | Rationale |
|----------|----------|--------|-----------|
| **Default (recommended)** | 5 | 15 min | Balanced security and usability |
| **Strict** | 3 | 30 min | High-security environments |
| **Relaxed (testing)** | 100 | 1 min | E2E tests, development |
| **Permissive** | 10 | 60 min | Low-security internal use |

### Invalid Configuration Handling

If invalid values are provided, the server logs a warning and uses defaults:

```
WARN invalid RATE_LIMIT_ATTEMPTS, using default value=abc default=5
WARN invalid RATE_LIMIT_WINDOW_MINUTES, using default value=-5 default=15
```

## Memory Management

The rate limiter includes automatic cleanup to prevent memory growth:

- **Cleanup interval**: Window duration / 2 (minimum 1 minute)
- **Cleanup action**: Removes expired timestamps and empty entries
- **Cleanup goroutine**: Runs in background, stops when server shuts down

## Testing

### E2E Tests

Rate limit tests are located in `frontend/tests/e2e/ratelimit.spec.ts`:

```bash
# Run rate limit tests only
./frontend/playwright-e2e-test.sh tests/e2e/ratelimit.spec.ts

# Run with grep filter
./frontend/playwright-e2e-test.sh --grep "Rate Limiting"
```

### Test Cases

| Test | Description |
|------|-------------|
| `should rate limit login attempts via API` | Verifies 5 failed logins succeed, 6th gets 429 |
| `should rate limit registration attempts via API` | Verifies 5 registrations succeed, 6th gets 429 |
| `should show user-friendly error message when rate limited` | Verifies error message is user-friendly (no technical details) |

### Unit Tests

Go unit tests are in `srv/server_test.go`:

```bash
# Run rate limiter unit tests
go test -v ./srv -run TestRateLimiter
```

### Test Configuration

For E2E tests, the test script automatically manages rate limits:

- **Rate limit tests**: Run with default limits (5 attempts / 15 min)
- **Other tests**: Run with relaxed limits (100 attempts / 1 min) to prevent false failures

This is handled automatically by `playwright-e2e-test.sh`.

## Implementation Details

### Code Structure

```
srv/
├── ratelimit.go      # Rate limiter implementation
└── server.go         # HTTP middleware integration
```

### Key Functions

| Function | Purpose |
|----------|---------|
| `NewRateLimiter()` | Creates rate limiter with config from env vars |
| `Allow(key)` | Checks if request is allowed, records timestamp |
| `IsAllowed(key)` | Checks if request would be allowed (read-only) |
| `Remaining(key)` | Returns remaining requests in current window |
| `cleanup()` | Removes expired timestamps |
| `rateLimitMiddleware()` | HTTP middleware wrapper |

### Thread Safety

The rate limiter is thread-safe:
- Uses `sync.Mutex` for all operations
- Safe for concurrent requests from multiple goroutines

## Security Considerations

### What Rate Limiting Protects Against

- **Brute-force attacks**: Limits password guessing attempts
- **Credential stuffing**: Limits automated login attempts with stolen credentials
- **Spam registration**: Prevents mass account creation

### What Rate Limiting Does NOT Protect Against

- **DDoS attacks**: Rate limiting is per-key, not global
- **Distributed attacks**: Attackers can use multiple IPs
- **Application-layer attacks**: Other security measures needed

### Best Practices

1. **Use HTTPS**: Prevents IP spoofing via headers
2. **Monitor logs**: Watch for rate limit warnings
3. **Combine with other security**: JWT, bcrypt, TOTP
4. **Adjust for your use case**: Higher limits for trusted networks

## Troubleshooting

### Users Getting Rate Limited Too Quickly

**Symptoms**: Legitimate users hit rate limit after few attempts

**Solutions**:
1. Increase `RATE_LIMIT_ATTEMPTS`
2. Increase `RATE_LIMIT_WINDOW_MINUTES`
3. Check if multiple users share same IP (NAT, corporate network)

### Rate Limit Not Working

**Symptoms**: No rate limiting observed

**Check**:
1. Environment variables are set correctly
2. Server was restarted after config change
3. Check server logs for rate limit warnings
4. Verify requests are hitting rate-limited endpoints

### Debugging

Enable verbose logging and check for:
```
WARN rate limit exceeded key=... attempts=... limit=... window_minutes=...
```

## Related Documentation

- [DEPLOY.md](DEPLOY.md) - Deployment configuration
- [AGENTS.md](AGENTS.md) - Development guide
- [REGISTRATION.md](REGISTRATION.md) - Registration flow
