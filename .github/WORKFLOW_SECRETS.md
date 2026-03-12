# GitHub Actions Secrets & Variables

This document lists all required secrets and variables for the CI/CD workflows.

## Configuration

Configure these in your GitHub repository settings:
**Settings → Secrets and variables → Actions**

---

## Secrets (Required)

| Name | Description | Where to Get |
|------|-------------|--------------|
| `DOCKER_USERNAME` | Docker Hub username | Your Docker Hub account username |
| `DOCKER_PASSWORD` | Docker Hub access token or password | Docker Hub → Account Settings → Security → New Access Token (or use password) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for Pages deployment | Cloudflare Dashboard → Profile → API Tokens → Create Token (use "Edit Cloudflare Pages" template) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID | Cloudflare Dashboard → Workers & Pages → Account details (right sidebar) |

**Note:** `DOCKER_PASSWORD` is used for both Docker Hub and GitHub Container Registry (GHCR). For GHCR, use a GitHub Personal Access Token with `read:packages` and `write:packages` scopes.

---

## Variables (Optional)

| Name | Description | Example Value |
|------|-------------|---------------|
| `CLOUDFLARE_PAGES_PROJECT` | Name of your Cloudflare Pages project | `webpass-frontend` |

---

## Setup Instructions

### 1. Docker Hub & GitHub Container Registry

The `build-container.yml` workflow pushes to both registries on version tags.

**For Docker Hub:**
1. Go to [Docker Hub](https://hub.docker.com/) and create account (if needed)
2. Generate access token: Account Settings → Security → New Access Token
3. Set secrets:
   - `DOCKER_USERNAME`: your Docker Hub username
   - `DOCKER_PASSWORD`: the token you created

**For GitHub Container Registry (GHCR):**
1. Go to **GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Generate token with scopes: `read:packages`, `write:packages`, `delete:packages`
3. The workflow uses `${{ github.actor }}` as username (your GitHub username)
4. Set secret:
   - `DOCKER_PASSWORD`: the GitHub PAT (same secret works for both registries)

**Images will be pushed to:**
- `ghcr.io/johnwmail/webpass:<version>` and `:latest`
- `johnwmail/webpass:<version>` and `:latest` (Docker Hub)

### 2. Cloudflare Pages (Optional)

1. **Create a Pages project:**
   - Go to Cloudflare Dashboard → Workers & Pages → Create application → Pages
   - Connect your GitHub repo (or create empty project)

2. **Get Account ID:**
   - Go to Workers & Pages → Your account name (right sidebar shows Account ID)

3. **Create API Token:**
   - Go to Profile → API Tokens → Create Token
   - Use "Edit Cloudflare Pages" template
   - Select your account and specific project
   - Copy the token

4. **Set secrets:**
   - `CLOUDFLARE_API_TOKEN`: the token you created
   - `CLOUDFLARE_ACCOUNT_ID`: your account ID

5. **Set variables:**
   - `CLOUDFLARE_PAGES_PROJECT`: your Pages project name

---

## Workflow Triggers

| Workflow | Trigger |
|----------|---------|
| `ci.yml` | Every push/PR to `main`, manual dispatch |
| `build-container.yml` | Push tag starting with `v` (e.g., `v0.0.1`) |
| `deploy.yml` | Push tag starting with `v` (e.g., `v0.0.1`) |

---

## Quick Setup Checklist

- [ ] Create Docker Hub account (if needed)
- [ ] Generate GitHub PAT with `read:packages`, `write:packages`
- [ ] Add `DOCKER_USERNAME` secret (Docker Hub username)
- [ ] Add `DOCKER_PASSWORD` secret (GitHub PAT or Docker Hub token)
- [ ] (Optional) Create Cloudflare Pages project
- [ ] (Optional) Add `CLOUDFLARE_API_TOKEN` secret
- [ ] (Optional) Add `CLOUDFLARE_ACCOUNT_ID` secret
- [ ] (Optional) Add `CLOUDFLARE_PAGES_PROJECT` variable
- [ ] Test with a tag: `git tag v0.0.1 && git push origin v0.0.1`
