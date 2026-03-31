#!/bin/bash
#
# Run Playwright E2E tests locally
# Playwright starts the server automatically via webServer config
#
# By default: Runs comprehensive test suite:
#   - Phase 1: ALL tests in Protected mode (excluding registration)
#   - Phase 2: Registration tests in Open mode
#   - Phase 3: Registration tests in Protected mode
#   - Phase 4: Registration tests in Disabled mode
#
# Usage: ./playwright-e2e-test.sh [OPTIONS] [playwright args...]
#
# Options:
#   --mode MODE    Test mode: all, protected, open, disabled, registration
#                  Default: all (comprehensive suite)
#                  - all: All tests + registration in all 3 modes
#                  - protected: All tests in Protected mode only
#                  - open: All tests in Open mode only
#                  - disabled: Registration tests in Disabled mode only
#                  - registration: Registration tests only (all 3 modes)
#
# Examples:
#   ./playwright-e2e-test.sh                    # Comprehensive suite (default)
#   ./playwright-e2e-test.sh --mode protected   # All tests, Protected mode only
#   ./playwright-e2e-test.sh --mode open        # All tests, Open mode only
#   ./playwright-e2e-test.sh --mode disabled    # Registration tests, Disabled mode only
#   ./playwright-e2e-test.sh --mode registration # Registration tests only (3 modes)
#   ./playwright-e2e-test.sh --headed           # Run with browser UI visible
#   ./playwright-e2e-test.sh --workers=1        # Run with single worker
#   ./playwright-e2e-test.sh --grep "login"     # Filter tests by name
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

    # Remove temp database file and associated SQLite files
    if [ -n "$DB_FILE" ]; then
        rm -f "$DB_FILE" 2>/dev/null || true
        rm -f "${DB_FILE}-shm" 2>/dev/null || true
        rm -f "${DB_FILE}-wal" 2>/dev/null || true
        log_info "Removed database file: $DB_FILE"
    fi

    # Remove all webpass test database files from /tmp
    rm -f /tmp/webpass-test-*.db 2>/dev/null || true
    rm -f /tmp/webpass-test-*.db-shm 2>/dev/null || true
    rm -f /tmp/webpass-test-*.db-wal 2>/dev/null || true
    rm -f /tmp/webpass-playwright-test.db 2>/dev/null || true
    rm -f /tmp/webpass-playwright-test.db-shm 2>/dev/null || true
    rm -f /tmp/webpass-playwright-test.db-wal 2>/dev/null || true

    # Remove registration code file
    rm -f "$REGISTRATION_CODE_FILE" 2>/dev/null || true
    log_info "Removed registration code file"

    # Remove git-repos directory if it exists
    if [ -d "$GIT_REPO_ROOT" ]; then
        rm -rf "$GIT_REPO_ROOT"
        log_info "Removed git-repos directory: $GIT_REPO_ROOT"
    fi

    # Remove any leftover git-repos in /tmp
    rm -rf /tmp/git-repos 2>/dev/null || true

    # Remove any core dumps or temp files
    rm -f "$ROOT_DIR/core" 2>/dev/null || true

    log_info "Cleanup complete"

    # Preserve the original exit code
    return $exit_code
}

# Set trap to cleanup on exit, interrupt, or termination
trap cleanup EXIT INT TERM HUP

cd "$ROOT_DIR"

# Kill any existing webpass server on port 8080/8000 to avoid conflicts
log_info "Checking for existing servers..."
for port in 8080 8000; do
    pid=$(lsof -ti:$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        log_warn "Killing process on port $port (PID: $pid)"
        kill -9 $pid 2>/dev/null || true
        sleep 1
    fi
done
# Kill specific server binaries (not using -f pattern to avoid killing ourselves)
kill -9 $(pgrep -x "webpass-server" 2>/dev/null) 2>/dev/null || true
kill -9 $(pgrep -x "webpass" 2>/dev/null) 2>/dev/null || true
sleep 1
log_info "Port cleanup complete"

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

# Registration code file path (must match server config)
REGISTRATION_CODE_FILE="/tmp/registration_code.txt"

# Set base environment variables (passed to Playwright, which passes to server)
export JWT_SECRET
export DB_PATH="$DB_FILE"
export STATIC_DIR=frontend/dist
export DISABLE_FRONTEND=false
export GIT_REPO_ROOT="$ROOT_DIR/git-repos"

# Create git repos directory if it doesn't exist
mkdir -p "$GIT_REPO_ROOT"

# Install Playwright browsers if needed
log_info "Ensuring Playwright browsers are installed..."
cd "$FRONTEND_DIR"
# Install browsers without system dependencies (sudo not available in containers)
npx playwright install chromium

# Return to root directory
cd "$ROOT_DIR"

# =============================================================================
# Parse command-line arguments
# =============================================================================
MODE="all"
PLAYWRIGHT_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        --mode)
            MODE="$2"
            shift 2
            ;;
        --mode=*)
            MODE="${1#*=}"
            shift
            ;;
        *)
            PLAYWRIGHT_ARGS+=("$1")
            shift
            ;;
    esac
done

# Validate mode
if [[ ! "$MODE" =~ ^(all|protected|open|disabled|registration)$ ]]; then
    log_error "Invalid mode: $MODE (valid: all, protected, open, disabled, registration)"
    exit 1
fi

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
log_info "  Mode: $MODE"

# =============================================================================
# Run tests for each mode
# Each mode runs as a separate Playwright invocation, which starts a fresh
# server with the correct environment variables via webServer config.
# =============================================================================

run_protected_mode() {
    log_info ""
    log_info "========================================="
    log_info "Protected Mode (TOTP code required) - ALL TESTS"
    log_info "========================================="
    log_info ""

    # Set Protected Mode environment variables
    export REGISTRATION_ENABLED=true
    export REGISTRATION_TOTP_SECRET="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    export REGISTRATION_TOTP_PERIOD=3600
    export REGISTRATION_TOTP_ALGO=SHA1
    export REGISTRATION_CODE_FILE="$REGISTRATION_CODE_FILE"

    log_info "  REGISTRATION_ENABLED: true"
    log_info "  REGISTRATION_TOTP_SECRET: ***CONFIGURED***"
    log_info "  REGISTRATION_TOTP_PERIOD: 3600 seconds (1 hour)"
    log_info "  REGISTRATION_CODE_FILE: $REGISTRATION_CODE_FILE"
    log_info "  Running: ALL E2E tests"

    # Run ALL tests - Playwright starts server automatically
    cd "$FRONTEND_DIR"
    npx playwright test "${PLAYWRIGHT_ARGS[@]}"
    local exit_code=$?
    cd "$ROOT_DIR"
    return $exit_code
}

run_open_mode() {
    log_info ""
    log_info "========================================="
    log_info "Open Mode (no TOTP required) - ALL TESTS"
    log_info "========================================="
    log_info ""

    # Set Open Mode environment variables
    export REGISTRATION_ENABLED=true
    export REGISTRATION_TOTP_SECRET=""
    export REGISTRATION_TOTP_PERIOD=""
    export REGISTRATION_TOTP_ALGO=""
    export REGISTRATION_CODE_FILE=""

    log_info "  REGISTRATION_ENABLED: true"
    log_info "  REGISTRATION_TOTP_SECRET: (not set - open mode)"
    log_info "  Running: ALL E2E tests"

    # Run ALL tests - Playwright starts server automatically
    cd "$FRONTEND_DIR"
    npx playwright test "${PLAYWRIGHT_ARGS[@]}"
    local exit_code=$?
    cd "$ROOT_DIR"
    return $exit_code
}

run_disabled_mode() {
    log_info ""
    log_info "========================================="
    log_info "Disabled Mode (registration not allowed) - Registration Tests Only"
    log_info "========================================="
    log_info ""

    # Set Disabled Mode environment variables
    export REGISTRATION_ENABLED=false
    export REGISTRATION_TOTP_SECRET=""
    export REGISTRATION_TOTP_PERIOD=""
    export REGISTRATION_TOTP_ALGO=""
    export REGISTRATION_CODE_FILE=""

    log_info "  REGISTRATION_ENABLED: false"
    log_info "  Running: Registration tests in Disabled mode only"

    # Run only registration-disabled tests - Playwright starts server automatically
    cd "$FRONTEND_DIR"
    npx playwright test tests/e2e/registration-disabled.spec.ts "${PLAYWRIGHT_ARGS[@]}"
    local exit_code=$?
    cd "$ROOT_DIR"
    return $exit_code
}

run_registration_mode() {
    log_info ""
    log_info "========================================="
    log_info "Registration Tests - All 3 Modes"
    log_info "========================================="
    log_info ""

    local total_exit=0

    # Open mode
    export REGISTRATION_ENABLED=true
    export REGISTRATION_TOTP_SECRET=""
    export REGISTRATION_TOTP_PERIOD=""
    export REGISTRATION_TOTP_ALGO=""
    export REGISTRATION_CODE_FILE=""
    log_info "Running Open mode registration tests..."
    cd "$FRONTEND_DIR"
    npx playwright test tests/e2e/registration-open.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
    cd "$ROOT_DIR"

    # Protected mode
    export REGISTRATION_ENABLED=true
    export REGISTRATION_TOTP_SECRET="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    export REGISTRATION_TOTP_PERIOD=3600
    export REGISTRATION_TOTP_ALGO=SHA1
    export REGISTRATION_CODE_FILE="$REGISTRATION_CODE_FILE"
    log_info "Running Protected mode registration tests..."
    cd "$FRONTEND_DIR"
    npx playwright test tests/e2e/registration-protected.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
    cd "$ROOT_DIR"

    # Disabled mode
    export REGISTRATION_ENABLED=false
    export REGISTRATION_TOTP_SECRET=""
    export REGISTRATION_TOTP_PERIOD=""
    export REGISTRATION_TOTP_ALGO=""
    export REGISTRATION_CODE_FILE=""
    log_info "Running Disabled mode registration tests..."
    cd "$FRONTEND_DIR"
    npx playwright test tests/e2e/registration-disabled.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
    cd "$ROOT_DIR"

    return $total_exit
}

# Run ALL tests + registration in all 3 modes (comprehensive test suite)
run_all_tests() {
    log_info ""
    log_info "========================================="
    log_info "Comprehensive Test Suite"
    log_info "========================================="
    log_info ""
    log_info "Phase 1: ALL tests in Protected mode (excluding registration)"
    log_info "Phase 2: Registration tests in Open mode"
    log_info "Phase 3: Registration tests in Protected mode"
    log_info "Phase 4: Registration tests in Disabled mode"
    log_info ""

    local total_exit=0

    # Phase 1: All tests EXCEPT registration in Protected mode
    export REGISTRATION_ENABLED=true
    export REGISTRATION_TOTP_SECRET="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    export REGISTRATION_TOTP_PERIOD=3600
    export REGISTRATION_TOTP_ALGO=SHA1
    export REGISTRATION_CODE_FILE="$REGISTRATION_CODE_FILE"
    log_info "Running all tests in Protected mode (registration tests excluded)..."
    cd "$FRONTEND_DIR"
    npx playwright test --grep-invert "Registration" "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
    cd "$ROOT_DIR"

    # Phase 2: Registration tests in Open mode
    if [ $total_exit -eq 0 ]; then
        # Kill server to force restart with new env vars
        pkill -f "webpass-server" 2>/dev/null || true
        pkill -f "go run.*cmd/srv" 2>/dev/null || true
        sleep 2

        export REGISTRATION_ENABLED=true
        export REGISTRATION_TOTP_SECRET=""
        export REGISTRATION_TOTP_PERIOD=""
        export REGISTRATION_TOTP_ALGO=""
        export REGISTRATION_CODE_FILE=""
        log_info ""
        log_info "Running Open mode registration tests..."
        cd "$FRONTEND_DIR"
        npx playwright test tests/e2e/registration-open.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
        cd "$ROOT_DIR"
    fi

    # Phase 3: Registration tests in Protected mode
    if [ $total_exit -eq 0 ]; then
        # Kill server to force restart with new env vars
        pkill -f "webpass-server" 2>/dev/null || true
        pkill -f "go run.*cmd/srv" 2>/dev/null || true
        sleep 2

        export REGISTRATION_ENABLED=true
        export REGISTRATION_TOTP_SECRET="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
        export REGISTRATION_TOTP_PERIOD=3600
        export REGISTRATION_TOTP_ALGO=SHA1
        export REGISTRATION_CODE_FILE="$REGISTRATION_CODE_FILE"
        log_info ""
        log_info "Running Protected mode registration tests..."
        cd "$FRONTEND_DIR"
        npx playwright test tests/e2e/registration-protected.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
        cd "$ROOT_DIR"
    fi

    # Phase 4: Registration tests in Disabled mode
    if [ $total_exit -eq 0 ]; then
        # Kill server to force restart with new env vars
        pkill -f "webpass-server" 2>/dev/null || true
        pkill -f "go run.*cmd/srv" 2>/dev/null || true
        sleep 2

        export REGISTRATION_ENABLED=false
        export REGISTRATION_TOTP_SECRET=""
        export REGISTRATION_TOTP_PERIOD=""
        export REGISTRATION_TOTP_ALGO=""
        export REGISTRATION_CODE_FILE=""
        log_info ""
        log_info "Running Disabled mode registration tests..."
        cd "$FRONTEND_DIR"
        npx playwright test tests/e2e/registration-disabled.spec.ts "${PLAYWRIGHT_ARGS[@]}" || total_exit=$?
        cd "$ROOT_DIR"
    fi

    return $total_exit
}

# Run tests based on mode selection
TOTAL_EXIT_CODE=0

case $MODE in
    all)
        # Comprehensive suite: All tests + registration in all 3 modes
        run_all_tests || TOTAL_EXIT_CODE=$?
        ;;
    protected)
        run_protected_mode || TOTAL_EXIT_CODE=$?
        ;;
    open)
        run_open_mode || TOTAL_EXIT_CODE=$?
        ;;
    disabled)
        run_disabled_mode || TOTAL_EXIT_CODE=$?
        ;;
    registration)
        run_registration_mode || TOTAL_EXIT_CODE=$?
        ;;
esac

if [ $TOTAL_EXIT_CODE -ne 0 ]; then
    log_error "Tests failed (exit code: $TOTAL_EXIT_CODE)"
    exit $TOTAL_EXIT_CODE
fi

log_info ""
log_info "========================================="
log_info "All tests passed!"
log_info "========================================="

exit 0
