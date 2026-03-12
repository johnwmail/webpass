# 🔐 WebPass

A web-based password manager with zero-knowledge architecture. All cryptography happens client-side in the browser using OpenPGP.js. The server stores only encrypted blobs — it never sees plaintext passwords or private keys.

[![CI](https://github.com/johnwmail/webpass/actions/workflows/ci.yml/badge.svg)](https://github.com/johnwmail/webpass/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go)](https://go.dev)

## ✨ Features

- **Client-side encryption** — PGP encryption/decryption in the browser with OpenPGP.js
- **Zero-knowledge architecture** — Server never sees plaintext passwords or private keys
- **Multi-user support** — Each user identified by their PGP key fingerprint
- **Two-factor authentication** — Optional TOTP (2FA) for server access
- **Import/Export** — Compatible with standard `.password-store` directory format
- **Password generator** — Configurable random password generation
- **Session management** — 5-minute JWT sessions with automatic expiry
- **Git sync** — Backup and sync encrypted entries to any Git repository (GitHub, GitLab, Gitea)

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│  Browser (SPA on Cloudflare Pages)  │
│  + OpenPGP.js + IndexedDB           │
└──────────────┬──────────────────────┘
               │ HTTPS + CORS
┌──────────────▼──────────────────────┐
│  Go API Server (SQLite backend)     │
│  + JWT Auth + bcrypt + TOTP         │
└─────────────────────────────────────┘
```

## 🛠️ Tech Stack

| Layer    | Technology                              |
| -------- | --------------------------------------- |
| Frontend | TypeScript + Preact + Vite             |
| Crypto   | OpenPGP.js + Web Crypto API (PBKDF2)   |
| Backend  | Go 1.26 + SQLite (pure-Go, no CGO)     |
| Auth     | bcrypt + JWT (5-min) + TOTP (2FA)      |
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
make build

# Build frontend (optional, for static serving)
cd frontend && npm run build
```

### Run

```bash
# Set environment variables
export JWT_SECRET=$(openssl rand -hex 32)
export DB_PATH=./db.sqlite3

# Run server
./webpass-server
```

Server listens on `:8000` by default.

## 📦 Deployment

### Docker

```bash
# Build image
docker build -t webpass:latest .

# Run container
docker run -d \
  --name webpass \
  -p 8000:8000 \
  -v webpass-data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  webpass:latest
```

### Docker Compose

```bash
# Configure environment
cp .env.example .env
# Edit .env and set JWT_SECRET

# Start
docker-compose up -d
```

### Kubernetes

```bash
kubectl apply -f k8s/deployment.yaml
```

📖 See [DEPLOY.md](DEPLOY.md) for detailed deployment instructions.

## 📡 API Endpoints

All endpoints require JWT authentication.

| Method | Path                      | Auth  | Description                           |
| ------ | ------------------------- | ----- | ------------------------------------- |
| POST   | `/api/users`              | No    | Create user (first-time setup)        |
| POST   | `/api/users/:fp/login`    | No    | Login → returns JWT or 2FA challenge  |
| POST   | `/api/users/:fp/login/2fa`| No    | Complete 2FA login                    |
| GET    | `/api/users/:fp/entries`  | JWT   | List all entry paths                  |
| GET    | `/api/users/:fp/entries/*`| JWT   | Download encrypted blob               |
| PUT    | `/api/users/:fp/entries/*`| JWT   | Upload encrypted blob                 |
| DELETE | `/api/users/:fp/entries/*`| JWT   | Delete entry                          |
| POST   | `/api/users/:fp/entries/move` | JWT | Rename/move entry                   |
| GET    | `/api/users/:fp/export`   | JWT   | Export all entries as `.tar.gz`       |
| POST   | `/api/users/:fp/import`   | JWT   | Import `.tar.gz` password store       |
| GET    | `/api/users/:fp/git/status` | JWT | Get git sync status                 |
| POST   | `/api/users/:fp/git/config` | JWT | Configure git sync                  |
| POST   | `/api/users/:fp/git/push`   | JWT | Manual push to remote               |
| POST   | `/api/users/:fp/git/pull`   | JWT | Manual pull from remote             |

📖 See [GITSYNC.md](GITSYNC.md) for detailed git sync documentation.

## 🔒 Security Model

- **Private keys never leave the browser** — Stored AES-wrapped in IndexedDB
- **Server stores only PGP-encrypted blobs** — Database leak reveals nothing
- **Password validates locally first** — Wrong password fails before network call
- **5-minute sessions** — JWT expiry enforced server-side
- **CORS locked** to specific origins via `CORS_ORIGINS` env var
- **All traffic over HTTPS** required in production

📖 See [SECURITY.md](SECURITY.md) for security policy and vulnerability reporting.

## ⚙️ Environment Variables

| Variable       | Required | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `JWT_SECRET`   | Yes      | 32-byte hex string for JWT signing       |
| `DB_PATH`      | No       | Path to SQLite database (default: `db.sqlite3`) |
| `STATIC_DIR`   | No       | Path to frontend `dist/` directory       |
| `CORS_ORIGINS` | No       | Comma-separated allowed origins          |

## 📁 Project Structure

```
.
├── .github/workflows/   # CI/CD pipelines
├── cmd/srv/            # Main binary entrypoint
├── srv/                # HTTP server + handlers
├── db/                 # Database migrations + sqlc queries
├── frontend/           # Preact + TypeScript SPA
│   ├── src/
│   ├── index.html
│   └── package.json
├── k8s/                # Kubernetes manifests
├── docs/               # Documentation
├── Dockerfile
├── docker-compose.yml
└── srv.service         # systemd unit file
```

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

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

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Inspired by [pass](https://www.passwordstore.org/)
- Built with [OpenPGP.js](https://openpgpjs.org/)
- Backend powered by [Go](https://go.dev/) and [SQLite](https://www.sqlite.org/)
