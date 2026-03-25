#!/bin/bash
#
# Run Playwright E2E tests locally
# Playwright starts the server automatically via webServer config
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

    # Remove temp database file if it exists
    if [ -n "$DB_FILE" ] && [ -f "$DB_FILE" ]; then
        rm -f "$DB_FILE"
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

# Use temp file for database (more reliable than :memory: for local testing)
DB_FILE="/tmp/webpass-test-$(date +%s).db"

# Set environment variables (passed to Playwright, which passes to server)
export JWT_SECRET
export DB_PATH="$DB_FILE"
export STATIC_DIR=frontend/dist
export DISABLE_FRONTEND=false
export GIT_REPO_ROOT="$ROOT_DIR/git-repos"

# Create git repos directory if it doesn't exist
mkdir -p "$GIT_REPO_ROOT"

log_info "Test configuration:"
log_info "  JWT_SECRET: ${JWT_SECRET:0:8}... (truncated)"
log_info "  DB_PATH: $DB_PATH"
log_info "  STATIC_DIR: $STATIC_DIR"
log_info "  GIT_REPO_ROOT: $GIT_REPO_ROOT"

# Install Playwright browsers if needed
log_info "Ensuring Playwright browsers are installed..."
cd "$FRONTEND_DIR"
# Install browsers without system dependencies (sudo not available in containers)
npx playwright install chromium

# Run Playwright tests
log_info "Running Playwright tests..."

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
# Playwright will start the server automatically via webServer config
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
