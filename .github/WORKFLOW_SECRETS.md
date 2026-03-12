# GitHub Actions Secrets & Variables

This document lists all required secrets and variables for the CI/CD workflows.

## Configuration

Configure these in your GitHub repository settings:
**Settings → Secrets and variables → Actions**

---

## Secrets (Required)

| Name | Description | Where to Get |
|------|-------------|--------------|
| `CONTAINER_REGISTRY_USERNAME` | Username for container registry | Your registry provider (Docker Hub, GHCR, etc.) |
| `CONTAINER_REGISTRY_PASSWORD` | Password/access token for container registry | Generate a personal access token with `write:packages` scope |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for Pages deployment | Cloudflare Dashboard → Profile → API Tokens → Create Token (use "Edit Cloudflare Pages" template) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID | Cloudflare Dashboard → Workers & Pages → Account details (right sidebar) |

---

## Variables (Required)

| Name | Description | Example Value |
|------|-------------|---------------|
| `CONTAINER_REGISTRY` | Container registry hostname | `ghcr.io` or `docker.io` |
| `CONTAINER_IMAGE_NAME` | Full image name (org/repo) | `johnwmail/webpass` |
| `CLOUDFLARE_PAGES_PROJECT` | Name of your Cloudflare Pages project | `webpass-frontend` |

---

## Setup Instructions

### 1. Container Registry (GitHub Container Registry - Recommended)

1. Go to **GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Generate a new token with scopes: `read:packages`, `write:packages`
3. Set secrets:
   - `CONTAINER_REGISTRY_USERNAME`: your GitHub username
   - `CONTAINER_REGISTRY_PASSWORD`: the token you just created
4. Set variables:
   - `CONTAINER_REGISTRY`: `ghcr.io`
   - `CONTAINER_IMAGE_NAME`: `your-username/webpass`

### 2. Cloudflare Pages

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
| `ci.yml` | Every push/PR to `main` or `master` |
| `build-container.yml` | Push tag starting with `v` (e.g., `v0.0.1`) |
| `deploy.yml` | Push tag starting with `v` (e.g., `v0.0.1`) |

---

## Quick Setup Checklist

- [ ] Create container registry credentials
- [ ] Add `CONTAINER_REGISTRY_USERNAME` secret
- [ ] Add `CONTAINER_REGISTRY_PASSWORD` secret
- [ ] Add `CONTAINER_REGISTRY` variable
- [ ] Add `CONTAINER_IMAGE_NAME` variable
- [ ] Create Cloudflare Pages project
- [ ] Add `CLOUDFLARE_API_TOKEN` secret
- [ ] Add `CLOUDFLARE_ACCOUNT_ID` secret
- [ ] Add `CLOUDFLARE_PAGES_PROJECT` variable
- [ ] Test with a tag: `git tag v0.0.1 && git push origin v0.0.1`
