#!/bin/bash
#
# Run Playwright E2E tests locally
# Starts the server, runs tests, and cleans up on exit
#
# Usage: ./scripts/test-e2e.sh [playwright args...]
#
# Examples:
#   ./scripts/test-e2e.sh                    # Run all tests
#   ./scripts/test-e2e.sh --grep "login"     # Run tests matching "login"
#   ./scripts/test-e2e.sh --project chromium # Run only Chromium tests
#   ./scripts/test-e2e.sh --debug            # Run in debug mode
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$ROOT_DIR/frontend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Cleanup function
cleanup() {
    local exit_code=$?
    
    log_warn "Cleaning up..."
    
    # Kill server process and all children
    if [ -n "$SERVER_PID" ]; then
        # Kill process group (includes child processes)
        kill -TERM -$SERVER_PID 2>/dev/null || true
        kill -TERM $SERVER_PID 2>/dev/null || true
        sleep 1
        # Force kill if still running
        kill -KILL -$SERVER_PID 2>/dev/null || true
        kill -KILL $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
    
    # Kill any orphaned server processes on port 8080
    if command -v fuser &> /dev/null; then
        fuser -k 8080/tcp 2>/dev/null || true
    elif command -v lsof &> /dev/null; then
        lsof -ti:8080 | xargs kill -9 2>/dev/null || true
    fi
    
    # Remove git-repos directory if it exists
    if [ -d "$GIT_REPO_ROOT" ]; then
        rm -rf "$GIT_REPO_ROOT"
    fi
    
    # Remove any core dumps or temp files
    rm -f "$ROOT_DIR/core" 2>/dev/null || true
    
    log_info "Cleanup complete"
    
    # Preserve the original exit code
    return $exit_code
}

# Set trap to cleanup on exit, interrupt, or termination
trap cleanup EXIT INT TERM HUP

cd "$ROOT_DIR"

# Check if Go is available
if ! command -v go &> /dev/null; then
    log_error "Go is not installed. Please install Go 1.26+"
    exit 1
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js 24+"
    exit 1
fi

# Install Go dependencies
log_info "Installing Go dependencies..."
go mod download

# Install frontend dependencies
log_info "Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm ci

# Build frontend
log_info "Building frontend..."
npm run build

# Return to root directory
cd "$ROOT_DIR"

# Load environment variables from .env file if it exists
if [ -f "$ROOT_DIR/.env" ]; then
    log_info "Loading environment variables from .env..."
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Generate random JWT secret if not set (32 bytes = 64 hex chars)
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
fi

# Set environment variables
export JWT_SECRET
export DB_PATH=:memory:
export STATIC_DIR=frontend/dist
export DISABLE_FRONTEND=false
export GIT_REPO_ROOT="$ROOT_DIR/git-repos"

# Create git repos directory if it doesn't exist
mkdir -p "$GIT_REPO_ROOT"

log_info "Starting server..."
log_info "  JWT_SECRET: ${JWT_SECRET:0:8}... (truncated)"
log_info "  DB_PATH: $DB_PATH"
log_info "  STATIC_DIR: $STATIC_DIR"
log_info "  GIT_REPO_ROOT: $GIT_REPO_ROOT"

# Start server in background
go run ./cmd/srv &
SERVER_PID=$!

# Wait for server to be healthy
log_info "Waiting for server to start..."
for i in {1..30}; do
    if curl -s http://localhost:8080/api/health | grep -q '"status":"ok"'; then
        log_info "Server is healthy!"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Server failed to start after 60 seconds"
        exit 1
    fi
    echo "  Waiting for server... ($i/30)"
    sleep 2
done

# Install Playwright browsers if needed
log_info "Ensuring Playwright browsers are installed..."
cd "$FRONTEND_DIR"
# Install browsers without system dependencies (sudo not available in containers)
npx playwright install chromium

# Run Playwright tests
log_info "Running Playwright tests..."
cd "$FRONTEND_DIR"

# Set test environment variables
export TEST_BASE_URL=http://localhost:8080
export TEST_SKIP_WEBSERVER=true

# Log test configuration
log_info "Test configuration:"
if [ -n "$WEBPASS_REPO_URL" ]; then
    log_info "  WEBPASS_REPO_URL: $WEBPASS_REPO_URL"
else
    log_warn "  WEBPASS_REPO_URL: not set (git-sync tests will be skipped)"
fi
if [ -n "$WEBPASS_REPO_PAT" ]; then
    log_info "  WEBPASS_REPO_PAT: ***REDACTED***"
else
    log_warn "  WEBPASS_REPO_PAT: not set (git-sync tests will be skipped)"
fi

# Run tests with any additional arguments passed to the script
if [ $# -gt 0 ]; then
    npx playwright test "$@"
else
    npx playwright test
fi

TEST_EXIT_CODE=$?

# Cleanup will happen automatically via trap
if [ $TEST_EXIT_CODE -eq 0 ]; then
    log_info "All tests passed!"
else
    log_error "Some tests failed (exit code: $TEST_EXIT_CODE)"
fi

exit $TEST_EXIT_CODE
