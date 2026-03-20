# WebPass Development Guide

Quick reference for setting up development environment and current project status.

---

## Quick Start (New Development Machine)

### 1. Clone and Setup

```bash
# Clone repository
git clone https://github.com/johnwmail/webpass.git
cd webpass

# Copy environment example
cp .env.example .env

# Edit .env with your secrets
nano .env
```

### 2. Required Environment Variables

Create `.env` file with:

```bash
# JWT Secret (32-byte hex)
# Random key is fine for development with short sessions
# For production or multi-instance, use a fixed value
JWT_SECRET=$(openssl rand -hex 32)

# Docker registry secrets (for CI/CD)
DOCKER_PASSWORD=your_docker_hub_token
CLOUDFLARE_API_TOKEN=your_cloudflare_token
CLOUDFLARE_ACCOUNT_ID=your_account_id
```

### 3. Development Setup

**Option A: Docker (Recommended)**
```bash
# Build and run with Docker Compose
docker compose up --build
```

Access at: http://localhost:8080

**Option B: Local Development**

```bash
# Frontend
cd frontend
npm install
npm run dev

# Backend (in another terminal)
cd /path/to/webpass
# Random JWT secret is fine for local dev
JWT_SECRET=$(openssl rand -hex 32) go run ./cmd/srv
```

### 4. Required Secrets for CI/CD

Configure in GitHub Repository Settings → Secrets and variables → Actions:

| Secret | Purpose | Required For |
|--------|---------|--------------|
| `DOCKER_PASSWORD` | Docker Hub login | Container builds |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Pages deploy | Frontend deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Frontend deploy |

Configure in Repository Settings → Variables → Actions:

| Variable | Example Value | Purpose |
|----------|---------------|---------|
| `CLOUDFLARE_PAGES_PROJECT` | `webpass` | Pages project name |

---

## Current Project Status

### ✅ Completed Features

| Feature | Status | Notes |
|---------|--------|-------|
| User Registration | ✅ Complete | PGP keypair generation |
| Login/Logout | ✅ Complete | Session-based with 5-min expiry |
| Password Entry CRUD | ✅ Complete | Encrypted storage |
| Export | ✅ Complete | Downloads .tar.gz |
| **Import** | ✅ Complete | **Client-side decrypt/re-encrypt** |
| Git Sync | ✅ Complete | Manual push/pull |
| 2FA (TOTP) | ✅ Complete | Settings → Enable 2FA, real TOTP login tested |
| Delete Account | ✅ Complete | Settings → Danger Zone |

### Recent Changes (Latest Commit)

**Import Feature** - Fully implemented and tested with:
- Client-side tar.gz extraction (fflate)
- Client-side PGP decrypt/re-encrypt
- External PGP key import support (armored & binary formats)
- Account migration flow (export → delete → import)
- Multi-format content (base64, armored PGP)
- Duplicate overwrite handling
- Partial failure handling
- Security: Keys cleared from memory

**2FA Testing** - Real TOTP code generation and login:
- Tests capture TOTP secret from QR code screen
- Generate valid TOTP codes using otpauth library
- Test complete 2FA enrollment and login flow
- No GPG CLI dependency (uses WebPass export/import)

**Test Suite** - 26 E2E tests, all passing:
- 6 Authentication tests (including 2FA login)
- 6 Entry Management tests
- 1 Import test (account migration flow)
- 13 Settings tests (including 2FA from settings)

---

## Project Structure

```
webpass/
├── cmd/srv/main.go          # Backend entry point
├── srv/
│   ├── server.go            # HTTP handlers + auth
│   └── git.go               # Git sync service
├── db/
│   ├── db.go                # SQLite connection
│   ├── migrations/          # SQL migrations
│   └── queries/             # sqlc query definitions
├── frontend/
│   ├── src/
│   │   ├── components/      # Preact components
│   │   ├── lib/             # Utilities (crypto, api, etc.)
│   │   └── app.tsx          # Main app component
│   └── package.json
├── .github/workflows/
│   ├── ci.yml               # CI tests
│   ├── build-container.yml  # Docker build
│   └── deploy.yml           # Cloudflare Pages deploy
├── docker-compose.yml       # Docker setup
├── Dockerfile               # Multi-stage build
└── IMPORT.md                # Import feature documentation
```

---

## Common Development Tasks

### Run Tests

```bash
# Backend tests
go test ./...

# Frontend unit tests
cd frontend && npm test

# Frontend E2E tests (Playwright)
./frontend/playwright-e2e-test.sh

# Or manually:
cd frontend && npx playwright test

# E2E tests with UI (interactive)
cd frontend && npx playwright test --ui

# E2E tests with visible browser
cd frontend && npx playwright test --headed

# Run specific tests
cd frontend && npx playwright test --grep "import"
cd frontend && npx playwright test --grep "2FA"

# View E2E test report
cd frontend && npx playwright show-report
```

See [PLAYWRIGHT.md](PLAYWRIGHT.md) for E2E test documentation.

### Build for Production

```bash
# Full build (frontend + backend)
docker compose build

# Or manually:
cd frontend && npm run build
go build -o webpass-server ./cmd/srv
```

### Database Migrations

```bash
# Generate sqlc code (after modifying queries)
make db-generate

# Run migrations (automatic on server start)
# Migrations are in db/migrations/
```

### Debug Import Feature

```bash
# Use debug-import tool to test import flow
go run cmd/debug-import/main.go
```

---

## Known Issues / TODOs

### General
- [ ] Consider adding rate limiting
- [ ] Add backup reminder for users
- [ ] Add import preview (show entries before importing)

---

## Architecture Notes

### Zero-Knowledge Model

```
┌─────────────┐
│   Browser   │
│ + PGP crypto│
│ + Encryption│
└──────┬──────┘
       │ HTTPS
       │ (encrypted blobs only)
┌──────▼──────┐
│   Server    │
│ + Storage   │
│ - No decrypt│
└─────────────┘
```

**Key Points:**
- Server NEVER sees plaintext passwords
- Server NEVER sees private keys
- All crypto happens in browser
- Server stores only encrypted blobs

### Import Flow (Client-Side)

```
1. User selects .tar.gz
2. Browser extracts tar.gz (fflate)
3. For each .gpg file:
   a. Decrypt with imported private key
   b. Re-encrypt with account public key
   c. Clear plaintext from memory
4. Upload re-encrypted blobs to server
5. Clear imported private key from memory
```

---

## Useful Commands

```bash
# Generate JWT secret
openssl rand -hex 32

# View container logs
docker compose logs -f

# Rebuild and restart
docker compose down && docker compose up --build

# Check container health
docker compose ps

# Access container shell
docker compose exec webpass sh
```

---

## Contact / Support

- GitHub: https://github.com/johnwmail/webpass
- Issues: https://github.com/johnwmail/webpass/issues

---

**Last Updated**: 2026-03-13
**Last Commit**: 9c082bf - fix: Use github.repository for Docker Hub tags
