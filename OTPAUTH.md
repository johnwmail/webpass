# TOTP Support (pass-otp Compatible)

WebPass supports storing and generating TOTP codes using the `otpauth://` URI format, compatible with [`pass-otp`](https://github.com/tadfisher/pass-otp).

TOTP implementation follows [RFC 6238](https://tools.ietf.org/html/rfc6238) (Time-Based One-Time Password).

> **Note:** HOTP (counter-based) is not supported. Simple is a security feature — TOTP covers 99% of use cases (Google, GitHub, Microsoft, AWS, etc.).

## Overview

TOTP URIs are stored as plain text lines within encrypted entry content. The server treats them as regular text — no parsing, no validation, no code generation. All TOTP operations happen **client-side**:

- **Client decrypts** entry with user's PGP private key
- **Client extracts** TOTP URI from content
- **Client generates** codes locally (no server API needed)
- **Server stores** only encrypted blobs

> This is true zero-knowledge: the server never sees TOTP secrets or generated codes.

## Standards Compliance

| Algorithm | Standard | Description |
| --------- | -------- | ----------- |
| TOTP      | RFC 6238 | Time-Based One-Time Password (time-based windows) |
| URI Format| Key URI  | `otpauth://totp/` format per Google Authenticator |

## URI Format

```
otpauth://totp/LABEL?PARAMETERS
```

### Example

```
otpauth://totp/GitHub:infra.team@uinvex.com?secret=JS6TGO7J45G52ZHF&issuer=GitHub
```

### Parameters

| Parameter   | Required | Description                                      |
| ----------- | -------- | ------------------------------------------------ |
| `TYPE`      | Yes      | `totp` (time-based)                              |
| `LABEL`     | Yes      | `Issuer:Account` or just `Account`               |
| `secret`    | Yes      | Base32-encoded shared secret                     |
| `issuer`    | No       | Service provider name (e.g., GitHub, Google)     |
| `algorithm` | No       | Hash algorithm (default: `SHA1`)                 |
| `digits`    | No       | Code length (default: `6`)                       |
| `period`    | No       | Time window in seconds (default: `30`)           |

## Entry Content Format

TOTP URIs are stored as lines starting with `otpauth://totp/` within the entry content:

```
password123
username: john@example.com
recovery: 555-1234
otpauth://totp/GitHub:john@example.com?secret=ABC123&issuer=GitHub
```

### Multiple TOTP URIs — Last One Wins

If multiple lines start with `otpauth://totp/`, the **last valid URI** is used:

```
password123
otpauth://totp/OldService:user?secret=AAA  ← ignored
some notes
otpauth://totp/GitHub:user?secret=ABC123   ← this one is used
```

This allows users to update TOTP configurations over time — the most recent URI takes precedence.

## API Endpoints

No special API endpoints needed for TOTP code generation — it all happens client-side.

The TOTP URI is stored as part of the entry content, so standard entry operations work:

- **PUT /api/{fingerprint}/entries/{path}** — Create/update entry (with TOTP URI in content)
- **GET /api/{fingerprint}/entries/{path}** — Download encrypted entry
- **DELETE /api/{fingerprint}/entries/{path}** — Delete entry

That's it! The server just stores encrypted blobs.

## Frontend Usage

### Adding TOTP to an Entry

Simply add a line starting with `otpauth://totp/` in the Notes field when editing an entry:

```
username: john@example.com
recovery: 555-1234
otpauth://totp/GitHub:john@example.com?secret=ABC123&issuer=GitHub
```

The TOTP code widget will appear automatically when viewing the entry.

### Viewing TOTP Codes

When viewing an entry with a TOTP URI:

- TOTP code displays in a dedicated widget below the password
- Code auto-refreshes based on the `period` value (default: 30 seconds)
- Visual countdown shows time until next code
- **Click to copy** code to clipboard
- **Auto-clears after 45 seconds** for security
- Shows "✓ Copied!" confirmation briefly

### Warning for Invalid Format

If entry contains `otpauth://` lines but none are valid:

```
┌─────────────────────────────────────────┐
│ ⚠️ Invalid TOTP URI format             │
│                                         │
│ Found: otpauth://totp/Service:user     │
│ Hint: Missing or invalid 'secret' param│
│                                         │
│ Edit entry to fix or remove the URI    │
└─────────────────────────────────────────┘
```

- Yellow info box (not red error)
- Shows the invalid URI found
- Helpful hint about what's wrong
- "Edit" link to quickly fix

### Generating TOTP Secrets

For services that don't provide a QR code or URI:

1. Use an external TOTP secret generator (or password manager)
2. Generate a random Base32 secret
3. Enter this secret into the service's 2FA setup
4. Construct the URI manually:
   ```
   otpauth://totp/ServiceName:your-email?secret=YOURSECRET&issuer=ServiceName
   ```
5. Paste the URI as a note line in your entry

## Security Considerations

- **TOTP secrets are encrypted** along with the rest of the entry content
- **Server cannot read TOTP data** — it only stores encrypted blobs
- **Client-side code generation** — codes generated in browser, never sent to server
- **Clipboard auto-clear** — copied codes are automatically cleared after 45 seconds
- **Session timeout** — entry decryption requires valid JWT session
- **No TOTP data logged** — codes never appear in browser history or network logs

## pass-otp Compatibility

WebPass is compatible with `pass-otp`:

- Same `otpauth://` URI format
- TOTP URIs stored as text lines within entry content
- Can import/export entries with TOTP URIs via tar.gz

### Migration from pass-otp

1. Export your `pass` password store: `pass otp export > backup.tar.gz`
2. Import into WebPass via Settings → Import
3. TOTP URIs are preserved automatically

### Migration to pass-otp

1. Export from WebPass via Settings → Export
2. Import into `pass`: `pass otp import backup.tar.gz`

## Implementation Notes

### Backend (Go)

**No backend changes needed!** The server just stores encrypted entry content.

### Frontend (Preact)

#### New Files

| File | Purpose | Why Needed |
|------|---------|------------|
| `frontend/src/lib/otp.ts` | TOTP utilities | Pure functions for parsing URIs and generating codes. Separates TOTP logic from UI components for reusability and testing. |
| `frontend/src/components/OTPDisplay.tsx` | Live TOTP code widget | UI component that auto-detects TOTP URIs, generates codes, shows countdown, and handles copy-to-clipboard with auto-clear. |

#### Modified Files

| File | Changes | Why Needed |
|------|---------|------------|
| `frontend/src/components/EntryDetail.tsx` | Import `extractLastTOTPURI` and `OTPDisplay`. After decrypting entry, check for TOTP URI and render `<OTPDisplay />` if found. | Integrates TOTP display into existing entry view. Only shows widget when entry contains valid TOTP URI. |
| `frontend/package.json` | Add `"otpauth": "^9.3.2"` dependency | Provides RFC 6238 TOTP code generation in JavaScript. No need to implement crypto manually. |

#### Implementation Details

**`frontend/src/lib/otp.ts`**
```typescript
// Parse otpauth:// URI into structured object
parseOTPURI(uri: string): TOTPEntry | null

// Generate current 6-digit TOTP code
generateTOTPCode(secret: string, period?: number): string

// Find last valid otpauth://totp/ line in entry content
extractLastTOTPURI(content: string): string | null

// Check if content has any otpauth:// lines (valid or invalid)
hasAnyOTPURI(content: string): boolean

// Find invalid otpauth:// lines (for warning display)
findInvalidOTPUris(content: string): string[]
```

**`frontend/src/components/OTPDisplay.tsx`**
- Props: `content` (entry content string)
- Auto-extracts last TOTP URI from content
- Generates code every `period` seconds (default: 30)
- Shows countdown progress bar
- Click to copy → auto-clears after 45 seconds
- Shows "✓ Copied!" confirmation
- **Warning display**: If invalid `otpauth://` line found, shows warning message (not error, just helpful hint)

**`frontend/src/components/EntryDetail.tsx`**
- After decrypting entry, call `extractLastTOTPURI(content)`
- If valid URI found, render `<OTPDisplay content={rawContent} />`
- If invalid `otpauth://` lines found but no valid URI, render `<OTPDisplay warning="Invalid TOTP URI format" />`
- Widget appears below password field

## Testing

### Unit Tests (Required)

| File | What to Test |
|------|--------------|
| `frontend/src/lib/otp.test.ts` | - `parseOTPURI()`: Valid URIs, invalid URIs, missing parameters<br>- `generateTOTPCode()`: Code is 6 digits, changes with time, different periods<br>- `extractLastTOTPURI()`: Finds last valid URI, ignores invalid formats, handles multiple URIs |

### CI Integration

Frontend tests are now part of the CI workflow (`.github/workflows/ci.yml`):

```yaml
- name: Run frontend tests
  run: cd frontend && npm test
```

This ensures all frontend unit tests run on every push and PR, catching bugs before they reach main.

### Test Cases for `otp.test.ts`

```typescript
// parseOTPURI tests
✓ Valid TOTP URI with all parameters
✓ Valid TOTP URI with minimal parameters (secret only)
✓ Invalid URI (not otpauth://)
✓ Missing secret parameter → null
✓ Wrong type (otpauth://hotp/) → null
✓ Malformed URI (otpauth://totp/ without ?) → null
✓ Invalid Base32 secret (contains invalid chars) → null

// generateTOTPCode tests
✓ Returns 6-digit code
✓ Same code within same period
✓ Different code after period changes
✓ Handles custom periods (60s, 3600s, 86400s)
✓ Period 30s → code changes every 30 seconds
✓ Period 3600s (1 hour) → code stays same for 1 hour
✓ Period 86400s (24 hours) → code stays same for 1 day

// extractLastTOTPURI tests
✓ Single TOTP URI at end → returns it
✓ Multiple valid TOTP URIs → returns last valid one
✓ No TOTP URI → returns null
✓ TOTP URI with leading/trailing whitespace → trims and returns
✓ Mixed content (password, notes, TOTP) → finds TOTP
✓ Invalid format "otpauth://..." (missing secret) → ignored
✓ Invalid format "otpauth://totp/bad-uri" → ignored
✓ Two valid URIs → last one wins
✓ Three URIs (2 valid, 1 invalid) → last valid one wins
✓ Edge case: "otpauth://" as substring in notes → ignored

// hasAnyOTPURI tests
✓ Content with valid TOTP URI → true
✓ Content with invalid otpauth:// line → true
✓ Content without any otpauth:// → false

// findInvalidOTPUris tests
✓ Valid URI only → empty array
✓ Invalid URI (missing secret) → returns invalid URI
✓ Mixed valid + invalid → returns only invalid ones
✓ Multiple invalid → returns all invalid
```

### Manual Testing Checklist

- [ ] Add TOTP URI to entry (paste as note line)
- [ ] View entry → TOTP widget appears
- [ ] Code refreshes every 30 seconds
- [ ] Countdown timer is accurate
- [ ] Click copy → code copied to clipboard
- [ ] After 45 seconds → clipboard is cleared
- [ ] Multiple TOTP URIs → last valid one is used
- [ ] Invalid TOTP URI format → warning message shown (not crash)
- [ ] Custom period (60s) → refreshes correctly
- [ ] Long period (3600s = 1 hour) → countdown shows full hour
- [ ] Very long period (86400s = 24 hours) → handles correctly
- [ ] Import pass-otp archive → TOTP URIs preserved
- [ ] Entry with "otpauth://" in notes (not valid URI) → ignored
- [ ] Warning message is helpful, not alarming (yellow info box, not red error)

### TOTP (Time-based)

```
otpauth://totp/Example:user@example.com?secret=ABC123&issuer=Example
```

### With Custom Parameters

```
otpauth://totp/Example:user@example.com?secret=ABC123&issuer=Example&algorithm=SHA256&digits=8&period=60
```

## Troubleshooting

### TOTP code not showing?

1. Ensure the URI line starts with `otpauth://totp/` (exact prefix)
2. Ensure the URI contains a valid `secret` parameter
3. Check browser console for parsing errors

### Wrong code generated?

1. Verify the secret matches what the service provided
2. Check that your system clock is synchronized
3. Ensure the `period` value matches the service (usually 30)

### Code not refreshing?

1. Check the `period` parameter in the URI (default is 30 seconds)
2. Some services use 60-second periods
3. The countdown bar shows time remaining
