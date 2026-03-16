#!/bin/bash
# Build and deploy WebPass with version info from git

set -e

cd "$(dirname "$0")"

# Get git info
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "vdev")

echo "Building WebPass..."
echo "  Version: $VERSION"
echo "  Commit:  $COMMIT"
echo "  Time:    $BUILD_TIME"

# Export for docker-compose
export VERSION
export COMMIT
export BUILD_TIME
export FRONTEND_VERSION="$VERSION"
export FRONTEND_COMMIT="$COMMIT"
export FRONTEND_BUILD_TIME="$BUILD_TIME"

# Build and restart
docker compose build --no-cache
docker compose down
docker compose up -d

echo ""
echo "✓ Deployment complete!"
echo "  Container: $(docker compose ps -q)"
echo "  Version:   $VERSION"
echo "  Commit:    $COMMIT"
