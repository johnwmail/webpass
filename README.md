# 🔐 WebPass

A web-based password manager with zero-knowledge architecture. All cryptography happens client-side in the browser using OpenPGP.js. The server stores only encrypted blobs — it never sees plaintext passwords or private keys.

[![CI](https://github.com/johnwmail/webpass/actions/workflows/ci.yml/badge.svg)](https://github.com/johnwmail/webpass/actions/workflows/ci.yml)
[![Integration Tests](https://github.com/johnwmail/webpass/actions/workflows/integration-test.yml/badge.svg)](https://github.com/johnwmail/webpass/actions/workflows/integration-test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go)](https://go.dev)

## ✨ Features

- **Client-side encryption** — PGP encryption/decryption in the browser with OpenPGP.js
- **Zero-knowledge architecture** — Server never sees plaintext passwords or private keys
- **Multi-user support** — Each user identified by their PGP key fingerprint
- **Two-factor authentication** — Optional TOTP (2FA) for server access
- **Import/Export** — Compatible with standard `.password-store` directory format (pass CLI compatible)
- **Password generator** — Configurable random password generation
- **Session management** — 5-minute JWT sessions with automatic expiry
- **Git sync** — Backup and sync encrypted entries to any Git repository (GitHub, GitLab, Gitea)
- **TOTP codes** — Store and generate TOTP codes using `otpauth://` URI format (pass-otp compatible)
- **Theme toggle** — Auto-switching light/dark themes based on time of day (8AM-10PM)
- **Account management** — Clear local data or permanently delete account with passphrase confirmation
- **Auto-hide sensitive content** — Password and notes auto-hide after 15 seconds with countdown timer
- **Rate limiting** — Sliding window rate limiting on authentication endpoints (5 attempts / 15 min default)
- **Registration protection** — TOTP-based registration codes to prevent unauthorized account creation

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│  Browser (SPA)                      │
│  + OpenPGP.js + IndexedDB           │
│  + PGP encrypt/decrypt              │
│  + TOTP code generation             │
└────────────────────────────────────┘
               │ HTTPS + CORS + JWT
┌──────────────▼──────────────────────┐
│  Go API Server (SQLite backend)     │
│  + JWT Auth + bcrypt + TOTP         │
│  + Rate limiting                    │
│  + Git sync (go-git)                │
└─────────────────────────────────────┘
               │ HTTPS + PAT
┌──────────────▼──────────────────────┐
│  Remote Git Repo (optional)         │
│  └── *.gpg (encrypted blobs)        │
└─────────────────────────────────────┘
```

## 🛠️ Tech Stack

| Layer    | Technology                              |
| -------- | --------------------------------------- |
| Frontend | TypeScript + Preact + Vite             |
| Crypto   | OpenPGP.js + Web Crypto API (PBKDF2)   |
| Backend  | Go 1.26 + SQLite (pure-Go, no CGO)     |
| Git      | go-git (pure Go, no Git CLI needed)    |
| Auth     | bcrypt + JWT (5-min) + TOTP (2FA)      |
| Testing  | Playwright (77 E2E tests) + Vitest     |
| Deploy   | Docker (single container)               |

## 🚀 Quick Start

### Prerequisites

- Go 1.26+
- Node.js 24+
- npm
- Docker (for container deployment)

### Build

```bash
# Build backend
go build -o webpass-server ./cmd/srv

# Build frontend (optional, for static serving)
cd frontend && npm run build
```

### Run

```bash
# Set environment variables
export JWT_SECRET=$(openssl rand -hex 32)
export DB_PATH=./db.sqlite3

# Run server (development)
go run ./cmd/srv

# Or run the compiled binary
./webpass-server
```

Server listens on `:8080` by default.

##  Deployment

### Docker

```bash
# Build image
docker build -t webpass:latest .

# Run container
docker run -d \
  --name webpass \
  -p 8080:8080 \
  -v webpass-data:/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  --read-only \
  --security-opt no-new-privileges:true \
  webpass:latest
```

### Docker Compose

```bash
# Configure environment
cp .env.example .env
# Edit .env and set JWT_SECRET

# Start
docker compose up -d
```

### Kubernetes

```bash
kubectl apply -f k8s/deployment.yaml
```

### Security Hardening

The container runs with:
- **Non-root user** (UID/GID 8080)
- **Read-only filesystem** (`--read-only`)
- **No privilege escalation** (`--security-opt no-new-privileges:true`)
- **Writable path** only `/data` (SQLite + git repos)

##  Testing

### Unit Tests

```bash
# Backend tests
go test ./...

# Frontend unit tests
cd frontend && npm test
```

### E2E Tests (Playwright)

77 browser-based integration tests across 5 phases:

```bash
# Run comprehensive test suite
./frontend/playwright-e2e-test.sh

# Or use npx directly
cd frontend && npx playwright test

# Run with interactive UI
npx playwright test --ui

# Run with visible browser
npx playwright test --headed

# View HTML report
npx playwright show-report
```

**Test Coverage:**
- Phase 1: Rate limit tests (3 tests)
- Phase 2: All tests in Protected mode (58 tests)
- Phase 3: Registration tests in Open mode (6 tests)
- Phase 4: Registration tests in Protected mode (8 tests)
- Phase 5: Registration tests in Disabled mode (2 tests)

### Git Sync Test Configuration

Git sync E2E tests require a real Git repository. Set credentials via:

```bash
# Option 1: .env file (gitignored)
WEBPASS_REPO_URL="https://gitea.example.com/user/password-store.git"
WEBPASS_REPO_PAT="your-personal-access-token"

# Option 2: Environment variables
export WEBPASS_REPO_URL="..."
export WEBPASS_REPO_PAT="..."

# Option 3: GitHub Secrets (CI/CD)
# Add WEBPASS_REPO_URL and WEBPASS_REPO_PAT to repository secrets
```

## 📡 API Endpoints

All endpoints require JWT authentication except where noted.

### Authentication & User Management

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| POST   | `/api`                            | No    | Create user (first-time setup)                   |
| GET    | `/api/{fingerprint}`              | JWT   | Get user info                                    |
| POST   | `/api/{fingerprint}/login`        | No    | Login → returns JWT or 2FA challenge             |
| POST   | `/api/{fingerprint}/login/2fa`    | No    | Complete 2FA login                               |
| DELETE | `/api/{fingerprint}/account`      | JWT   | Delete account permanently                       |
| POST   | `/api/{fingerprint}/password`     | JWT   | Change password                                  |

### Registration (TOTP-based)

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| GET    | `/api/registration/mode`          | No    | Get registration mode (open/protected/disabled)  |
| POST   | `/api/registration/validate`      | No    | Validate registration TOTP code                  |

### TOTP Setup

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| POST   | `/api/{fingerprint}/totp/setup`   | JWT   | Begin TOTP 2FA setup                             |
| POST   | `/api/{fingerprint}/totp/confirm` | JWT   | Confirm TOTP 2FA setup                           |

### Entries (Password Store)

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| GET    | `/api/{fingerprint}/entries`      | JWT   | List all entry paths                             |
| GET    | `/api/{fingerprint}/entries/*`    | JWT   | Download encrypted blob                          |
| PUT    | `/api/{fingerprint}/entries/*`    | JWT   | Upload encrypted blob                            |
| DELETE | `/api/{fingerprint}/entries/*`    | JWT   | Delete entry                                     |
| POST   | `/api/{fingerprint}/entries/move` | JWT   | Rename/move entry                                |

### Import/Export

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| GET    | `/api/{fingerprint}/export`       | JWT   | Export all entries as `.tar.gz`                  |
| POST   | `/api/{fingerprint}/import`       | JWT   | Import password store (JSON or `.tar.gz`)        |

### Git Sync

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| GET    | `/api/{fingerprint}/git/status`   | JWT   | Get git sync status                              |
| GET    | `/api/{fingerprint}/git/config`   | JWT   | Get git configuration                            |
| POST   | `/api/{fingerprint}/git/config`   | JWT   | Configure git sync                               |
| POST   | `/api/{fingerprint}/git/session`  | JWT   | Set git token for current session                |
| POST   | `/api/{fingerprint}/git/push`     | JWT   | Manual push to remote (force overwrite)          |
| POST   | `/api/{fingerprint}/git/pull`     | JWT   | Manual pull from remote (fresh clone)            |
| POST   | `/api/{fingerprint}/git/toggle-sync` | JWT | Enable/disable git sync                          |
| GET    | `/api/{fingerprint}/git/log`      | JWT   | Get sync operation history (last 50)             |

### System

| Method | Path                              | Auth  | Description                                      |
| ------ | --------------------------------- | ----- | ------------------------------------------------ |
| GET    | `/api/health`                     | No    | Health check                                     |
| GET    | `/api/version`                    | No    | Get server version                               |

## 🔒 Security Model

- **Private keys never leave the browser** — Stored AES-wrapped in IndexedDB
- **Server stores only PGP-encrypted blobs** — Database leak reveals nothing
- **Password validates locally first** — Wrong password fails before network call
- **5-minute sessions** — JWT expiry enforced server-side
- **CORS locked** to specific origins via `CORS_ORIGINS` env var
- **All traffic over HTTPS** required in production
- **Rate limiting** on authentication endpoints (sliding window, 5 attempts / 15 min default)
- **Registration protection** with TOTP-based codes (optional, configurable)

### Reporting Vulnerabilities

**Please do not open public issues for security vulnerabilities.**

1. **Email**: Send details to the maintainers privately
2. **GitHub**: Use [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)

**Response Timeline:**
- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix Timeline**: Depends on severity (Critical: 24-72h, High: 1-2 weeks, Medium: 2-4 weeks)

## ⚙️ Environment Variables

See [`.env.example`](.env.example) for all available options with detailed comments.

| Variable       | Required | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `JWT_SECRET`   | Yes      | 32-byte hex string for JWT signing       |
| `DB_PATH`      | No       | Path to SQLite database (default: `/data/db/db.sqlite3`) |
| `STATIC_DIR`   | No       | Path to frontend `dist/` directory       |
| `CORS_ORIGINS` | No       | Comma-separated allowed origins          |
| `PORT`         | No       | HTTP listen port (default: `8080`)       |
| `GIT_REPO_ROOT`| No       | Git repos directory (default: `/data/git-repos`) |
| `SESSION_HARDLIMIT_MINUTES` | No | JWT hard limit (max session time) in minutes (default: 30, range: 5-480) |
| `SESSION_SOFTLIMIT_MINUTES` | No | JWT soft limit (browser close detection) in minutes (default: 5, range: 1-60) |
| `DISABLE_FRONTEND` | No   | Disable frontend (`1` or `true`)         |
| `BCRYPT_COST`  | No       | Password hashing cost factor (default: 12, range: 10-15) |
| `RATE_LIMIT_ATTEMPTS` | No | Max requests per window (default: 5)    |
| `RATE_LIMIT_WINDOW_MINUTES` | No | Time window in minutes (default: 15) |

### Registration Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRATION_ENABLED` | `false` | Enable registration (`1` or `true`) |
| `REGISTRATION_TOTP_SECRET` | *(empty)* | Base32 TOTP secret (required for protected mode) |
| `REGISTRATION_TOTP_PERIOD` | `3600` | Code validity period in seconds (15-86400) |
| `REGISTRATION_TOTP_ALGO` | `SHA1` | Hash algorithm (SHA1/SHA256/SHA512) |
| `REGISTRATION_CODE_FILE` | `/data/registration_code.txt` | Path to write current code |

**Registration Modes:**

| `REGISTRATION_ENABLED` | `REGISTRATION_TOTP_SECRET` | Mode |
|------------------------|---------------------------|------|
| `false` | (any) | **Disabled** — No registration allowed |
| `true` | (not set) | **Open** — No code required |
| `true` | (set) | **Protected** — 6-digit TOTP code required |

## 🔄 Git Sync

One-way overwrite sync with fresh clone/export:

- **Pull**: Remote → Local (clone remote, replace local DB)
- **Push**: Local → Remote (export local DB, force-push to remote)
- **No merge conflicts** — Last write wins
- **Fresh operations** — Local git repo is temporary, cleaned before/after each operation
- **PGP-encrypted PAT** — Encrypted with user's PGP public key
- **Per-user configuration** — Each user has their own repo URL

### Git Repository Structure

```
repo-root/
├── .git/
├── email.gpg
├── work/
│   └── database.gpg
└── social/
    └── twitter.gpg
```

- All files are `.gpg` encrypted blobs (client-side PGP encryption)
- Files at repo root (no `.password-store/` subdirectory)
- Compatible with standard `pass` CLI after cloning

### Branch Detection

**Default branch auto-detection** (branch = "HEAD"):
1. Read remote HEAD symbolic reference
2. If HEAD not found → try `main`
3. If `main` not found → try `master`

##  Theme System

Auto-switching theme system with manual override:

| Theme | Description |
|-------|-------------|
| **Ocean** | Dark blue professional theme (default for night) |
| **Daylight** | Clean white/blue light theme (default for day) |

**Auto mode** (default):
- **8:00 AM - 10:00 PM** → Daylight theme
- **10:00 PM - 8:00 AM** → Ocean theme

**Manual override**: Click theme toggle button to cycle: `🔄 Auto → 🌙 Ocean → ☀️ Daylight →  Auto`

Preference saved to localStorage and persists across sessions.

## 📁 Project Structure

```
.
├── .github/workflows/   # CI/CD pipelines
├── cmd/srv/            # Main binary entrypoint
── srv/                # HTTP server + handlers
├── db/                 # Database migrations + sqlc queries
├── frontend/           # Preact + TypeScript SPA
│   ├── src/
│   ├── index.html
│   └── package.json
── k8s/                # Kubernetes manifests
── Dockerfile
├── docker-compose.yml
└── .github/            # GitHub Actions workflows
```

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and [AGENTS.md](AGENTS.md) for the development guide.

### Quick Start for Contributors

```bash
# Clone repository
git clone https://github.com/johnwmail/webpass.git
cd webpass

# Backend
go mod download
go test ./...

# Frontend
cd frontend
npm install
npm run dev
```

### Testing Requirements

- Backend: `go test ./...` must pass
- Frontend unit: `npm test` must pass
- E2E tests: `./frontend/playwright-e2e-test.sh` must pass (77 tests)
- Type check: `npm run typecheck` must pass

### Code Standards

**Go:**
- Follow [Effective Go](https://go.dev/doc/effective_go)
- Use `gofmt` or `goimports`
- Add tests for new packages

**TypeScript:**
- Use TypeScript for all new code
- Follow existing code style
- Add types for function signatures

**General:**
- Write self-documenting code
- Keep PRs under 400 lines when possible
- Update tests with code changes

### Security Considerations

**Never commit:**
- Passwords or secrets
- API keys or tokens
- Private encryption keys
- Production database files

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Inspired by [pass](https://www.passwordstore.org/)
- Built with [OpenPGP.js](https://openpgpjs.org/)
- Backend powered by [Go](https://go.dev/) and [SQLite](https://www.sqlite.org/)
- Git operations via [go-git](https://github.com/go-git/go-git)
