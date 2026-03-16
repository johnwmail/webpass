# 🔐 WebPass — Web-Based Password Manager

A web clone of [pass (the standard unix password manager)](https://www.passwordstore.org/).
All cryptography happens client-side in the browser using OpenPGP.js.
The server is a dumb encrypted-blob store — it never sees plaintext passwords or private keys.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Cloudflare Pages (*.pages.dev)     │
│  + custom domain (webpass.example.com)
│                                     │
│  Static SPA: Preact + OpenPGP.js   │
│  IndexedDB: AES-wrapped PGP key    │
└──────────────┬──────────────────────┘
               │ HTTPS + CORS
┌──────────────▼──────────────────────┐
│  exe.dev VM — Go API                │
│  https://webpass.exe.xyz:8000/api/  │
│                                     │
│  SQLite: encrypted .gpg blobs       │
│  Auth: bcrypt + JWT (5-min)         │
│  Git Sync: manual push/pull         │
│  CORS_ORIGINS env var               │
└──────────────┬──────────────────────┘
               │ HTTPS + PAT
┌──────────────▼──────────────────────┐
│  Remote Git Repo (GitHub/GitLab)    │
│  └── .password-store/               │
│      └── *.gpg (encrypted blobs)    │
└─────────────────────────────────────┘
```

---

## Tech Stack

| Layer    | Choice                                           |
| -------- | ------------------------------------------------ |
| Frontend | TypeScript + Preact + Vite                       |
| Crypto   | OpenPGP.js (PGP) + Web Crypto API (PBKDF2 / AES) |
| Backend  | Go + SQLite + Git CLI                            |
| Hosting  | Cloudflare Pages (frontend) + exe.dev VM (API)   |
| Git Sync | Manual push/pull to any Git repo (GitHub, GitLab, Gitea) |

---

## Auth & Session Flow

### First-Time Setup

```
1. User enters API server URL + picks a password
2. Browser generates PGP keypair (OpenPGP.js) — or imports existing key
3. password → PBKDF2 → AES key → encrypt { private key, API URL } → store in IndexedDB
4. POST /api { password, publicKey }
   → server stores bcrypt(password) + public key → returns { fingerprint }
5. Server prompts: enable 2FA? → generate TOTP secret → show QR code
   → user scans with authenticator app → confirms with code
6. Done — redirect to login
```

### Login (every session, max 5 minutes)

```
User enters password
       │
       ▼
1. Client-side: password → PBKDF2 → AES key
   → try decrypt PGP private key from IndexedDB
       │
       ├── FAIL → "Wrong password" (never touches server)
       │
       └── OK → decrypted PGP key held in JS memory only
                   │
                   ▼
            2. POST /api/{fingerprint}/login { password }
               → server verifies bcrypt hash
               → returns JWT (5-min expiry)
                   │
                   ▼
            3. App unlocked.
               - JWT used for all API calls (Authorization header)
               - In-memory PGP key used for encrypt/decrypt

After 5 min → clear in-memory PGP key + discard JWT → must re-login
```

---

## Data Model (SQLite)

```sql
CREATE TABLE entries (
    id      INTEGER PRIMARY KEY,
    path    TEXT NOT NULL UNIQUE,   -- e.g. "Email/zx2c4.com"
    content BLOB NOT NULL,          -- PGP-encrypted (.gpg) binary
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- settings keys: "password_hash", "public_key"

-- Git Sync configuration (per user)
CREATE TABLE git_config (
    fingerprint       TEXT PRIMARY KEY REFERENCES users(fingerprint) ON DELETE CASCADE,
    repo_url          TEXT NOT NULL,               -- HTTPS URL to git repo
    encrypted_pat     TEXT NOT NULL,               -- PGP-encrypted PAT blob
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Git Sync operation log
CREATE TABLE git_sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint     TEXT NOT NULL REFERENCES users(fingerprint) ON DELETE CASCADE,
    operation       TEXT NOT NULL,                 -- 'push', 'pull'
    status          TEXT NOT NULL,                 -- 'success', 'failed'
    message         TEXT,                          -- Error or commit message
    entries_changed INTEGER DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## API Endpoints

All endpoints under `/api/`. JWT required for all except setup and login.

### Authentication & Users

| Method | Path                | Auth | Description                          |
| ------ | ------------------- | ---- | ------------------------------------ |
| POST   | `/api`              | No   | First-time: set password + public key |
| POST   | `/api/{fingerprint}/login`        | No   | Verify password → return JWT         |

### Entries (Password Store)

| Method | Path                    | Auth | Description                          |
| ------ | ----------------------- | ---- | ------------------------------------ |
| GET    | `/api/{fingerprint}/entries`          | JWT  | List all entry paths (tree)          |
| GET    | `/api/{fingerprint}/entries/*path`    | JWT  | Download encrypted .gpg blob         |
| PUT    | `/api/{fingerprint}/entries/*path`    | JWT  | Upload encrypted .gpg blob           |
| DELETE | `/api/{fingerprint}/entries/*path`    | JWT  | Delete entry                         |
| POST   | `/api/{fingerprint}/entries/move`     | JWT  | Rename/move entry `{ from, to }`     |

### Git Sync

| Method | Path                          | Auth | Description                              |
| ------ | ----------------------------- | ---- | ---------------------------------------- |
| GET    | `/api/{fingerprint}/git/status`        | JWT  | Get sync status (repo URL, last sync)    |
| POST   | `/api/{fingerprint}/git/config`        | JWT  | Configure git sync `{ repo_url, encrypted_pat }` |
| POST   | `/api/{fingerprint}/git/session`       | JWT  | Set plaintext git token for current session |
| POST   | `/api/{fingerprint}/git/push`          | JWT  | Manual push to remote (optional `{ token }`) |
| POST   | `/api/{fingerprint}/git/pull`          | JWT  | Manual pull from remote (optional `{ token }`) |
| GET    | `/api/{fingerprint}/git/log`           | JWT  | Get sync operation history (last 50)     |

### CORS

Configured via environment variable:

```
CORS_ORIGINS=https://your-project.pages.dev,https://webpass.example.com
```

---

## Frontend Pages

| Page           | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| **Setup**      | First-time only: pick password, generate PGP keypair           |
| **Login**      | Enter password → decrypt local key → obtain JWT                |
| **Tree View**  | Hierarchical folder/entry list (like `pass` output)            |
| **View Entry** | Decrypt + display, copy-to-clipboard with 45s auto-clear       |
| **Add/Edit**   | Single-line or multi-line input, encrypt client-side, upload   |
| **Generator**  | Random password generator (configurable length, symbols toggle) |
| **Key Export** | Export/import AES-wrapped private key (for backup or new browser) |
| **Settings**   | Account info, Git Sync config, key management, API URL         |

---

## Security Model

- **Private key never leaves the browser** — stored AES-wrapped in IndexedDB
- **Server stores only PGP-encrypted blobs** — a database leak reveals nothing
- **Password validates locally first** (decrypt key), then on server (bcrypt + JWT)
- **5-min session** enforced both client-side (clear JS memory) and server-side (JWT expiry)
- **CORS locked** to specific origins via env var
- **All traffic over HTTPS** — Cloudflare Pages + exe.dev proxy

---

## Build Phases

| #   | Phase               | Deliverable                                          |
| --- | ------------------- | ---------------------------------------------------- |
| 1   | Go backend          | SQLite schema, auth (bcrypt + JWT), CRUD API, CORS |
| 2   | Frontend scaffold   | Vite + Preact project, routing, login & setup screens |
| 3   | Crypto core         | OpenPGP.js keygen, PBKDF2/AES wrap/unwrap, encrypt/decrypt round-trip |
| 4   | CRUD UI             | Tree view, add/edit/delete entries, clipboard, password generator |
| 5   | Deploy              | Cloudflare Pages config (wrangler), Docker container    |

---

## Decisions Made

- **Cloudflare Pages**: project name TBD (e.g. `webpass.pages.dev`)
- **Custom domain**: Yes (`webpass.example.com`)
- **Import/Export**: Yes — tar/zip of `.password-store` directory
- **PGP key type**: ECC Curve25519 (default)
- **Password generator**: Yes, random passwords
- **Responsive**: Mobile + desktop
- **Multi-user**: Yes (see below)
- **PGP key management**: Create / import / export public & private keys

---

## Multi-User Model

PGP key fingerprint = user ID. No usernames needed.

```
Server stores:
  /users/:fingerprint/password_hash   (bcrypt)
  /users/:fingerprint/public_key      (PGP public key)
  /users/:fingerprint/entries/*        (encrypted blobs)

Browser stores (IndexedDB, per fingerprint):
  AES-wrapped PGP private key
```

### Updated API

| Method | Path                                    | Auth | Description                            |
| ------ | --------------------------------------- | ---- | -------------------------------------- |
| POST   | `/api`                            | No   | Setup: create user `{ password, publicKey }` → returns `{ fingerprint }` |
| POST   | `/api/{fingerprint}/login`                  | No   | Verify password → return JWT (5-min)   |
| GET    | `/api/{fingerprint}/entries`                | JWT  | List all entry paths                   |
| GET    | `/api/{fingerprint}/entries/*path`          | JWT  | Download encrypted .gpg blob           |
| PUT    | `/api/{fingerprint}/entries/*path`          | JWT  | Upload encrypted .gpg blob             |
| DELETE | `/api/{fingerprint}/entries/*path`          | JWT  | Delete entry                           |
| POST   | `/api/{fingerprint}/entries/move`           | JWT  | Rename/move `{ from, to }`             |
| POST   | `/api/{fingerprint}/import`                 | JWT  | Import tar/zip of .password-store      |
| GET    | `/api/{fingerprint}/export`                 | JWT  | Export tar/zip of .password-store      |

### Updated Data Model

```sql
CREATE TABLE users (
    fingerprint TEXT PRIMARY KEY,       -- PGP key fingerprint
    password_hash TEXT NOT NULL,         -- bcrypt
    public_key TEXT NOT NULL,            -- PGP public key (armored)
    created DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entries (
    id          INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL REFERENCES users(fingerprint),
    path        TEXT NOT NULL,           -- e.g. "Email/zx2c4.com"
    content     BLOB NOT NULL,           -- PGP-encrypted blob
    created     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(fingerprint, path)
);
```

---

## UI Screens (Wireframes)

### Screen 1: Welcome (unauthenticated)

Single clean page. Password input + two buttons.

```
┌─────────────────────────────────────┐
│           🔐 WebPass                │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ Password                    │   │
│   └─────────────────────────────┘   │
│                                     │
│   [ Login ]          [ Setup → ]    │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ Accounts (from IndexedDB):  │   │
│   │  • a1b2c3...d4e5 (active)   │   │
│   │  • f6g7h8...i9j0            │   │
│   │  + Add existing key         │   │
│   └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

- **Account list**: shows stored key fingerprints from IndexedDB (truncated)
- User selects an account (or it defaults to the only one)
- **Login**: decrypt local key → POST login → enter app
- **Setup →**: goes to setup flow (Screen 2)

### Screen 2: Setup Flow (4 steps)

```
┌─────────────────────────────────────┐
│        🔐 WebPass — Setup           │
│                                     │
│  Step 1 of 4: API Server            │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ https://webpass.exe.xyz:8000 │   │
│   └─────────────────────────────┘   │
│                                     │
│   [ Next → ]                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│        🔐 WebPass — Setup           │
│                                     │
│  Step 2 of 4: Choose Password       │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ Password                    │   │
│   └─────────────────────────────┘   │
│   ┌─────────────────────────────┐   │
│   │ Confirm Password            │   │
│   └─────────────────────────────┘   │
│                                     │
│   [ ← Back ]        [ Next → ]     │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│        🔐 WebPass — Setup           │
│                                     │
│  Step 3 of 4: PGP Key              │
│                                     │
│   ○ Generate new keypair            │
│   ○ Import existing private key     │
│                                     │
│   (if import: file picker or        │
│    paste armored key → enter        │
│    import passphrase → re-encrypt   │
│    with WebPass password)           │
│                                     │
│   [ ← Back ]        [ Next → ]     │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│        🔐 WebPass — Setup           │
│                                     │
│  Step 4 of 4: Confirm & 2FA        │
│                                     │
│  API: https://webpass.exe.xyz:8000  │
│  Fingerprint: A1B2 C3D4 ... E5F6   │
│  Key type: ECC Curve25519           │
│                                     │
│  ⚠ Save your password! It cannot   │
│    be recovered if lost.            │
│                                     │
│  ┌─────────────────────────────┐  │
│  │ Enable 2FA (recommended)      │  │
│  │                               │  │
│  │  [QR CODE]   Scan with your   │  │
│  │              authenticator    │  │
│  │                               │  │
│  │  ┌───────────────────────┐  │  │
│  │  │ Enter 6-digit code      │  │  │
│  │  └───────────────────────┘  │  │
│  │                               │  │
│  │  [ Skip for now ]             │  │
│  └─────────────────────────────┘  │
│                                     │
│  [ ← Back ]        [ Complete ✓ ]   │
└─────────────────────────────────────┘
```

- Step 1: API server URL
- Step 2: password + confirm
- Step 3: generate or import PGP key
- Step 4: review + optional 2FA setup → POST `/api` → store encrypted data in IndexedDB → redirect to login

### Screen 3: Main App (authenticated)

```
┌─────────────────────────────────────────────────┐
│  🔐 WebPass              [Generate] [⚙] [Lock]  │
├────────────────┬────────────────────────────────┤
│ 🔍 Search...   │                                │
│                │   Select an entry              │
│ Password Store │   or create a new one          │
│ ├── Business   │                                │
│ │   ├── site1  │                                │
│ │   └── site2  │                                │
│ ├── Email      │                                │
│ │   ├── gmail  │                                │
│ │   └── work   │                                │
│ └── Social     │                                │
│     ├── twitter│                                │
│     └── github │                                │
│                │                                │
│ [+ New Entry]  │                                │
│ [+ New Folder] │                                │
├────────────────┴────────────────────────────────┤
│ ⏱ Session: 4:32 remaining                       │
└─────────────────────────────────────────────────┘
```

- **Left panel**: tree view with search/filter
- **Right panel**: entry detail (or empty state)
- **Header**: Generate (password generator), Settings (⚙), Lock (clear session)
- **Footer**: session countdown timer
- **Mobile**: left panel as drawer/slide-over

### Screen 3a: Entry Detail (right panel)

```
┌────────────────────────────────────┐
│ Email / gmail                [Edit]│
│                                    │
│ Password: ••••••••••  [👁] [Copy]  │
│                                    │
│ Notes:                             │
│ ┌────────────────────────────────┐ │
│ │ username: user@gmail.com       │ │
│ │ recovery: +1-555-1234          │ │
│ └────────────────────────────────┘ │
│                                    │
│          [Delete]                  │
└────────────────────────────────────┘
```

- First line = password (like `pass` convention)
- Remaining lines = notes/metadata
- Copy button → clipboard, auto-clear 45s
- Eye toggle → show/hide password

### Screen 3b: Add/Edit Entry

```
┌────────────────────────────────────┐
│ New Entry                          │
│                                    │
│ Path: Email/                       │
│       ┌────────────────────────┐   │
│       │ entry-name             │   │
│       └────────────────────────┘   │
│                                    │
│ Password:                          │
│ ┌──────────────────────┐ [Gen 🎲]  │
│ │                      │           │
│ └──────────────────────┘           │
│                                    │
│ Notes (optional):                  │
│ ┌────────────────────────────────┐ │
│ │                                │ │
│ │                                │ │
│ └────────────────────────────────┘ │
│                                    │
│ [ Cancel ]           [ Save ✓ ]    │
└────────────────────────────────────┘
```

### Screen 4: Password Generator (modal)

```
┌────────────────────────────────────┐
│ Password Generator            [✕]  │
│                                    │
│ ┌────────────────────────────────┐ │
│ │ $(-QF&Q=IN2nFBx               │ │
│ └────────────────────────────────┘ │
│                         [Copy] [↻] │
│                                    │
│ Length: ──●──────────── 20         │
│                                    │
│ [✓] Uppercase (A-Z)               │
│ [✓] Lowercase (a-z)               │
│ [✓] Numbers (0-9)                 │
│ [✓] Symbols (!@#$...)             │
│                                    │
│ [ Use This Password ]              │
└────────────────────────────────────┘
```

### Screen 5: Settings (⚙)

```
┌────────────────────────────────────┐
│ Settings                      [✕]  │
│                                    │
│ Account                            │
│  Fingerprint: A1B2 C3D4 ... E5F6  │
│  Key type: ECC Curve25519          │
│                                    │
│ PGP Key Management                 │
│  [ Export Public Key ]             │
│  [ Export Private Key (encrypted)] │
│  [ Import Private Key ]            │
│                                    │
│ Git Sync                           │
│  Repo: https://github.com/...      │
│  Last synced: 3 hours ago          │
│  [ Configure ]  [ Push ]  [ Pull ] │
│                                    │
│ Data                               │
│  [ Export All (.tar.gz) ]          │
│  [ Import .password-store ]        │
│                                    │
│ API Server                         │
│  URL: https://webpass.exe.xyz:8000 │
│  [ Change ]                        │
│                                    │
│ Danger Zone                        │
│  [ Delete Account ]                │
└────────────────────────────────────┘
```

---

## Updated Build Phases

| #   | Phase               | Deliverable                                                    |
| --- | ------------------- | -------------------------------------------------------------- |
| 1   | Go backend          | SQLite schema, multi-user auth (bcrypt + JWT), CRUD API, CORS, import/export |
| 2   | Frontend scaffold   | Vite + Preact, routing, welcome/login/setup screens            |
| 3   | Crypto core         | OpenPGP.js keygen/import, PBKDF2/AES wrap/unwrap, encrypt/decrypt |
| 4   | CRUD UI             | Tree view, entry detail, add/edit/delete, clipboard, search    |
| 5   | Generator + Settings | Password generator modal, key export/import, data export/import |
| 6   | Polish + Deploy     | Mobile responsive, session timer, Docker container    |

---

## Decisions Made (continued)

- **Cloudflare Pages**: project name `webpass` (actual domain may be `webpass-xxx.pages.dev`)
- **Custom domain**: `webpass.wonghome.net`
- **API server URL**: configurable in frontend settings, stored in localStorage in **plaintext** (not a secret — it's just a server address, and must be readable before login)
- **All other localStorage/IndexedDB data**: encrypted via PBKDF2/AES
- **Server-side**: all entry blobs are PGP-encrypted; server never has plaintext
- **Frontend**: pure static SPA on `*.pages.dev` — no server-side rendering
- **Private key & decrypted secrets**: browser memory only, never sent to network
- **CLI client**: future phase — talks to same backend API

### Import Private Key → Re-encrypt with WebPass Password

When importing an existing PGP private key:

```
1. User provides import passphrase → decrypt key in browser memory
2. Re-encrypt with WebPass login password (PBKDF2 → AES) → store in IndexedDB
3. Import passphrase discarded, never stored
4. From now on, only the WebPass password is needed
```

One password to rule them all. Simpler and more secure.

### 2FA (TOTP) — Phase 7

```
Login flow with 2FA enabled:

1. Client: decrypt PGP key locally (password check)
2. POST /api/{fingerprint}/login { password }
   → server: bcrypt OK → returns { requires_2fa: true }
3. Client: prompt for TOTP code
4. POST /api/{fingerprint}/login/2fa { totp_code }
   → server: verify TOTP → returns JWT (5-min)
5. App unlocked

Setup:
  Settings → Enable 2FA → server generates TOTP secret → QR code
  User scans with authenticator app → confirms with code
  TOTP secret stored server-side in users table
```

---

## Updated Data Model (with 2FA)

```sql
CREATE TABLE users (
    fingerprint   TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    totp_secret   TEXT,              -- NULL if 2FA not enabled
    totp_enabled  INTEGER DEFAULT 0, -- 0=off, 1=on
    created       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entries (
    id          INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL REFERENCES users(fingerprint),
    path        TEXT NOT NULL,
    content     BLOB NOT NULL,
    created     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(fingerprint, path)
);
```

---

## Final Build Phases

| #   | Phase               | Deliverable                                                    |
| --- | ------------------- | -------------------------------------------------------------- |
| 1   | Go backend          | SQLite schema, multi-user auth (bcrypt + JWT + TOTP), CRUD API, CORS |
| 2   | Frontend scaffold   | Vite + Preact, routing, welcome/login/setup (with 2FA) screens |
| 3   | Crypto core         | OpenPGP.js keygen/import, PBKDF2/AES wrap/unwrap, encrypt/decrypt, IndexedDB (key + API URL) |
| 4   | CRUD UI             | Tree view, entry detail, add/edit/delete, clipboard, search    |
| 5   | Generator + Settings| Password generator modal, key management, API URL config       |
| 6   | Import/Export       | tar/zip .password-store import/export, key export/import       |
| 7   | Git Sync            | Backend Git service, PGP-encrypted PAT, manual push/pull UI |
| 8   | Polish + Deploy     | Mobile responsive, session timer, Docker container    |

---

## Resolved Questions

### Encrypt API server URL too? → Yes

All data in IndexedDB is AES-encrypted (per fingerprint), including the API URL:

```
IndexedDB (per fingerprint, all AES-encrypted with PBKDF2 key):
  - PGP private key
  - API server URL

Decrypt fails → wrong password → stop (never touches network)
Decrypt OK    → we have the PGP key + API URL → proceed to POST /login
```

Exception: **first-time setup** — user must enter the API URL manually (nothing stored yet). This URL is then encrypted and stored alongside the key.

### 2FA (TOTP) required? → Yes, strongly recommended at setup

With one password controlling everything, 2FA is critical:

- **2FA protects server-side**: stolen password alone can't download encrypted blobs
- **2FA does NOT protect client-side**: if attacker has password + browser IndexedDB, they can decrypt locally
- **Recommendation**: strongly prompted during setup, but not strictly mandatory (so the app still works if TOTP device is lost — user accepts the risk)
- **TOTP secret stored server-side** in `users.totp_secret`

2FA is now part of Phase 1 (backend) and Phase 2 (frontend) since it's a core auth feature.

---

## Resolved: Separate PGP Passphrase (never stored)

The PGP private key passphrase is **never stored anywhere** — not in IndexedDB, not in memory, not on server. It is prompted each time a crypto operation is needed.

### Three-factor security model

```
To access secrets, attacker needs ALL THREE:
  1. Login password     → unlocks IndexedDB + server JWT
  2. PGP passphrase     → decrypts the PGP private key (prompted each time)
  3. 2FA (TOTP) code    → server-side gate

Compromising any two is still not enough.
```

### What's stored where

```
IndexedDB (per fingerprint):
  - PGP private key (encrypted with its OWN passphrase — native OpenPGP)
  - API server URL (AES-encrypted with login password via PBKDF2)

Server (SQLite):
  - bcrypt(login password)
  - PGP public key
  - TOTP secret
  - Encrypted .gpg entry blobs

Nowhere:
  - PGP passphrase (only in user's head)
```

### Updated login flow

```
User enters login password
       │
       ▼
1. Client: password → PBKDF2 → AES key
   → decrypt API URL from IndexedDB
       │
       ├── FAIL → "Wrong password" (stop)
       │
       └── OK → we have the API URL
                   │
                   ▼
            2. POST /api/{fingerprint}/login { password }
               → server: bcrypt OK
               → if 2FA enabled: { requires_2fa: true }
                   │
                   ▼
            3. (if 2FA) Enter TOTP code
               POST /api/{fingerprint}/login/2fa { totp_code }
               → returns JWT (5-min)
                   │
                   ▼
            4. App unlocked — can browse tree, but can't
               read/decrypt entries yet
```

### Decrypt/edit flow (per operation)

```
User clicks entry → prompt: "Enter PGP passphrase"
       │
       ▼
1. Passphrase → OpenPGP.js decryptKey(privateKey, passphrase)
       │
       ├── FAIL → "Wrong passphrase"
       │
       └── OK → decrypt entry content → show plaintext
                   │
                   ▼
            2. Passphrase + decrypted key wiped from memory
               immediately after operation completes
```

Same flow for creating/editing entries — prompt passphrase → decrypt key → encrypt content → upload → wipe.

### Updated setup flow

```
Step 1: API server URL
Step 2: Login password + confirm (for server auth & IndexedDB AES)
Step 3: PGP key
        - Generate new: enter PGP passphrase + confirm (separate from login password)
        - Import existing: enter import passphrase (key keeps its original passphrase)
Step 4: Confirm + 2FA setup
```

Note: login password and PGP passphrase CAN be the same (user's choice), but we don't suggest or enforce it. Two different passwords = maximum security.

---

## Documentation

| Document | Status | Description |
|----------|--------|-------------|
| `README.md` | ✅ Complete | Project overview, setup guide, architecture, deployment |
| `GITSYNC.md` | ✅ Complete | Git Sync feature guide: setup, push/pull, conflict resolution |
| `DEPLOY.md` | ✅ Complete | Detailed deployment instructions (Docker, K8s) |
| `SECURITY.md` | ✅ Complete | Security policy and vulnerability reporting |
| `CONTRIBUTING.md` | ✅ Complete | Contribution guidelines |
| `IMPORT.md` | ✅ Complete | Import feature documentation |
| `DEVELOPMENT.md` | ✅ Complete | Development setup guide |

## Testing

Tests are built alongside each phase:

| Layer | What | Tool |
|-------|------|------|
| Go backend | API endpoints, auth flow, CRUD, import/export, 2FA, Git sync | `go test` |
| Frontend crypto | Key generation, AES wrap/unwrap, PGP encrypt/decrypt round-trips | Vitest |
| Frontend flows | Setup wizard, login, session timeout, entry CRUD | Vitest + Testing Library |
| Integration | Full flow: setup → login → create entry → decrypt | Playwright (future) |

---

## Prerequisites

| Dependency | Required For | Notes |
|------------|--------------|-------|
| Go 1.26+ | Backend server | |
| Node.js 20+ | Frontend build | |
| Docker | Container runtime | Git CLI included in container image |
| SQLite | Database | Embedded (pure-Go, no CGO needed) |

---

## Encrypt/Decrypt Text Tool

Standalone PGP encrypt/decrypt tool — separate from entry management.

Header bar adds `[Encrypt]` button:

```
┌─────────────────────────────────────────────────────┐
│  🔐 WebPass        [Encrypt] [Generate] [⚙] [Lock]  │
```

### Screen 6: Encrypt/Decrypt Text (modal, two tabs)

```
┌────────────────────────────────────┐
│ [ Encrypt ]  [ Decrypt ]         [✕]  │
│                                    │
│ Plaintext:                         │
│ ┌────────────────────────────────┐ │
│ │                                │ │
│ │  (paste or type content)       │ │
│ │                                │ │
│ └────────────────────────────────┘ │
│                                    │
│ Encrypt with:                      │
│  ● My public key (default)        │
│  ○ Paste recipient's public key   │
│                                    │
│ [ Encrypt → ]                      │
│                                    │
│ Encrypted output:                  │
│ ┌────────────────────────────────┐ │
│ │ -----BEGIN PGP MESSAGE-----   │ │
│ │ hQEMA...                      │ │
│ │ -----END PGP MESSAGE-----     │ │
│ └────────────────────────────────┘ │
│                         [Copy]     │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ [ Encrypt ]  [ Decrypt ]         [✕]  │
│                                    │
│ Encrypted PGP message:             │
│ ┌────────────────────────────────┐ │
│ │ (paste PGP message)            │ │
│ └────────────────────────────────┘ │
│                                    │
│ [ Decrypt → ]                      │
│ (prompts for PGP passphrase)       │
│                                    │
│ Decrypted output:                  │
│ ┌────────────────────────────────┐ │
│ │ (plaintext content)            │ │
│ └────────────────────────────────┘ │
│                         [Copy]     │
└────────────────────────────────────┘
```

- **Encrypt tab**: type/paste plaintext → encrypt with own key or recipient's public key → copy armored PGP message
- **Decrypt tab**: paste PGP message → prompts for PGP passphrase → decrypt → show plaintext
- Encrypt with recipient's key = paste their armored public key into a field
- All client-side, no server involvement

---

## Final Build Phases (updated)

| #   | Phase               | Deliverable                                                    |
| --- | ------------------- | -------------------------------------------------------------- |
| 1   | Go backend          | SQLite schema, multi-user auth (bcrypt + JWT + TOTP), CRUD API, CORS |
| 2   | Frontend scaffold   | Vite + Preact, routing, welcome/login/setup (with 2FA) screens |
| 3   | Crypto core         | OpenPGP.js keygen/import, PBKDF2/AES wrap/unwrap, encrypt/decrypt, IndexedDB |
| 4   | CRUD UI             | Tree view, entry detail, add/edit/delete, clipboard, search    |
| 5   | Generator + Encrypt | Password generator modal, encrypt/decrypt text tool            |
| 6   | Settings            | Key management, API URL config, 2FA management                 |
| 7   | Import/Export       | tar/zip .password-store import/export, key export/import       |
| 8   | Polish + Deploy     | Mobile responsive, session timer, docs, Docker container |

---

## Open Questions

_(none remaining — ready to build)_

