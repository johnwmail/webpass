# 🔐 Registration Security

Secure user registration with TOTP-based verification.

---

## Overview

WebPass uses **TOTP-based registration tokens** to prevent unauthorized account creation. This ensures that only users with access to the server's registration code can create new accounts.

**Key Features:**
- **Time-limited codes** — Registration code expires based on configured period (default: 3600 seconds / 1 hour)
- **Fixed secret** — Admin-configured TOTP secret (survives restarts)
- **Logged once per rotation** — Code printed to logs only when it changes
- **Always persisted** — Code written to `/data/registration_code.txt`
- **Three modes** — Disabled, Open (no code), or Protected (TOTP code required)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Server Startup                                                 │
│                                                                 │
│  1. Admin sets REGISTRATION_ENABLED and REGISTRATION_TOTP_SECRET│
│  2. If secret set: TOTP code computed                           │
│  3. Code logged once when it rotates                            │
│  4. Code written to /data/registration_code.txt                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Admin retrieves current code (only if secret is set)           │
│                                                                 │
│  Option A: Check server logs                                    │
│    $ docker logs webpass | grep "REGISTRATION CODE"             │
│    [INFO] REGISTRATION CODE: 482156 (expires in 30s)            │
│                                                                 │
│  Option B: Read file on server                                  │
│    $ cat /data/registration_code.txt                            │
│    482156                                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  User Registration Flow                                         │
│                                                                 │
│  Mode A: Open Registration (no secret set)                      │
│    1. User visits registration page                             │
│    2. User enters login password + PGP passphrase               │
│    3. Account created immediately                               │
│                                                                 │
│  Mode B: Protected Registration (secret set)                    │
│    1. User visits registration page                             │
│    2. User enters:                                              │
│       - Login password                                          │
│       - PGP passphrase                                          │
│       - Registration code (6 digits from admin)                 │
│    3. Frontend sends POST /api with code in header              │
│    4. Server validates: code matches current time window?       │
│       ✓ Valid → Create account                                  │
│       ✗ Invalid → Reject (wrong/expired code)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRATION_ENABLED` | `false` | Set to `1` or `true` to enable user registration |
| `REGISTRATION_TOTP_SECRET` | *(empty)* | Base32-encoded secret for TOTP code generation. If empty and `REGISTRATION_ENABLED=true`, registration is open (no code required). |
| `REGISTRATION_TOTP_PERIOD` | `3600` | TOTP code validity period in seconds (15-86400). Default: 3600 (1 hour) for stability. |
| `REGISTRATION_TOTP_ALGO` | `SHA1` | Hash algorithm: `SHA1` (Google Authenticator), `SHA256`, `SHA512` |
| `REGISTRATION_CODE_FILE` | `/data/registration_code.txt` | File path for current code |

### Registration Modes

| `REGISTRATION_ENABLED` | `REGISTRATION_TOTP_SECRET` | Mode |
|------------------------|---------------------------|------|
| `false` | (any) | **Registration disabled** — No new users allowed |
| `true` | (not set) | **Open registration** — Anyone can register (no code) |
| `true` | (set) | **Protected registration** — TOTP code required |

### Example Configuration

```bash
# Docker Compose (.env file)

# Mode 1: Protected registration (TOTP code required)
# Generate a secret (one-time, store securely)
# openssl rand -base32 32
# Example output: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
REGISTRATION_ENABLED=true
REGISTRATION_TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
REGISTRATION_TOTP_PERIOD=3600  # 1 hour (default) - code stays valid longer for stability
REGISTRATION_TOTP_ALGO=SHA1
REGISTRATION_CODE_FILE=/data/registration_code.txt

# Mode 2: Open registration (no code required - for initial setup)
# REGISTRATION_ENABLED=true
# REGISTRATION_TOTP_SECRET=

# Mode 3: Registration disabled (default for existing deployments)
# REGISTRATION_ENABLED=false
```

---

## Usage

### 1. Check Current Registration Code

**Via Docker logs:**
```bash
docker logs webpass 2>&1 | grep "REGISTRATION CODE"
```

**Output:**
```
[INFO] REGISTRATION CODE: 482156 (expires in 23s)
[INFO] Registration code file: /data/registration_code.txt
```

**Via file (on server):**
```bash
cat /data/registration_code.txt
# Output: 482156
```

### 2. Share Code with User

**In-person:**
> "The registration code is: 4-8-2-1-5-6. It expires in about 20 seconds."

**Remote (Signal/WhatsApp):**
> WebPass registration code: `482156` (valid for ~25s)

**Important:** The code changes based on the configured period (default: 1 hour). If it expires, check logs again for the new code.

### 3. User Enters Code

User navigates to your WebPass instance and fills out the registration form:

1. **Server URL**: `https://webpass.example.com`
2. **Login Password**: (their chosen password)
3. **PGP Passphrase**: (their chosen passphrase)
4. **Registration Code**: `482156` (the 6-digit code you provided)

### 4. Registration Completes

If the code is valid and not expired:
- ✓ Account created
- ✓ User can now login
- ✓ Code remains valid for other users (until time window expires)

If the code is invalid or expired:
- ✗ Error: "Invalid or expired registration code"
- ✗ User must request a new code from admin

---

## Server Log Output

Example server startup logs (with `REGISTRATION_ENABLED=true` and secret set):

```
[INFO] starting server addr=:8080
[INFO] database opened at /data/db/db.sqlite3
[INFO] migrations completed
[INFO] REGISTRATION CODE: 482156 (expires in 3599s)
[INFO] Registration code file: /data/registration_code.txt
```

**Code rotation (every 3600 seconds / 1 hour):**
```
[INFO] REGISTRATION CODE: 739281 (expires in 3599s)
```

**Successful registration:**
```
[INFO] REGISTRATION: new user created fingerprint=abc123...
```

**Open registration (no secret set):**
```
[INFO] starting server addr=:8080
[INFO] database opened at /data/db/db.sqlite3
[INFO] migrations completed
[INFO] registration: open (no TOTP secret configured)
```

---

## Security Model

### Threat Mitigation

| Threat | Mitigation |
|--------|------------|
| **Unauthorized registration** | Code required for all new accounts |
| **Code interception** | Code expires in 1 hour (configurable) |
| **Replay attacks** | Code changes every time window |
| **Remote attacks** | Admin must share code via secure channel |

### Code Properties

| Property | Value |
|----------|-------|
| **Length** | 6 digits (000000-999999) |
| **Validity** | 3600 seconds (1 hour, configurable: 15-86400s) |
| **Algorithm** | SHA256 (configurable: SHA1/SHA256/SHA512) |
| **Reuse** | Allowed within same time window |

---

## Registration Flow (Technical)

### API Endpoint

```http
POST /api
Content-Type: application/json
X-Registration-Code: 482156

{
  "password": "user-password",
  "public_key": "-----BEGIN PGP PUBLIC KEY BLOCK-----...",
  "fingerprint": "abc123..."
}
```

### Server-Side Validation

```go
// Pseudocode
func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
    // Check if registration is enabled
    if !s.RegistrationEnabled {
        jsonError(w, "registration is disabled", http.StatusForbidden)
        return
    }

    // If TOTP secret is set, validate registration code
    if s.TotpSecret != "" {
        code := r.Header.Get("X-Registration-Code")
        
        // Validate TOTP code (current + previous window for grace period)
        if !s.ValidateRegistrationCode(code) {
            jsonError(w, "invalid or expired registration code", http.StatusUnauthorized)
            return
        }
    }
    // If no secret set, skip code validation (open registration)

    // Create user...
}
```

### Frontend Integration

```typescript
// Setup.tsx
const registrationCode = '482156'; // From user input

const response = await fetch(`${apiUrl}/api`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Registration-Code': registrationCode,
  },
  body: JSON.stringify({
    password: loginPassword,
    public_key: publicKey,
    fingerprint: fingerprint,
  }),
});
```

---

## Troubleshooting

### "Invalid or expired registration code"

**Cause:** Code has expired (older than configured period) or is incorrect.

**Solution:**
1. Ask admin to check logs for current code
2. Wait for admin to provide new code
3. Try again immediately

---

### "Registration is disabled"

**Cause:** `REGISTRATION_ENABLED` is not set or set to `false`.

**Solution:**
1. Admin sets `REGISTRATION_ENABLED=true` in environment
2. Restart server
3. Check logs to verify registration mode

---

### How to enable open registration (no code required)

**Use case:** Initial setup, trusted environments, or temporary onboarding.

**Solution:**
1. Set `REGISTRATION_ENABLED=true`
2. Do NOT set `REGISTRATION_TOTP_SECRET`
3. Restart server
4. Verify log shows: `registration: open (no TOTP secret configured)`

---

### Code not appearing in logs

**Cause:** TOTP secret not set (open registration mode) or file path not writable.

**Solution:**
```bash
# Check registration mode
docker logs webpass 2>&1 | grep "registration"

# Verify file path is writable
docker exec webpass ls -la /data/

# Check environment
docker exec webpass env | grep REGISTRATION
```

---

### Multiple users registering simultaneously

**Issue:** Only one code is valid at a time (changes every 3600 seconds / 1 hour).

**Solution:**
- **Option A:** Users register sequentially (wait for current code window)
- **Option B:** Reduce TOTP period for faster rotation
  ```bash
  REGISTRATION_TOTP_PERIOD=60  # 1 minute
  ```

---

## Best Practices

### For Admins

1. **Generate a strong secret** — Use `openssl rand -base32 32` and store securely
2. **Use protected mode for production** — Always set `REGISTRATION_TOTP_SECRET`
3. **Use open mode for initial setup** — Temporarily enable for easy onboarding
4. **Monitor logs during onboarding** — Watch for registration attempts
5. **Use secure channels** — Share codes via Signal, in-person, or encrypted chat
6. **Disable after onboarding** — Set `REGISTRATION_ENABLED=false` when not adding users
7. **Rotate on suspicion** — Generate new secret and restart server if compromised

### For Users

1. **Enter code immediately** — Don't wait after receiving from admin
2. **Double-check digits** — Verify 6-digit code before submitting
3. **Request new code if expired** — Don't retry old codes

### For Teams

1. **Schedule onboarding sessions** — Coordinate TOTP code sharing
2. **Document the process** — Keep runbook for new user setup

---

## Migration Guide

### From Open Registration to Protected

If you currently allow open registration and want to add TOTP protection:

```bash
# 1. Generate a TOTP secret
openssl rand -base32 32
# Example output: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP

# 2. Stop current deployment
docker-compose down

# 3. Add registration config to .env
REGISTRATION_ENABLED=true
REGISTRATION_TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
REGISTRATION_TOTP_PERIOD=3600
REGISTRATION_TOTP_ALGO=SHA1

# 4. Restart
docker-compose up -d

# 5. Verify
docker logs webpass | grep "REGISTRATION CODE"
```

### From Protected to Open Registration

If you want to temporarily allow open registration (e.g., for team onboarding):

```bash
# 1. Stop current deployment
docker-compose down

# 2. Remove or comment out TOTP secret in .env
# REGISTRATION_TOTP_SECRET=xxx
REGISTRATION_ENABLED=true

# 3. Restart
docker-compose up -d

# 4. Verify log shows: registration: open
```

### From Disabled to Any Mode

```bash
# 1. Stop current deployment
docker-compose down

# 2. Enable registration
REGISTRATION_ENABLED=true

# 3. Optional: Add TOTP secret for protected mode
# REGISTRATION_TOTP_SECRET=your-secret-here

# 4. Restart
docker-compose up -d
```

---

## Implementation Notes

### Registration Modes

The server determines registration mode at startup based on environment variables:

1. **Disabled** (`REGISTRATION_ENABLED` not set or `false`)
   - All registration attempts rejected with 403 Forbidden
   
2. **Open** (`REGISTRATION_ENABLED=true`, no secret)
   - No registration code required
   - Log shows: `registration: open (no TOTP secret configured)`
   
3. **Protected** (`REGISTRATION_ENABLED=true`, secret set)
   - TOTP code required in `X-Registration-Code` header
   - Code logged and written to file on rotation

### TOTP Secret

- **Admin-provided** — Set via `REGISTRATION_TOTP_SECRET` environment variable
- **Format** — Base32-encoded string (e.g., output from `openssl rand -base32 32`)
- **Persistence** — Store securely in your `.env` file or secrets manager
- **Multi-instance** — Use the same secret across all instances for consistent codes

### Generating a Secret

```bash
# Generate a new secret (do this once, store securely)
openssl rand -base32 32
# Example output: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP

# Or use any base32 string (must be valid base32 encoding)
```

### Code Logging

- Code logged to console only when it changes (every 3600 seconds / 1 hour)
- Log format: `[INFO] REGISTRATION CODE: 123456 (expires in 3599s)`
- No periodic "file updated" messages

### Code File

- Always written to `/data/registration_code.txt` (aligns with `/data/db/`)
- Contains only the 6-digit code (no timestamp or metadata)
- File permissions: `0600` (owner read/write only)
- Updated every 3600 seconds (or configured period)
- Only written when TOTP secret is configured

### Grace Period

- Server accepts codes from current AND previous time window
- This accounts for clock skew between admin and server
- Grace period: 1 time window (e.g., 3600 seconds with default config)

---

## See Also

- [GITSYNC.md](GITSYNC.md) — Git sync feature documentation
- [DEPLOY.md](DEPLOY.md) — Deployment guide
- [AGENTS.md](AGENTS.md) — Development guide
