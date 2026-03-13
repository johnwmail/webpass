#!/bin/bash
# Create a test .password-store archive for import testing

set -e

TEMP_DIR=$(mktemp -d)
PASSWORD_STORE="$TEMP_DIR/.password-store"

mkdir -p "$PASSWORD_STORE"

# Create some test password entries (simulating pass format)
mkdir -p "$PASSWORD_STORE/Email"
mkdir -p "$PASSWORD_STORE/Social"
mkdir -p "$PASSWORD_STORE/Finance"

echo "test-email-blob-gpg-encrypted" > "$PASSWORD_STORE/Email/gmail.com.gpg"
echo "test-social-blob-gpg-encrypted" > "$PASSWORD_STORE/Social/github.com.gpg"
echo "test-finance-blob-gpg-encrypted" > "$PASSWORD_STORE/Finance/bank.gpg"

# Create the tar.gz
cd "$TEMP_DIR"
tar -czf test-password-store.tar.gz .password-store

# Move to webpass directory
mv test-password-store.tar.gz /home/exedev/webpass/

# Cleanup
rm -rf "$TEMP_DIR"

echo "✓ Created test-password-store.tar.gz in /home/exedev/webpass/"
echo "Contents:"
tar -tzf /home/exedev/webpass/test-password-store.tar.gz
