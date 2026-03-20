# WebPass Development Guide

## Project Overview

WebPass is a zero-knowledge password manager with:
- **Frontend**: Preact + TypeScript SPA (client-side PGP encryption)
- **Backend**: Go HTTP API with SQLite storage
- **Security**: All crypto in browser; server stores only encrypted blobs
- **Git Sync**: Manual push/pull to any Git repository (PGP-encrypted PAT)

## Code Layout

```
.
├── cmd/srv/main.go      # Binary entrypoint
├── srv/
│   ├── server.go        # HTTP handlers + auth middleware
│   └── git.go           # Git sync service (push, pull, conflict detection)
├── db/
│   ├── db.go           # SQLite connection + migrations
│   ├── migrations/     # SQL migration files
│   ├── queries/        # sqlc query definitions
│   └── dbgen/          # Generated Go code (sqlc output)
├── frontend/
│   ├── src/            # Preact components + logic
│   ├── index.html
│   └── package.json
├── k8s/                # Kubernetes manifests
└── GITSYNC.md          # Git sync feature documentation
```

## Development Workflow

### Backend

```bash
# Build
go build -o webpass-server ./cmd/srv

# Run (with env vars)
JWT_SECRET=$(openssl rand -hex 32) go run ./cmd/srv

# Test
go test ./...

# Generate sqlc code
cd db && sqlc generate
```

### Frontend

```bash
cd frontend

# Install deps
npm install

# Dev server (with hot reload)
npm run dev

# Build for production
npm run build

# Type check
npm run typecheck
```

## Environment Variables

| Variable            | Description                              |
| ----------------- | ---------------------------------------- |
| `JWT_SECRET`      | 32-byte hex for JWT signing (required). If not set, random key generated on startup (fine for single-instance with short sessions). Set fixed value for multi-instance or long sessions. |
| `DB_PATH`         | SQLite path (default: `/data/db/db.sqlite3`) |
| `STATIC_DIR`      | Frontend dist dir (default: `frontend/dist`) |
| `DISABLE_FRONTEND`| Disable frontend serving (`1`/`true` to disable, even if `STATIC_DIR` exists) |
| `PORT`            | HTTP listen port (default: `8080`)       |
| `CORS_ORIGINS`    | Comma-separated allowed origins          |
| `GIT_REPO_ROOT`   | Git repos directory (default: `/data/git-repos`) |
| `SESSION_DURATION_MINUTES` | JWT session expiry time in minutes (default: 5, valid range: 5-480) |

## Database

SQLite with sqlc for type-safe queries.

```bash
# After modifying db/queries/*.sql:
cd db && sqlc generate
```

## Authentication Flow

1. **Setup**: User creates account → PGP keypair generated → public key + bcrypt hash stored
2. **Login**: Password verified → JWT returned (5-min expiry)
3. **2FA** (optional): TOTP code required after password verification

## Auto-Hide Feature

Password and notes fields auto-hide after **15 seconds** of being visible:

- **Countdown timer**: Shows remaining seconds on eye button (e.g., "👁️ 15s")
- **Independent timers**: Password and notes have separate countdowns
- **Manual toggle**: Click eye icon to show/hide content
- **OTP always visible**: TOTP codes stay visible (user can manually hide)
- **Toast notification**: "Content hidden for security" appears on auto-hide

## Git Sync

Manual push/pull sync to any Git repository (GitHub, GitLab, Gitea):

- **PGP-encrypted PAT**: PAT → PGP encrypt → stored in `git_config.encrypted_pat`
- **Manual sync only**: User clicks Push/Pull buttons in Settings
- **Zero-knowledge**: Server stores encrypted blob, can't decrypt
- **Conflict detection**: Shows UI dialog if local and remote both modified

See [GITSYNC.md](GITSYNC.md) for full documentation.

## Security Rules

- Never log passwords, tokens, or encrypted content
- Never send private keys to server
- Always validate JWT fingerprint matches request path
- CORS must be configured for production origins
- Git PAT tokens: only accept over HTTPS, never store plaintext

## Deployment

See [DEPLOY.md](DEPLOY.md) for:
- Docker / docker-compose
- Kubernetes

## Testing Checklist

- [ ] Build succeeds: `go build -o webpass-server ./cmd/srv`
- [ ] Frontend builds: `cd frontend && npm run build`
- [ ] Go tests pass: `go test ./...`
- [ ] Playwright E2E tests pass: `cd frontend && npx playwright test`
- [ ] No hardcoded secrets in code
- [ ] `.env` files are gitignored

## E2E Testing (Playwright)

Run browser-based integration tests:

```bash
# Install dependencies (one-time)
cd frontend
npm install -D @playwright/test
npx playwright install chromium

# Run all tests
npx playwright test

# Run with UI (interactive)
npx playwright test --ui

# Run specific test
npx playwright test -g "login"

# View HTML report
npx playwright show-report
```

See [PLAYWRIGHT.md](PLAYWRIGHT.md) for full documentation.
