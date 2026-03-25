# Multi-stage Dockerfile for WebPass
# Builds both frontend and backend into a single image

# ============================================
# Stage 1: Build Frontend
# ============================================
FROM node:24-alpine AS frontend-builder

WORKDIR /app/frontend

# Build arguments for version injection
ARG FRONTEND_VERSION=vdev
ARG FRONTEND_BUILD_TIME=unknown
ARG FRONTEND_COMMIT=unknown

# Copy package files
COPY frontend/package*.json ./

# Install dependencies
RUN npm ci --frozen-lockfile

# Copy frontend source
COPY frontend/ ./

# Create .env file with version info for Vite to pick up
RUN echo "FRONTEND_VERSION=$FRONTEND_VERSION" > .env.production \
    && echo "FRONTEND_COMMIT=$FRONTEND_COMMIT" >> .env.production \
    && echo "FRONTEND_BUILD_TIME=$FRONTEND_BUILD_TIME" >> .env.production

# Build for production with version injection
RUN npm run build

# Patch index.html with version info (since Vite doesn't replace meta tags)
# Also add cache-busting timestamp to JS/CSS references
RUN sed -i "s|content=\"vdev\"|content=\"$FRONTEND_VERSION\"|g" /app/frontend/dist/index.html \
    && sed -i "s|name=\"build-time\" content=\"unknown\"|name=\"build-time\" content=\"$FRONTEND_BUILD_TIME\"|g" /app/frontend/dist/index.html \
    && sed -i "s|name=\"build-commit\" content=\"unknown\"|name=\"build-commit\" content=\"$FRONTEND_COMMIT\"|g" /app/frontend/dist/index.html \
    && sed -i "s|index-\\([^.]*\\)\\.js|index-\\1.js?v=$FRONTEND_BUILD_TIME|g" /app/frontend/dist/index.html \
    && sed -i "s|index-\\([^.]*\\)\\.css|index-\\1.css?v=$FRONTEND_BUILD_TIME|g" /app/frontend/dist/index.html || true


# ============================================
# Stage 2: Build Backend
# ============================================
FROM golang:1.26-alpine AS backend-builder

WORKDIR /app

# Build arguments for version injection
ARG VERSION=vdev
ARG BUILD_TIME=unknown
ARG COMMIT=unknown

# Copy Go modules
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create empty data directory structure (will be populated at runtime)
RUN mkdir -p /app/data/db /app/data/git-repos

# Build binary (CGO disabled - using pure-Go SQLite)
RUN CGO_ENABLED=0 GOOS=linux go build -o webpass-server \
    -ldflags="-s -w -X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.Commit=${COMMIT}" \
    ./cmd/srv


# ============================================
# Stage 3: Runtime Image
# ============================================
# Distroless static - minimal secure image with only ca-certificates included
# Runs as nonroot user (UID 8080) by default. No shell available.
FROM gcr.io/distroless/static:nonroot

USER 0
WORKDIR /app

# Copy binary from builder (owned by root, will be run by UID 8080)
COPY --from=backend-builder /app/webpass-server .

# Copy frontend assets
COPY --from=backend-builder /app/frontend/dist ./frontend/dist

# Create data directory with proper ownership using COPY --chown
# Distroless nonroot user is UID 8080 (standard nobody user)
# We create an empty directory in builder and copy with --chown
COPY --chown=8080:8080 --from=backend-builder /app/data/ /data/

# Default environment variables
ENV PORT=8080
ENV DB_PATH=/data/db/db.sqlite3
ENV STATIC_DIR=/app/frontend/dist
ENV GIT_REPO_ROOT=/data/git-repos

USER 8080:8080
EXPOSE 8080

# Run with read-only root filesystem (only /data is writable)
# Distroless static:nonroot already runs as UID 8080 (nonroot)
CMD ["./webpass-server"]
