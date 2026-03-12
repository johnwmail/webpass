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

# Build for production with version injection
RUN FRONTEND_VERSION=${FRONTEND_VERSION} \
    FRONTEND_BUILD_TIME=${FRONTEND_BUILD_TIME} \
    FRONTEND_COMMIT=${FRONTEND_COMMIT} \
    npm run build


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

# Build binary (CGO disabled - using pure-Go SQLite)
RUN CGO_ENABLED=0 GOOS=linux go build -o webpass-server \
    -ldflags="-s -w -X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.Commit=${COMMIT}" \
    ./cmd/srv


# ============================================
# Stage 3: Runtime Image
# ============================================
FROM alpine:3.21

WORKDIR /app

# Install runtime dependencies
# - ca-certificates: HTTPS/TLS support
# - git: Git Sync feature
# - wget: healthcheck
RUN apk add --no-cache ca-certificates git wget

# Create non-root user and group with specific UID/GID
RUN addgroup -g 8080 appgroup && \
    adduser -D -u 8080 -G appgroup appuser

# Copy binary from builder (owned by root)
COPY --from=backend-builder /app/webpass-server .

# Copy frontend assets (owned by root)
COPY --from=backend-builder /app/frontend/dist ./frontend/dist

# Create data directory for SQLite and git repos with proper ownership
RUN mkdir -p /data/db /data/git-repos && \
    chown -R 8080:8080 /data && \
    chmod 700 /data

# Drop privileges and set read-only filesystem
USER 8080:8080

# Default environment variables
ENV PORT=8080
ENV DB_PATH=/data/db/db.sqlite3
ENV STATIC_DIR=/app/frontend/dist
ENV GIT_REPO_ROOT=/data/git-repos

EXPOSE 8080

VOLUME ["/data"]

# Run with read-only root filesystem (only /data is writable)
CMD ["./webpass-server"]
