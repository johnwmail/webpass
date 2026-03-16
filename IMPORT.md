# 📥 Import Feature

Import encrypted password entries from a standard `.password-store` directory (compatible with `pass` CLI) or WebPass backup archives.

---

## Overview

The import feature allows users to migrate their existing password store into their WebPass account. The import process happens **entirely client-side** to maintain zero-knowledge guarantees.

**Supported Import Format:**

- **Tar.gz archive only** (`.tar.gz`, `.tgz`)
- Must contain `.password-store/` directory structure with `.gpg` files

**Supported Import Sources:**

1. **WebPass Export** — Backup from same or different WebPass account
2. **pass CLI Export** — Standard `.password-store` directory from `pass` password manager

**How to Create Tar.gz:**

```bash
# From pass CLI (~/.password-store/)
tar -czf backup.tar.gz ~/.password-store/

# From WebPass export
# Already in tar.gz format (no conversion needed)

# From Windows (7-Zip)
# Right-click folder → 7-Zip → Add to archive → .tar.gz

# From macOS
tar -czf backup.tar.gz ~/.password-store/
```

**Note:** Directory selection is NOT supported (browser compatibility). User must create tar.gz first.

**Key Design Principles:**

- **One consistent flow** — Same steps for all import scenarios
- **Always import private key** — User provides the key that encrypted the files
- **Client-side decryption** — All PGP decryption happens in the browser
- **Client-side re-encryption** — Entries are re-encrypted with the current account's WebPass key before upload
- **Zero-knowledge** — Server never sees plaintext passwords or private keys
- **Universal format** — Accepts standard `.password-store` tar.gz archives

---

## Import Scenarios

All scenarios use the **same import flow**:

```
1. User selects backup.tar.gz
2. User imports private key file (the key that encrypted these files)
3. User enters passphrase for that private key
4. Client decrypts with imported private key
5. Client re-encrypts with current account's public key
6. Upload to server
```

### Scenario 1: WebPass Backup Restore (Same Account)

```
User Account: Key-A (public + private)
Source: WebPass export encrypted with Key-A-public
Import To: SAME account (Key-A)
```

**Preparation (one-time):**
```
1. User exports their private key:
   Settings → Export Private Key → account-a-private.asc
```

**Import Flow:**
```
1. User exports from WebPass → password-store.tar.gz
2. Files encrypted with: Key-A-public
3. User imports to SAME account
4. User uploads: account-a-private.asc
5. User enters: Key-A passphrase
6. Client decrypts with: Key-A-private (imported, memory only)
7. Client re-encrypts with: Key-A-public (same account)
8. Server stores blobs
```

**Use Case:** "I accidentally deleted my entries, restore from backup"

---

### Scenario 2: WebPass Account Migration (Different Account)

```
User Account A: Key-A (public + private)
User Account B: Key-B (public + private)
Source: Account A export encrypted with Key-A-public
Import To: Account B (different key!)
```

**Preparation (one-time):**
```
1. Log into Account A
2. Export private key: Settings → Export Private Key → account-a-private.asc
```

**Import Flow:**
```
1. User exports from Account A → password-store.tar.gz
2. Files encrypted with: Key-A-public
3. User logs into Account B
4. User uploads: account-a-private.asc (from Account A)
5. User enters: Account A passphrase
6. Client decrypts with: Key-A-private (imported, memory only)
7. Client re-encrypts with: Key-B-public (current account)
8. Server stores blobs (now encrypted with Key-B)
```

**Use Case:** "Migrate from old WebPass account to new account"

---

### Scenario 3: pass CLI Migration

```
User's GPG Key: GPG-Key (created by `gpg --gen-key`)
WebPass Account: Key-B (created by WebPass signup)
Source: ~/.password-store/ encrypted with GPG-Key-public
Import To: WebPass Account B
```

**Preparation (one-time):**
```
1. Export GPG private key:
   gpg --export-secret-keys --armor user@example.com > secret.asc
```

**Import Flow:**
```
1. User creates tar from pass CLI:
   tar -czf backup.tar.gz ~/.password-store/
2. Files encrypted with: GPG-Key-public
3. User logs into WebPass Account B
4. User uploads: secret.asc (GPG private key)
5. User enters: GPG passphrase
6. Client decrypts with: GPG-Key-private (imported, memory only)
7. Client re-encrypts with: Key-B-public (WebPass account)
8. Server stores blobs (now encrypted with Key-B)
```

**Use Case:** "Migrate from pass CLI password manager to WebPass"

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                              │
│  + Preact UI (Import dialog, key import)                    │
│  + Tar.gz extraction (fflate library)                       │
│  + Private key import (always required)                     │
│  + PGP decrypt (imported private key)                       │
│  + PGP re-encrypt (current account public key)              │
│  + Batch upload to server                                   │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTPS + JWT
                 │ POST /api/{fingerprint}/import
                 │ Content-Type: application/json
                 │ [{ path, content: <armored PGP> }, ...]
┌────────────────▼────────────────────────────────────────────┐
│  Go API Server                                              │
│  + JWT authentication                                       │
│  + Parse JSON array                                         │
│  + Batch upsert entries                                     │
│  + SQLite storage                                           │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│  SQLite Database                                            │
│  └── entries (fingerprint, path, content)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Import Flow

### Step 1: User Initiates Import

```
User Action: Settings → "📥 Import .password-store" → Select file
File: backup.tar.gz (308 bytes, 3 entries)
```

---

### Step 2: User Imports Private Key

```
User uploads: account-a-private.asc OR secret.asc
User enters: passphrase for that key

Client: Read private key file into memory
Client: Decrypt private key with passphrase
  → Result: decrypted private key (in memory only)
  → Security: passphrase cleared from memory immediately
```

---

### Step 3: Extract Tar.gz

```
Client (fflate library):
1. Decompress gzip → tar archive
2. Parse tar headers
3. Extract all .gpg files:
   - Email/gmail.com.gpg (451 bytes)
   - Social/github.com.gpg (523 bytes)
   - Finance/bank.com.gpg (389 bytes)
4. Store in memory: [{path, content: Uint8Array}, ...]
```

---

### Step 4: Decrypt + Re-encrypt (Per File)

```
For each .gpg file:

1. Read encrypted blob (binary PGP message)

2. Decrypt with IMPORTED private key:
   - Result: plaintext password ("my-secret-password-123")

3. Re-encrypt with CURRENT ACCOUNT public key:
   - Result: new armored PGP message

4. Store: { path: "Email/gmail.com", content: "-----BEGIN PGP MESSAGE-----..." }
```

**Example:**
```
File: Email/gmail.com.gpg
Encrypted with: GPG-Key-public (external)
↓ Decrypt with: GPG-Key-private (imported from secret.asc)
Plaintext: "my-gmail-password-123"
↓ Re-encrypt with: Key-B-public (WebPass account)
New blob: "-----BEGIN PGP MESSAGE-----\nwcBMA..."
```

---

### Step 5: Batch Upload

```
Client: POST /api/{fingerprint}/import
Content-Type: application/json
Authorization: Bearer <jwt-token>

Body:
[
  {
    "path": "Email/gmail.com",
    "content": "-----BEGIN PGP MESSAGE-----\nwcBMA..."
  },
  {
    "path": "Social/github.com",
    "content": "-----BEGIN PGP MESSAGE-----\nwcBMA..."
  },
  {
    "path": "Finance/bank.com",
    "content": "-----BEGIN PGP MESSAGE-----\nwcBMA..."
  }
]
```

---

### Step 6: Server Processing

```go
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
    fp := r.PathValue("fp")

    // Parse JSON array
    var entries []struct {
        Path    string `json:"path"`
        Content []byte `json:"content"`
    }
    json.NewDecoder(r.Body).Decode(&entries)

    // Upsert each entry (INSERT or UPDATE if exists)
    var count int
    var errors []map[string]interface{}
    for _, e := range entries {
        err := s.Q.UpsertEntry(r.Context(), dbgen.UpsertEntryParams{
            Fingerprint: fp,
            Path:        e.Path,
            Content:     e.Content,
        })
        if err != nil {
            // Record error but CONTINUE processing (don't stop)
            errors = append(errors, map[string]interface{}{
                "path":  e.Path,
                "error": err.Error(),
            })
        } else {
            count++
        }
    }

    // Return partial success (never fail entire batch for individual errors)
    jsonOK(w, map[string]interface{}{
        "imported": count,
        "errors":   errors,
    })
}
```

**Behavior:**
- **Duplicate paths**: OVERWRITE existing entry (Upsert = UPDATE if exists, INSERT if new)
- **Individual failures**: CONTINUE processing remaining entries (don't stop/crash)
- **Response**: Report both successes AND failures (partial success)

---

### Step 7: UI Feedback + Cleanup

```
Progress States:

1. "Extracting archive... 0/3 files"
2. "Decrypting and re-encrypting... 1/3 entries"
3. "Decrypting and re-encrypting... 2/3 entries"
4. "Uploading to server... 3/3 entries"
5. "✓ Imported 3 entries successfully (1 overwritten)"

After Import Completes:
- Clear imported private key from memory (set to null)
- Clear any temporary variables
- Force garbage collection (if available)
- Close import dialog

**Note:** Duplicate entries are automatically overwritten (no warning).
```

---

## Security Model

### Key Management

| Key Type | Purpose | Storage | Lifetime |
|----------|---------|---------|----------|
| **Account Private Key** | Decrypt entries for viewing | IndexedDB (encrypted with password) | Persistent |
| **Account Public Key** | Re-encrypt imported entries | Server (users table) | Persistent |
| **Imported Private Key** | Decrypt imported .gpg files | **Memory only** | **Session only (cleared immediately after import)** |
| **Imported Passphrase** | Decrypt imported private key | **Memory only** | **Cleared immediately after decryption** |

### Critical Security Requirements

**Imported Private Key & Passphrase:**

- ❌ **NEVER persisted to disk** (no IndexedDB, localStorage, cookies)
- ❌ **NEVER sent to server** (only used client-side for decryption)
- ❌ **NEVER logged** (no console.log, no analytics)
- ✅ **Stored in JavaScript memory only** (RAM)
- ✅ **Cleared immediately after import completes** (explicit garbage collection)
- ✅ **Not accessible after page reload** (memory is cleared)

```javascript
// Example: Secure key handling
async function importWithKey(privateKeyFile, passphrase, entries) {
  let decryptedKey = null;
  
  try {
    // Decrypt private key in memory
    decryptedKey = await decryptPrivateKey(privateKeyFile, passphrase);
    
    // ⚠️ Clear passphrase from memory immediately
    passphrase = null;
    
    // Process entries
    const results = await processEntries(entries, decryptedKey);
    
    return results;
  } finally {
    // ⚠️ ALWAYS clear decrypted key, even on error
    decryptedKey = null;
    
    // ⚠️ Force garbage collection (if available)
    if (globalThis.gc) globalThis.gc();
  }
}
```

### Data Flow Security

| Stage | Location | Encryption |
|-------|----------|------------|
| **Source .gpg files** | Tar.gz archive | PGP (source key) |
| **Plaintext (briefly)** | Browser memory | Decrypted for ~50-100ms per file |
| **Re-encrypted blob** | Browser → Server | PGP (current account key) + HTTPS |
| **Server storage** | SQLite | PGP (current account key) |

### Zero-Knowledge Guarantee

- Server **never sees** plaintext passwords
- Server **never receives** private keys or passphrases
- Imported private key **never leaves** browser memory
- Imported passphrase **never leaves** browser memory
- Imported private key **cleared immediately** after import completes
- Imported passphrase **cleared immediately** after decrypting the key
- Re-encryption happens **entirely client-side**
- No key material is logged or sent to analytics

### Import Behavior

**Duplicate Handling (Overwrite):**
- If an entry with the same path already exists → **OVERWRITE** (no warning)
- This is intentional: allows users to update entries from backup
- No confirmation dialog (user explicitly chose to import)

**Partial Failure Handling:**
- If one entry fails → **CONTINUE** with remaining entries
- Import does NOT stop/crash on individual failures
- Failed entries are reported in the success dialog
- User can review errors and retry separately if needed

---

## Tech Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| **Tar.gz extraction** | `fflate` | Lightweight (~5KB gzipped), no native deps |
| **PGP crypto** | `openpgp` | Already in use for account operations |
| **Batch upload** | JSON API | Array of {path, content} |
| **Progress tracking** | Client-side counter | Update UI per-file |
| **Key storage** | IndexedDB (account), **Memory only** (imported) | **Imported key & passphrase NEVER persisted** |
| **Secure cleanup** | Explicit null + gc() | Clear keys from memory after import |

---

## API Endpoints

All endpoints require JWT authentication.

### New Endpoint (JSON Batch Import)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/{fingerprint}/import` | `[{ path, content }]` (JSON array) | Batch import with pre-encrypted entries |

**Request Body:**
```json
[
  {
    "path": "Email/gmail.com",
    "content": "-----BEGIN PGP MESSAGE-----\nwcBMAyH...base64...\n=abcd\n-----END PGP MESSAGE-----"
  },
  {
    "path": "Social/github.com",
    "content": "-----BEGIN PGP MESSAGE-----\nwcBMAyH...base64...\n=efgh\n-----END PGP MESSAGE-----"
  }
]
```

**Success Response (200 OK):**
```json
{
  "imported": 3,
  "errors": [],
  "overwritten": 1
}
```

**Partial Success Response (200 OK):**
```json
{
  "imported": 2,
  "errors": [
    {
      "path": "Finance/bank.com",
      "error": "Invalid PGP message format"
    }
  ],
  "overwritten": 0
}
```

**Note:** Server returns HTTP 200 even with errors (partial success). Client determines if user should be notified.

**Error Response (400 Bad Request):**
```json
{
  "error": "Invalid request format: 'content' field required for each entry"
}
```

---

## Frontend Components

### Import Dialog UI

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1: Select Archive                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ [📄] backup.tar.gz                           [Choose] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Step 2: Import Private Key                                 │
│  (The key that was used to encrypt these files)             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ [📄] secret.asc                              [Choose] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Step 3: Enter Passphrase                                   │
│  (For the private key above)                                │
│  [•••••••••••••••••••••••••••••••••••••••••••••••••]       │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  [ Cancel ]                          [ 📥 Import → ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Import Progress States

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Extracting archive...                                      │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░ 33%                    │
│  1/3 files extracted                                        │
│                                                             │
│  [ Cancel ]                                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Decrypting and re-encrypting...                            │
│  ████████████████░░░░░░░░░░░░░░░░ 66%                      │
│  2/3 entries processed                                      │
│                                                             │
│  • Email/gmail.com ✓                                        │
│  • Social/github.com ✓                                      │
│  • Finance/bank.com ...                                     │
│                                                             │
│  [ Cancel ]                                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ✓ Imported 3 entries successfully                          │
│  (1 entry was overwritten)                                  │
│                                                             │
│  [ Close ]                                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Error States

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ✗ Import Failed                                            │
│                                                             │
│  Invalid passphrase for private key.                        │
│  Please check your passphrase and try again.                │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  [ Cancel ]                    [ Retry with New Passphrase ]│
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│ 📥 Import Password Store                              [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ⚠ Partial Success (Import Completed with Warnings)         │
│                                                             │
│  Successfully imported 2 entries, 1 failed:                 │
│                                                             │
│  ✓ Email/gmail.com                                          │
│  ✓ Social/github.com                                        │
│  ✗ Finance/bank.com — Corrupted file                        │
│                                                             │
│  Note: Failed entries were skipped, not imported.           │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  [ Close ]                                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Partial success does NOT stop the import
- All valid entries are imported
- Failed entries are reported but don't block success
- User can review errors and retry separately if needed

---

## File Format Specification

### Tar.gz Structure

```
backup.tar.gz (gzip compressed tar archive)
└── .password-store/ (root directory in archive, optional)
    ├── <category>/ (subdirectory)
    │   ├── <entry>.gpg (PGP encrypted file)
    │   └── ...
    └── ...
```

### Path Handling

| Source Path | Stored Path | Notes |
|-------------|-------------|-------|
| `.password-store/Email/gmail.com.gpg` | `Email/gmail.com` | Strip `.password-store/` prefix and `.gpg` suffix |
| `.password-store/Social/github.gpg` | `Social/github` | Same |
| `Email/gmail.com.gpg` | `Email/gmail.com` | Handle missing root directory |
| `Finance/Credit Cards/chase.gpg` | `Finance/Credit Cards/chase` | Preserve subdirectories |

### Content Format

**Input (from tar.gz):**
- Binary PGP message (`.gpg` file)
- May be armored (text) or binary format

**Output (to server):**
- Armored PGP message (text with `-----BEGIN PGP MESSAGE-----` headers)
- Stored as UTF-8 string in JSON

---

## Error Handling

### Client-Side Errors

| Error | Cause | Handling |
|-------|-------|----------|
| `Invalid archive` | Not a valid tar.gz | Show error, abort import |
| `No .gpg files found` | Empty archive or wrong format | Show error, abort import |
| `Invalid private key` | Corrupted or wrong format key file | Show error, abort import |
| `Decryption failed` | Wrong passphrase | Prompt for passphrase again |
| `Re-encryption failed` | Invalid account public key | Show error, abort import |
| `Upload failed` | Network error or JWT expired | Retry with re-authentication |

### Server-Side Errors

| Error | Cause | Handling |
|-------|-------|----------|
| `Invalid JSON` | Malformed request body | Return 400, client shows error |
| `Invalid content` | Not valid PGP message | Return partial success with per-entry errors |
| `Database error` | SQLite constraint or connection | Return 500, abort all |
| `JWT invalid` | Expired or missing token | Return 401, client prompts re-login |

---

## Build Phases

| # | Phase | Deliverable | Estimated Time |
|---|-------|-------------|----------------|
| 1 | Add `fflate` dependency | Update `frontend/package.json` | 15 min |
| 2 | Tar.gz extraction utility | `frontend/src/lib/tar.ts` | 2 hours |
| 3 | Private key import | `frontend/src/lib/crypto.ts` (new function) | 1 hour |
| 4 | Decrypt + re-encrypt flow | `frontend/src/lib/import.ts` | 3 hours |
| 5 | Import dialog UI | `frontend/src/components/ImportDialog.tsx` | 3 hours |
| 6 | Backend endpoint update | `srv/server.go` (modify `handleImport`) | 1 hour |
| 7 | Progress tracking | UI updates during import | 1 hour |
| 8 | Error handling | Retry logic, partial success | 1 hour |
| 9 | Polish | Toasts, loading states, success messages | 1 hour |
| 10 | **Security cleanup** | **Clear keys from memory after import** | **30 min** |
| 11 | Testing | Manual + automated tests | 2 hours |
| **Total** | | | **~16 hours** |

---

## Migration Scenarios

### Scenario 1: Same-Account Backup Restore

```bash
# Step 1: Export your private key (one-time)
# - Settings → Export Private Key → account-a-private.asc

# Step 2: Export your data
# - Settings → Export All → password-store.tar.gz

# Step 3: Import backup
# - Settings → Import
# - Select password-store.tar.gz
# - Upload account-a-private.asc
# - Enter your passphrase
# - Wait for import to complete

# Result: Backup restored
```

**Use Case:** "I accidentally deleted my entries, restore from backup"

---

### Scenario 2: Different Key (Account Migration or pass CLI)

```bash
# Step 1: Export the private key that encrypted the files
#
# Option A - WebPass Account A:
#   - Log into Account A
#   - Settings → Export Private Key → account-a-private.asc
#
# Option B - pass CLI:
#   - gpg --export-secret-keys --armor user@example.com > secret.asc

# Step 2: Create tar.gz from source
#
# Option A - WebPass Account A:
#   - Settings → Export All → password-store.tar.gz
#
# Option B - pass CLI:
#   - tar -czf backup.tar.gz ~/.password-store/

# Step 3: Import to current WebPass account
# - Log into current account
# - Settings → Import
# - Select backup.tar.gz
# - Upload private key (account-a-private.asc OR secret.asc)
# - Enter the passphrase for that private key
# - Wait for import to complete

# Result: All entries now encrypted with current account's key
```

**Use Cases:**
- "Migrate from old WebPass account to new account"
- "Migrate from pass CLI password manager to WebPass"

---

### Scenario 3: Bulk Import (First-Time Setup)

```bash
# Step 1: User has existing ~/.password-store/ from pass CLI
# Step 2: Create new WebPass account (generates new keypair)
# Step 3: Export GPG private key
# - gpg --export-secret-keys --armor > secret.asc
# Step 4: Import pass CLI store to WebPass
# - Settings → Import
# - Select backup.tar.gz (from ~/.password-store/)
# - Upload secret.asc
# - Enter GPG passphrase
# - Wait for import to complete

# Result: All pass CLI passwords now in WebPass, encrypted with WebPass key
```

**Use Case:** "First-time WebPass setup, migrate all existing passwords"

---

## Testing Checklist

### Functional Tests

- [ ] Import empty archive (should show "0 entries imported")
- [ ] Import archive with 1 entry
- [ ] Import archive with 100+ entries (performance test)
- [ ] Import with wrong private key file (should fail gracefully)
- [ ] Import with wrong passphrase (should prompt again)
- [ ] Import nested directories (e.g., `Finance/Credit Cards/chase.gpg`)
- [ ] Import with special characters in paths (e.g., `Work/Project "Alpha"/api.gpg`)
- [ ] Import partial failure (some files corrupt, others succeed)
- [ ] Import during slow network (timeout handling)
- [ ] Import with expired JWT session (re-auth flow)
- [ ] **Import duplicate paths (should overwrite without warning)**
- [ ] **Import with all failures (should show error, not crash)**
- [ ] **Import with mixed success/failure (should import valid, report invalid)**

### Security Tests

- [ ] Verify imported private key is NOT in IndexedDB after import
- [ ] Verify imported private key is NOT in localStorage after import
- [ ] Verify passphrase is cleared from memory after key decryption
- [ ] Verify private key is cleared from memory after import completes
- [ ] Verify no key material is logged to console
- [ ] Verify no key material is sent in network requests (only re-encrypted blobs)
- [ ] Verify page reload loses imported key (must re-import)
- [ ] Verify import error paths still clear keys (finally block)

### Key Scenarios

- [ ] Same-account restore (import own private key)
- [ ] Different WebPass account (import other account's private key)
- [ ] pass CLI migration (import GPG private key)

### Edge Cases

- [ ] Archive with no `.gpg` extension files
- [ ] Archive with `.gpg` suffix in path (e.g., `Email/gmail.com.gpg.gpg`)
- [ ] Very large entry (>1MB)
- [ ] Duplicate paths (same path appears twice in archive)
- [ ] Empty `.gpg` files (0 bytes)
- [ ] Armored vs binary PGP format

---

## Automated Test Suite (chromedp)

### Test File Structure

```
cmd/test-import/
├── main.go              # Test runner
├── scenarios/
│   ├── same_account.go     # Scenario 1: Same account restore
│   ├── different_account.go # Scenario 2: Account migration
│   └── pass_cli.go         # Scenario 3: pass CLI migration
├── fixtures/
│   ├── same-account.tar.gz
│   ├── different-account.tar.gz
│   ├── pass-cli.tar.gz
│   ├── empty.tar.gz
│   ├── large.tar.gz (100+ entries)
│   └── corrupted.tar.gz
└── testdata/
    ├── account-a-private.asc
    ├── account-b-private.asc
    └── gpg-secret.asc
```

### Test Helper Functions

```go
// cmd/test-import/helpers.go

package main

import (
    "context"
    "fmt"
    "os"
    "time"
    "github.com/chromedp/chromedp"
)

// startChrome launches Chrome in headless mode
func startChrome(ctx context.Context) (context.Context, context.CancelFunc) {
    opts := append(chromedp.DefaultExecAllocatorOptions[:],
        chromedp.ExecPath("/bin/google-chrome"),
        chromedp.Flag("headless", true),
        chromedp.Flag("no-sandbox", true),
        chromedp.Flag("disable-gpu", true),
        chromedp.Flag("disable-dev-shm-usage", true),
    )
    return chromedp.NewExecAllocator(context.Background(), opts...)
}

// createTestAccount creates a new WebPass account for testing
func createTestAccount(ctx context.Context, baseURL, email, password string) error {
    // Navigate to setup page, fill form, submit
    // Wait for main app to load
}

// loginToAccount logs into an existing account
func loginToAccount(ctx context.Context, baseURL, email, password string) error {
    // Navigate to login page, fill form, submit
    // Wait for main app to load
}

// openImportDialog opens the import dialog
func openImportDialog(ctx context.Context) error {
    // Click Settings button
    // Click "Import .password-store" button
    // Wait for modal to appear
}

// uploadFiles uploads multiple files in the import dialog
func uploadFiles(ctx context.Context, archivePath, keyPath string) error {
    // Set archive file input
    // Set private key file input
}

// enterPassphrase enters the passphrase field
func enterPassphrase(ctx context.Context, passphrase string) error {
    // Fill passphrase input
}

// clickImport clicks the import button and waits for completion
func clickImport(ctx context.Context) (ImportResult, error) {
    // Click import button
    // Wait for progress to complete
    // Parse result from dialog
}

// ImportResult holds the import test result
type ImportResult struct {
    Success     bool
    Imported    int
    Overwritten int
    Errors      []string
}
```

### Test Scenario 1: Same Account Restore

```go
// cmd/test-import/scenarios/same_account.go

func TestSameAccountRestore(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    password := "testpass123"
    
    // Setup: Create account and export data
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Step 1: Create account
    err := createTestAccount(ctx, baseURL, "test-same@example.com", password)
    if err != nil {
        t.Fatalf("Failed to create account: %v", err)
    }
    
    // Step 2: Export data (create backup)
    backupPath := "/tmp/test-backup.tar.gz"
    err = exportData(ctx, backupPath)
    if err != nil {
        t.Fatalf("Failed to export: %v", err)
    }
    
    // Step 3: Export private key
    keyPath := "/tmp/test-private.asc"
    err = exportPrivateKey(ctx, keyPath)
    if err != nil {
        t.Fatalf("Failed to export key: %v", err)
    }
    
    // Step 4: Delete all entries (simulate data loss)
    err = deleteAllEntries(ctx)
    if err != nil {
        t.Fatalf("Failed to delete entries: %v", err)
    }
    
    // Step 5: Import backup
    err = openImportDialog(ctx)
    if err != nil {
        t.Fatalf("Failed to open import: %v", err)
    }
    
    err = uploadFiles(ctx, backupPath, keyPath)
    if err != nil {
        t.Fatalf("Failed to upload files: %v", err)
    }
    
    err = enterPassphrase(ctx, password)
    if err != nil {
        t.Fatalf("Failed to enter passphrase: %v", err)
    }
    
    result, err := clickImport(ctx)
    if err != nil {
        t.Fatalf("Import failed: %v", err)
    }
    
    // Verify result
    if result.Imported != 3 {
        t.Errorf("Expected 3 entries, got %d", result.Imported)
    }
    
    // Verify entries exist
    count, err := getEntryCount(ctx)
    if err != nil {
        t.Fatalf("Failed to count entries: %v", err)
    }
    if count != 3 {
        t.Errorf("Expected 3 entries after import, got %d", count)
    }
}
```

### Test Scenario 2: Account Migration

```go
// cmd/test-import/scenarios/different_account.go

func TestAccountMigration(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    passwordA := "passA123"
    passwordB := "passB123"
    
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Step 1: Create Account A with data
    err := createTestAccount(ctx, baseURL, "account-a@example.com", passwordA)
    if err != nil {
        t.Fatalf("Failed to create account A: %v", err)
    }
    
    // Add test entries to Account A
    err = addEntry(ctx, "Email/test", "test-password")
    if err != nil {
        t.Fatalf("Failed to add entry: %v", err)
    }
    
    // Step 2: Export Account A data and key
    backupPath := "/tmp/account-a-backup.tar.gz"
    keyPath := "/tmp/account-a-private.asc"
    
    err = exportData(ctx, backupPath)
    if err != nil {
        t.Fatalf("Failed to export: %v", err)
    }
    
    err = exportPrivateKey(ctx, keyPath)
    if err != nil {
        t.Fatalf("Failed to export key: %v", err)
    }
    
    // Step 3: Logout and create Account B
    err = logout(ctx)
    if err != nil {
        t.Fatalf("Failed to logout: %v", err)
    }
    
    err = createTestAccount(ctx, baseURL, "account-b@example.com", passwordB)
    if err != nil {
        t.Fatalf("Failed to create account B: %v", err)
    }
    
    // Step 4: Import Account A's data into Account B
    err = openImportDialog(ctx)
    if err != nil {
        t.Fatalf("Failed to open import: %v", err)
    }
    
    err = uploadFiles(ctx, backupPath, keyPath)
    if err != nil {
        t.Fatalf("Failed to upload files: %v", err)
    }
    
    // Enter Account A's passphrase (not B's!)
    err = enterPassphrase(ctx, passwordA)
    if err != nil {
        t.Fatalf("Failed to enter passphrase: %v", err)
    }
    
    result, err := clickImport(ctx)
    if err != nil {
        t.Fatalf("Import failed: %v", err)
    }
    
    // Verify: Entry should be re-encrypted with Account B's key
    if result.Imported != 1 {
        t.Errorf("Expected 1 entry, got %d", result.Imported)
    }
    
    // Verify: Can decrypt with Account B's key
    content, err := decryptEntry(ctx, "Email/test")
    if err != nil {
        t.Fatalf("Failed to decrypt: %v", err)
    }
    if content != "test-password" {
        t.Errorf("Wrong content: %s", content)
    }
}
```

### Test Scenario 3: pass CLI Migration

```go
// cmd/test-import/scenarios/pass_cli.go

func TestPassCLIMigration(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    password := "webpass123"
    gpgPassphrase := "gpg-pass-123"
    
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Step 1: Create test .password-store with GPG
    backupPath, keyPath := createPassCLIStore(t, gpgPassphrase)
    defer os.Remove(backupPath)
    defer os.Remove(keyPath)
    
    // Step 2: Create WebPass account
    err := createTestAccount(ctx, baseURL, "pass-migration@example.com", password)
    if err != nil {
        t.Fatalf("Failed to create account: %v", err)
    }
    
    // Step 3: Import pass CLI store
    err = openImportDialog(ctx)
    if err != nil {
        t.Fatalf("Failed to open import: %v", err)
    }
    
    err = uploadFiles(ctx, backupPath, keyPath)
    if err != nil {
        t.Fatalf("Failed to upload files: %v", err)
    }
    
    err = enterPassphrase(ctx, gpgPassphrase)
    if err != nil {
        t.Fatalf("Failed to enter passphrase: %v", err)
    }
    
    result, err := clickImport(ctx)
    if err != nil {
        t.Fatalf("Import failed: %v", err)
    }
    
    // Verify: All entries imported
    if result.Imported != 3 {
        t.Errorf("Expected 3 entries, got %d", result.Imported)
    }
}

// createPassCLIStore creates a test .password-store with GPG encryption
func createPassCLIStore(t *testing.T, passphrase string) (backupPath, keyPath string) {
    // Generate GPG key
    // Create test entries
    // Encrypt with GPG
    // Create tar.gz
    // Export private key
    return backupPath, keyPath
}
```

### Test Scenario 4: Partial Failure

```go
// cmd/test-import/scenarios/partial_failure.go

func TestPartialFailure(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    password := "testpass123"
    
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Create account
    err := createTestAccount(ctx, baseURL, "partial-test@example.com", password)
    if err != nil {
        t.Fatalf("Failed to create account: %v", err)
    }
    
    // Create archive with 2 valid + 1 corrupted entry
    backupPath := createCorruptedArchive(t)
    keyPath := exportTestKey(t, password)
    
    // Import
    err = openImportDialog(ctx)
    err = uploadFiles(ctx, backupPath, keyPath)
    err = enterPassphrase(ctx, password)
    
    result, err := clickImport(ctx)
    if err != nil {
        t.Fatalf("Import should not fail completely: %v", err)
    }
    
    // Verify: Partial success
    if result.Imported != 2 {
        t.Errorf("Expected 2 entries (partial), got %d", result.Imported)
    }
    
    if len(result.Errors) != 1 {
        t.Errorf("Expected 1 error, got %d", len(result.Errors))
    }
    
    // Verify: Error message shown to user
    err = verifyPartialSuccessDialog(ctx, result)
    if err != nil {
        t.Errorf("Partial success dialog not shown correctly: %v", err)
    }
}
```

### Test Scenario 5: Duplicate Overwrite

```go
// cmd/test-import/scenarios/duplicate_overwrite.go

func TestDuplicateOverwrite(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    password := "testpass123"
    
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Create account with existing entry
    err := createTestAccount(ctx, baseURL, "duplicate-test@example.com", password)
    if err != nil {
        t.Fatalf("Failed to create account: %v", err)
    }
    
    err = addEntry(ctx, "Email/existing", "old-password")
    if err != nil {
        t.Fatalf("Failed to add entry: %v", err)
    }
    
    // Create archive with same path but different content
    backupPath := createArchiveWithEntry(t, "Email/existing", "new-password")
    keyPath := exportTestKey(t, password)
    
    // Import
    err = openImportDialog(ctx)
    err = uploadFiles(ctx, backupPath, keyPath)
    err = enterPassphrase(ctx, password)
    
    result, err := clickImport(ctx)
    if err != nil {
        t.Fatalf("Import failed: %v", err)
    }
    
    // Verify: Overwritten (not error)
    if result.Overwritten != 1 {
        t.Errorf("Expected 1 overwritten, got %d", result.Overwritten)
    }
    
    // Verify: Content is new value
    content, err := decryptEntry(ctx, "Email/existing")
    if err != nil {
        t.Fatalf("Failed to decrypt: %v", err)
    }
    if content != "new-password" {
        t.Errorf("Expected new-password, got: %s", content)
    }
}
```

### Test Scenario 6: Security - Key Cleanup

```go
// cmd/test-import/scenarios/security_cleanup.go

func TestKeyCleanup(t *testing.T) {
    baseURL := os.Getenv("TEST_BASE_URL")
    password := "testpass123"
    
    allocCtx, cancel := startChrome(t.Context())
    defer cancel()
    
    ctx, cancel := chromedp.NewContext(allocCtx)
    defer cancel()
    
    // Create account and import
    err := createTestAccount(ctx, baseURL, "security-test@example.com", password)
    
    backupPath := createTestArchive(t)
    keyPath := exportTestKey(t, password)
    
    err = openImportDialog(ctx)
    err = uploadFiles(ctx, backupPath, keyPath)
    err = enterPassphrase(ctx, password)
    _, err = clickImport(ctx)
    
    // Close dialog
    err = closeImportDialog(ctx)
    
    // Verify: Key not in IndexedDB
    hasKey, err := checkIndexedDB(ctx, "importedPrivateKey")
    if err != nil {
        t.Fatalf("Failed to check IndexedDB: %v", err)
    }
    if hasKey {
        t.Error("SECURITY: Private key found in IndexedDB after import!")
    }
    
    // Verify: Key not in localStorage
    hasKey, err = checkLocalStorage(ctx, "importedPrivateKey")
    if err != nil {
        t.Fatalf("Failed to check localStorage: %v", err)
    }
    if hasKey {
        t.Error("SECURITY: Private key found in localStorage after import!")
    }
    
    // Verify: Passphrase cleared
    hasPass, err := checkMemoryForPassphrase(ctx)
    if err != nil {
        t.Logf("Warning: Could not verify passphrase cleanup: %v", err)
    }
    if hasPass {
        t.Error("SECURITY: Passphrase still in memory after import!")
    }
}
```

### Running the Tests

```bash
# Run all import tests
cd /path/to/webpass
go test -v ./cmd/test-import/... \
    -TEST_BASE_URL=http://localhost:8080 \
    -TEST_PASSWORD=testpass123

# Run specific test
go test -v ./cmd/test-import/... \
    -run TestSameAccountRestore \
    -TEST_BASE_URL=http://localhost:8080

# Run with visible browser for debugging
go test -v ./cmd/test-import/... \
    -HEADLESS=false \
    -TEST_BASE_URL=http://localhost:8080
```

### Test Fixtures Generation

```go
// cmd/test-import/fixtures/generate.go

// Generate test tar.gz files for all scenarios
func main() {
    // 1. Same account backup
    generateSameAccountBackup("fixtures/same-account.tar.gz")
    
    // 2. Different account backup
    generateDifferentAccountBackup("fixtures/different-account.tar.gz")
    
    // 3. pass CLI backup
    generatePassCLIBackup("fixtures/pass-cli.tar.gz")
    
    // 4. Empty archive
    generateEmptyArchive("fixtures/empty.tar.gz")
    
    // 5. Large archive (100+ entries)
    generateLargeArchive("fixtures/large.tar.gz")
    
    // 6. Corrupted archive
    generateCorruptedArchive("fixtures/corrupted.tar.gz")
    
    fmt.Println("Generated all test fixtures")
}
```

---

## Future Enhancements

| Feature | Description | Priority |
|---------|-------------|----------|
| **Drag & drop** | Drag tar.gz and private key files onto dialog | Low |
| **Preview before import** | Show list of entries before importing | Medium |
| **Selective import** | Checkbox to import only specific entries | Low |
| **Conflict resolution** | Handle duplicate paths (skip/overwrite/merge) | Medium |
| **Key import wizard** | Guided flow for first-time users | Low |
| **Remember last key** | Cache imported key for session (optional) | Low |

---

## Appendix: Key Differences from Current Implementation

| Aspect | Current | New (Simplified) |
|--------|---------|-------------------|
| **Input format** | Binary tar.gz | JSON array |
| **Tar parsing** | Server-side (Go) | Client-side (fflate) |
| **Private key** | Not required (uses account key) | Always required (imported) |
| **Decryption** | None (server stores as-is) | Client-side (imported key) |
| **Re-encryption** | None | Client-side (with account public key) |
| **Use cases** | WebPass backup only | WebPass + pass CLI + account migration |
| **Flow** | Different per scenario | Same for ALL scenarios |
| **Zero-knowledge** | Partial (server sees blobs) | Full (server never sees plaintext) |
