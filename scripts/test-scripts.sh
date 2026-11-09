#!/usr/bin/env bash
# test-scripts.sh — end-to-end tests for the CLI helper scripts.
#
# Used by .github/workflows/scripts.yml. Requires: bash, curl, gpg, jq, tar,
# find, go.
#
# The tests run against a real server binary with a temporary SQLite database
# and temporary GnuPG homes; nothing outside the temp directory is touched.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/webpass-scripts-test.XXXXXX")
SERVER_PID=""
PORT1=18085
PORT2=18086
LOGIN_PW='script-login-password'
LOGIN_PW2='script-login-password-2'
PGP_PASS='script-pgp-passphrase'
KEY_HOME="$WORK/gnupg-a"
KEY_HOME_B="$WORK/gnupg-b"

cleanup() {
	if [[ -n "$SERVER_PID" ]]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	for home in "$KEY_HOME" "$KEY_HOME_B"; do
		if [[ -d "$home" ]] && command -v gpgconf >/dev/null 2>&1; then
			gpgconf --homedir "$home" --kill gpg-agent >/dev/null 2>&1 || true
		fi
	done
	rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	if [[ -n "${SERVER_PID:-}" && -f "$WORK/server-$PORT1.log" ]]; then
		printf '\n--- server log ---\n' >&2
		tail -40 "$WORK/server-$PORT1.log" >&2 || true
	fi
	exit 1
}

ok() { printf 'ok: %s\n' "$*"; }

for cmd in curl gpg jq tar find go; do
	command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done

# ---------------------------------------------------------------------------
# Build the server
# ---------------------------------------------------------------------------
(cd "$ROOT" && go build -o "$WORK/webpass-server" ./cmd/srv) || fail "build failed"
ok "server built"

start_server() {
	local port="$1" secret="${2:-}"
	mkdir -p "$WORK/git-repos-$port"
	JWT_SECRET=test-secret-key-32-bytes-long-xx \
		DB_PATH="$WORK/db-$port.sqlite3" \
		GIT_REPO_ROOT="$WORK/git-repos-$port" \
		REGISTRATION_ENABLED=true \
		REGISTRATION_TOTP_SECRET="$secret" \
		REGISTRATION_CODE_FILE="$WORK/code-$port.txt" \
		BCRYPT_COST=10 \
		"$WORK/webpass-server" -listen "127.0.0.1:$port" >"$WORK/server-$port.log" 2>&1 &
	SERVER_PID=$!
	for _ in $(seq 1 100); do
		curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
		sleep 0.2
	done
	tail -40 "$WORK/server-$port.log" >&2 || true
	fail "server on port $port did not start"
}

stop_server() {
	if [[ -n "$SERVER_PID" ]]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
}

gen_key() {
	local home="$1" uid="$2"
	mkdir -p "$home"
	chmod 700 "$home"
	gpg --homedir "$home" --batch --quiet --pinentry-mode loopback \
		--passphrase-fd 3 --quick-generate-key "$uid" ed25519 default 0 \
		3<<<"$PGP_PASS" || return 1
	local fpr
	fpr=$(gpg --homedir "$home" --batch --with-colons --list-keys |
		awk -F: '/^fpr:/ {print $10; exit}')
	[[ -n "$fpr" ]] || return 1
	gpg --homedir "$home" --batch --quiet --pinentry-mode loopback \
		--passphrase-fd 3 --quick-add-key "$fpr" cv25519 encr 0 \
		3<<<"$PGP_PASS" || return 1
	printf '%s' "$fpr"
}

# ---------------------------------------------------------------------------
# Test 1: create-account.sh with an existing GnuPG key
# ---------------------------------------------------------------------------
FPR_A=$(gen_key "$KEY_HOME" 'Script Test A <script-a@example.com>') || fail "key A generation failed"
ok "generated key A ($FPR_A)"

start_server "$PORT1"
ok "server started on $PORT1"

GNUPGHOME="$KEY_HOME" "$ROOT/scripts/create-account.sh" \
	--url "http://127.0.0.1:$PORT1" \
	--password "$LOGIN_PW" \
	--gpg-key "$FPR_A" \
	--pgp-passphrase "$PGP_PASS" \
	--out-dir "$WORK/out-a" >"$WORK/create-a.log" 2>&1 ||
	{ cat "$WORK/create-a.log" >&2; fail "create-account --gpg-key failed"; }
[[ -s "$WORK/out-a/webpass-$FPR_A.private.asc" ]] || fail "private key was not written"
[[ -s "$WORK/out-a/webpass-$FPR_A.public.asc" ]] || fail "public key was not written"
curl -fsS "http://127.0.0.1:$PORT1/api/$FPR_A" | jq -e '.exists == "true"' >/dev/null ||
	fail "account A not found on the server"
ok "create-account --gpg-key"

# ---------------------------------------------------------------------------
# Test 2: import-passstore.sh (dry run, import, decrypt back)
# ---------------------------------------------------------------------------
mkdir -p "$WORK/store/foo" "$WORK/store/Email"
printf 'hunter2\nusername: alice\nurl: https://example.com\n' |
	gpg --homedir "$KEY_HOME" --batch --yes --trust-model always \
		--encrypt --recipient "$FPR_A" --output "$WORK/store/foo/example.com.gpg" ||
	fail "encrypting test entry failed"
printf 'secretpass\nusername: alice@gmail.com\n' |
	gpg --homedir "$KEY_HOME" --batch --yes --trust-model always \
		--encrypt --recipient "$FPR_A" --output "$WORK/store/Email/gmail.gpg" ||
	fail "encrypting test entry failed"
printf 'ignored\n' >"$WORK/store/.gpg-id"

"$ROOT/scripts/import-passstore.sh" \
	--url "http://127.0.0.1:$PORT1" \
	--fingerprint "$FPR_A" \
	--password "$LOGIN_PW" \
	--store "$WORK/store" \
	--dry-run >"$WORK/dry.log" 2>&1 ||
	{ cat "$WORK/dry.log" >&2; fail "import --dry-run failed"; }
grep -q 'foo/example.com' "$WORK/dry.log" || fail "dry run missing foo/example.com"
grep -q 'Email/gmail' "$WORK/dry.log" || fail "dry run missing Email/gmail"
ok "import-passstore --dry-run"

"$ROOT/scripts/import-passstore.sh" \
	--url "http://127.0.0.1:$PORT1" \
	--fingerprint "$FPR_A" \
	--password "$LOGIN_PW" \
	--store "$WORK/store" >"$WORK/import.log" 2>&1 ||
	{ cat "$WORK/import.log" >&2; fail "import failed"; }
grep -q 'Imported    : 2 entries' "$WORK/import.log" || fail "expected 2 imported entries"
ok "import-passstore uploaded 2 entries"

TOKEN_A=$(curl -sS -X POST "http://127.0.0.1:$PORT1/api/$FPR_A/login" \
	-H 'Content-Type: application/json' \
	-d "$(jq -nc --arg pw "$LOGIN_PW" '{password: $pw}')" | jq -r '.token // empty')
[[ -n "$TOKEN_A" ]] || fail "login did not return a bearer token"
paths=$(curl -sS "http://127.0.0.1:$PORT1/api/$FPR_A/entries" \
	-H "Authorization: Bearer $TOKEN_A" | jq -r '.entries[].path')
grep -qx 'foo/example.com' <<<"$paths" || fail "foo/example.com not listed"
grep -qx 'Email/gmail' <<<"$paths" || fail "Email/gmail not listed"
ok "imported entries are listed"

plaintext=$(curl -sS "http://127.0.0.1:$PORT1/api/$FPR_A/entries/foo/example.com" \
	-H "Authorization: Bearer $TOKEN_A" |
	gpg --homedir "$KEY_HOME" --batch --quiet --pinentry-mode loopback \
		--passphrase-fd 3 --decrypt 3<<<"$PGP_PASS") ||
	fail "could not decrypt imported entry"
grep -q 'hunter2' <<<"$plaintext" || fail "decrypted entry content mismatch"
ok "imported entry decrypts with the original key"

# ---------------------------------------------------------------------------
# Test 3: create-account.sh --private-key, and a mismatched store is rejected
# ---------------------------------------------------------------------------
FPR_B=$(gen_key "$KEY_HOME_B" 'Script Test B <script-b@example.com>') || fail "key B generation failed"
gpg --homedir "$KEY_HOME_B" --batch --pinentry-mode loopback --passphrase-fd 3 \
	--armor --export-secret-keys "$FPR_B" >"$WORK/key-b.private.asc" 3<<<"$PGP_PASS" ||
	fail "exporting key B failed"

"$ROOT/scripts/create-account.sh" \
	--url "http://127.0.0.1:$PORT1" \
	--password "$LOGIN_PW2" \
	--private-key "$WORK/key-b.private.asc" \
	--pgp-passphrase "$PGP_PASS" \
	--out-dir "$WORK/out-b" >"$WORK/create-b.log" 2>&1 ||
	{ cat "$WORK/create-b.log" >&2; fail "create-account --private-key failed"; }
curl -fsS "http://127.0.0.1:$PORT1/api/$FPR_B" | jq -e '.exists == "true"' >/dev/null ||
	fail "account B not found on the server"
ok "create-account --private-key"

if "$ROOT/scripts/import-passstore.sh" \
	--url "http://127.0.0.1:$PORT1" \
	--fingerprint "$FPR_B" \
	--password "$LOGIN_PW2" \
	--store "$WORK/store" >"$WORK/mismatch.log" 2>&1; then
	fail "import with a mismatched key unexpectedly succeeded"
fi
grep -q 'encrypted to key' "$WORK/mismatch.log" || fail "mismatch error was not explained"
ok "mismatched store is rejected"

stop_server
ok "server stopped"

# ---------------------------------------------------------------------------
# Test 4: protected registration mode
# ---------------------------------------------------------------------------
start_server "$PORT2" 'JBSWY3DPEHPK3PXP'
ok "protected server started on $PORT2"
for _ in $(seq 1 40); do
	[[ -s "$WORK/code-$PORT2.txt" ]] && break
	sleep 0.25
done
CODE=$(cat "$WORK/code-$PORT2.txt" 2>/dev/null || true)
[[ -n "$CODE" ]] || fail "registration code file was not written"

GNUPGHOME="$KEY_HOME" "$ROOT/scripts/create-account.sh" \
	--url "http://127.0.0.1:$PORT2" \
	--password "$LOGIN_PW" \
	--gpg-key "$FPR_A" \
	--pgp-passphrase "$PGP_PASS" \
	--code "$CODE" \
	--out-dir "$WORK/out-protected" >"$WORK/create-protected.log" 2>&1 ||
	{ cat "$WORK/create-protected.log" >&2; fail "protected create-account failed"; }
curl -fsS "http://127.0.0.1:$PORT2/api/$FPR_A" | jq -e '.exists == "true"' >/dev/null ||
	fail "protected account not found"
ok "create-account protected mode"

printf '\nAll script tests passed.\n'
