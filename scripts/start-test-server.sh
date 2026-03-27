#!/bin/bash
# Wrapper script to start test server
# This avoids SQLite "out of memory" issues when Go is launched from Node.js child_process

cd "$(dirname "$0")/.."

exec go run ./cmd/srv
