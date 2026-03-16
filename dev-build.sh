#!/bin/bash
# Build and deploy WebPass with version info from git
# Usage: ./dev-build.sh [user@host:~/webpass]

set -e

cd "$(dirname "$0")"

REMOTE="${1:-}"

# Get git info BEFORE rsync (we need .git directory)
COMMIT=$(git rev-parse --short=7 HEAD 2>&1) || COMMIT="unknown"
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Get base version from tag (e.g., v0.1.1)
BASE_VERSION=$(git describe --tags --always 2>/dev/null | grep -oE '^v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "v0.1.1")

# Format version as v0.1.1-<7-char-hash> for dev builds
if [ "$COMMIT" != "unknown" ] && [ -n "$COMMIT" ]; then
    VERSION="${BASE_VERSION}-${COMMIT}"
else
    VERSION="v0.1.1-local"
fi

echo "Building WebPass..."
echo "  Version: $VERSION"
echo "  Commit:  $COMMIT"
echo "  Time:    $BUILD_TIME"

# If remote specified, rsync and run remotely
if [ -n "$REMOTE" ]; then
    echo "Syncing to $REMOTE..."
    rsync -avz --delete ./ "$REMOTE" --exclude 'node_modules' --exclude '.git'
    ssh "${REMOTE%%:*}" "cd ${REMOTE#*:} && export VERSION=$VERSION COMMIT=$COMMIT BUILD_TIME=$BUILD_TIME FRONTEND_VERSION=$VERSION FRONTEND_COMMIT=$COMMIT FRONTEND_BUILD_TIME=$BUILD_TIME && docker compose build --no-cache && docker compose down && docker compose up -d"
    echo ""
    echo "✓ Deployment complete!"
    echo "  Version: $VERSION"
    echo "  Commit:  $COMMIT"
else
    # Local build
    export VERSION
    export COMMIT
    export BUILD_TIME
    export FRONTEND_VERSION="$VERSION"
    export FRONTEND_COMMIT="$COMMIT"
    export FRONTEND_BUILD_TIME="$BUILD_TIME"
    
    docker compose build --no-cache
    docker compose down
    docker compose up -d
    
    echo ""
    echo "✓ Deployment complete!"
    echo "  Version: $VERSION"
    echo "  Commit:  $COMMIT"
fi
