# Container Deployment Guide

WebPass is designed to run in containers. The backend runs as a Docker container, and the frontend can be either:
- **Option A**: Served statically by the backend (single container deployment)
- **Option B**: Hosted separately on Cloudflare Pages (frontend) + Docker container (backend API)

This guide covers Docker Compose and standalone Docker deployments for the backend.

## Quick Start (Docker Compose)

### 1. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Generate JWT secret (or set a fixed value for production)
# Note: Random key is fine for single-instance with short sessions
# For multi-instance or long sessions, use a fixed value
openssl rand -hex 32 >> .env
```

### 2. Build and Run

```bash
# Build image (includes frontend + backend)
docker-compose build

# Start container
docker-compose up -d

# View logs
docker-compose logs -f
```

### 3. Access

Open http://localhost:8080

---

## Docker (Without Compose)

### Build Image

```bash
docker build -t webpass:latest .
```

### Run Container

```bash
# Generate JWT secret (or use a fixed value for production)
# Random key is fine for single-instance with short sessions
# For multi-instance or long sessions, use a fixed value
JWT_SECRET=$(openssl rand -hex 32)

docker run -d \
  --name webpass \
  -p 8080:8080 \
  -v webpass-data:/data \
  -e JWT_SECRET="$JWT_SECRET" \
  --read-only \
  --security-opt no-new-privileges:true \
  webpass:latest
```

### View Logs

```bash
docker logs -f webpass
```

### Stop/Remove

```bash
docker stop webpass
docker rm webpass
docker volume rm webpass-data
```

---

## Git Sync Configuration

For users who want to sync encrypted entries to a Git repository:

### Environment Variables (Optional)

| Variable            | Default       | Description                          |
|---------------------|---------------|--------------------------------------|
| `GIT_REPO_ROOT`     | `.git-repos`  | Base directory for cloned git repos  |
| `DISABLE_FRONTEND`  | `false`       | Disable frontend serving (`1`/`true` to disable) |
| `STATIC_DIR`        | `frontend/dist` | Frontend static files directory    |

### Volume Mount for Git Repos

If using git sync feature, mount a persistent volume for git repositories:

```bash
docker run -d \
  --name webpass \
  -p 8080:8080 \
  -v webpass-data:/data \
  -e JWT_SECRET="$JWT_SECRET" \
  --read-only \
  --security-opt no-new-privileges:true \
  webpass:latest
```

### User Setup (In-App)

Git sync is configured per-user via the Settings page:

1. Open Settings → Git Sync
2. Enter repository URL (HTTPS)
3. Enter PAT (Personal Access Token)
4. Enter login password (to encrypt PAT)
5. Click Save

See [GITSYNC.md](GITSYNC.md) for detailed git sync documentation.

---

## Push to Registry

```bash
# Tag image
docker tag webpass:latest ghcr.io/yourusername/webpass:latest

# Push
docker push ghcr.io/yourusername/webpass:latest
```

---

## Security Hardening

The container is configured with security best practices:

| Feature | Description |
|---------|-------------|
| **Non-root user** | Runs as UID/GID 8080:8080 |
| **Read-only filesystem** | Root filesystem is read-only (`--read-only`) |
| **Writable path** | Only `/data` (SQLite + git repos) is writable |
| **No privilege escalation** | `--security-opt no-new-privileges:true` |
| **File ownership** | `/app` and `/frontend/dist` owned by root (read-only for app user) |

### Docker Compose Security Options

```yaml
read_only: true
security_opt:
  - no-new-privileges:true
```

### Custom UID/GID

If you need to change the UID/GID from 8080:8080, modify the Dockerfile:

```dockerfile
RUN addgroup -g <GID> appgroup && \
    adduser -D -u <UID> -G appgroup appuser
```

---

## Kubernetes

See `k8s/deployment.yaml` for K8s manifests.

```bash
# Deploy
kubectl apply -f k8s/deployment.yaml

# Port-forward for testing
kubectl port-forward svc/webpass -n webpass 8080:8080
```
