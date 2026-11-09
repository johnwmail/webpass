#!/usr/bin/env bash
# import-passstore.sh — import a pass(1) password store into WebPass.
#
# The entries are uploaded as-is through POST /api/{fingerprint}/import. This
# only works when the WebPass account uses the SAME OpenPGP key that the pass
# store is encrypted to (create it with `create-account.sh --gpg-key ...`).
# Otherwise use the web UI import, which decrypts and re-encrypts each entry.
#
# Requirements: bash, curl, gpg, jq, tar, find
#
# Examples:
#   ./scripts/import-passstore.sh --url https://webpass.example.com \
#       --fingerprint ABCD... --password 'login-password-12+'
#
#   WEBPASS_URL=https://webpass.example.com WEBPASS_FINGERPRINT=ABCD... \
#   WEBPASS_PASSWORD='login-password-12+' \
#       ./scripts/import-passstore.sh --store ~/.password-store
#
# Options:
#   --url URL             WebPass base URL (required)
#   --fingerprint FP      Account fingerprint (required)
#   --password PW         Login password; prompted if omitted
#   --store DIR           pass store directory (default: ~/.password-store)
#   --totp CODE           TOTP code when 2FA is enabled
#   --recovery-code CODE  Recovery code when 2FA is enabled
#   --dry-run             Show what would be imported, do not upload
#   -h, --help            Show this help
#
# Environment equivalents: WEBPASS_URL, WEBPASS_FINGERPRINT,
# WEBPASS_PASSWORD, WEBPASS_STORE, WEBPASS_TOTP_CODE,
# WEBPASS_RECOVERY_CODE.

set -euo pipefail
umask 077

BASE_URL="${WEBPASS_URL:-}"
FINGERPRINT="${WEBPASS_FINGERPRINT:-}"
LOGIN_PASSWORD="${WEBPASS_PASSWORD:-}"
STORE_DIR="${WEBPASS_STORE:-$HOME/.password-store}"
TOTP_CODE="${WEBPASS_TOTP_CODE:-}"
RECOVERY_CODE="${WEBPASS_RECOVERY_CODE:-}"
DRY_RUN=0

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
import-passstore.sh — import a pass(1) password store into WebPass.

The entries are uploaded as-is through POST /api/{fingerprint}/import. This
only works when the WebPass account uses the SAME OpenPGP key that the pass
store is encrypted to (create it with `create-account.sh --gpg-key ...`).
Otherwise use the web UI import, which decrypts and re-encrypts each entry.

Requirements: bash, curl, gpg, jq, tar, find

Examples:
  ./scripts/import-passstore.sh --url https://webpass.example.com \
      --fingerprint ABCD... --password 'login-password-12+'

  WEBPASS_URL=https://webpass.example.com WEBPASS_FINGERPRINT=ABCD... \
  WEBPASS_PASSWORD='login-password-12+' \
      ./scripts/import-passstore.sh --store ~/.password-store

Options:
  --url URL             WebPass base URL (required)
  --fingerprint FP      Account fingerprint (required)
  --password PW         Login password; prompted if omitted
  --store DIR           pass store directory (default: ~/.password-store)
  --totp CODE           TOTP code when 2FA is enabled
  --recovery-code CODE  Recovery code when 2FA is enabled
  --dry-run             Show what would be imported, do not upload
  -h, --help            Show this help

Environment equivalents: WEBPASS_URL, WEBPASS_FINGERPRINT,
WEBPASS_PASSWORD, WEBPASS_STORE, WEBPASS_TOTP_CODE,
WEBPASS_RECOVERY_CODE.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--url) BASE_URL="${2:-}"; shift 2 ;;
		--fingerprint) FINGERPRINT="${2:-}"; shift 2 ;;
		--password) LOGIN_PASSWORD="${2:-}"; shift 2 ;;
		--store) STORE_DIR="${2:-}"; shift 2 ;;
		--totp) TOTP_CODE="${2:-}"; shift 2 ;;
		--recovery-code) RECOVERY_CODE="${2:-}"; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option: $1 (try --help)" ;;
	esac
done

for cmd in curl gpg jq tar find; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but was not found"
done

[[ -n "$BASE_URL" ]] || die "--url or WEBPASS_URL is required"
while [[ "$BASE_URL" == */ ]]; do BASE_URL="${BASE_URL%/}"; done
[[ -n "$FINGERPRINT" ]] || die "--fingerprint or WEBPASS_FINGERPRINT is required"
[[ -d "$STORE_DIR" ]] || die "store directory not found: $STORE_DIR"

if [[ -z "$LOGIN_PASSWORD" ]]; then
	read -rsp "Login password: " LOGIN_PASSWORD || die "aborted"
	printf '\n'
fi

workdir=$(mktemp -d "${TMPDIR:-/tmp}/webpass-import.XXXXXX")
stickycookie=""
cleanup() {
	if [[ -n "$stickycookie" ]]; then
		rm -f "$stickycookie"
	fi
	rm -rf "$workdir"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Stage only *.gpg files; the server strips the .gpg suffix and leading "./".
# ---------------------------------------------------------------------------
stage="$workdir/store"
mkdir -p "$stage"

count=0
first_file=""
while IFS= read -r -d '' file; do
	rel="${file#"$STORE_DIR"/}"
	[[ -n "$first_file" ]] || first_file="$file"
	mkdir -p "$stage/$(dirname "$rel")"
	cp "$file" "$stage/$rel"
	count=$((count + 1))
done < <(find "$STORE_DIR" -type f -name '*.gpg' -print0)

(( count > 0 )) || die "no .gpg files found under $STORE_DIR"
printf 'Found %d entries in %s\n' "$count" "$STORE_DIR"

# ---------------------------------------------------------------------------
# Make sure the store is encrypted to the account's key. Importing entries
# encrypted to a different key would succeed but the UI could not decrypt them.
# ---------------------------------------------------------------------------
printf 'Checking account key ...\n'
account_json=$(curl -fsS --max-time 15 "$BASE_URL/api/$FINGERPRINT" 2>/dev/null) ||
	die "cannot reach $BASE_URL/api/$FINGERPRINT"
account_pub=$(printf '%s' "$account_json" | jq -r '.public_key // empty')
[[ -n "$account_pub" ]] || die "account $FINGERPRINT not found on the server"

check_home=$(mktemp -d "${TMPDIR:-/tmp}/webpass-check.XXXXXX")
chmod 700 "$check_home"
printf '%s' "$account_pub" >"$workdir/account.asc"
gpg --homedir "$check_home" --batch --import "$workdir/account.asc" >/dev/null 2>&1 ||
	die "cannot import the account public key"

account_keyids=$(gpg --homedir "$check_home" --batch --with-colons --list-keys |
	awk -F: '/^(pub|sub):/ {print toupper($5)}' || true)
if command -v gpgconf >/dev/null 2>&1; then
	gpgconf --homedir "$check_home" --kill gpg-agent >/dev/null 2>&1 || true
fi
rm -rf "$check_home"

packet_keyid=$(gpg --batch --list-packets "$first_file" 2>/dev/null |
	grep -oE 'keyid [0-9A-Fa-f]+' | head -1 | awk '{print toupper($2)}' || true)
if [[ -n "$packet_keyid" && "$packet_keyid" != "0000000000000000" ]]; then
	if ! grep -qx "$packet_keyid" <<<"$account_keyids"; then
		die "the store is encrypted to key $packet_keyid, but the account uses: $(echo $account_keyids). Create it with create-account.sh --gpg-key <the store's key>, or use the web UI import (which re-encrypts)."
	fi
fi
printf 'Account key matches the store.\n'

if (( DRY_RUN )); then
	printf '\nWould import:\n'
	(cd "$stage" && find . -type f -name '*.gpg' | sed 's|^\./||; s|\.gpg$||' | sort)
	exit 0
fi

# ---------------------------------------------------------------------------
# Login. Bearer-token mode is the default; cookie mode is also supported.
# ---------------------------------------------------------------------------
printf '%s' "$LOGIN_PASSWORD" >"$workdir/login_password"
stickycookie="$workdir/cookies.txt"

login() {
	local endpoint="$1" payload="$2"
	curl -sS --max-time 30 -c "$stickycookie" -b "$stickycookie" \
		-X POST "$BASE_URL/api/$FINGERPRINT$endpoint" \
		-H 'Content-Type: application/json' --data-binary "$payload" -w $'\n%{http_code}'
}

printf 'Logging in ...\n'
payload=$(jq -nc --rawfile pw "$workdir/login_password" '{password: $pw}')
response=$(login "/login" "$payload")
http_code="${response##*$'\n'}"
body="${response%$'\n'*}"
[[ "$http_code" == 200 ]] || die "login failed (HTTP $http_code): $body"

if printf '%s' "$body" | grep -q '"requires_2fa":true'; then
	if [[ -n "$TOTP_CODE" ]]; then
		payload=$(jq -nc --rawfile pw "$workdir/login_password" --arg code "$TOTP_CODE" \
			'{password: $pw, totp_code: $code}')
		response=$(login "/login/2fa" "$payload")
	elif [[ -n "$RECOVERY_CODE" ]]; then
		payload=$(jq -nc --rawfile pw "$workdir/login_password" --arg code "$RECOVERY_CODE" \
			'{password: $pw, recovery_code: $code}')
		response=$(login "/login/recovery" "$payload")
	else
		die "2FA is enabled; pass --totp CODE or --recovery-code CODE"
	fi
	http_code="${response##*$'\n'}"
	body="${response%$'\n'*}"
	[[ "$http_code" == 200 ]] || die "2FA login failed (HTTP $http_code): $body"
fi

auth_args=()
token=$(printf '%s' "$body" | jq -r '.token // empty')
if [[ -n "$token" && "$token" != "null" ]]; then
	auth_args=(-H "Authorization: Bearer $token")
else
	# Cookie mode: obtain the CSRF cookie on a safe request.
	curl -sS -c "$stickycookie" -b "$stickycookie" "$BASE_URL/api/health" >/dev/null 2>&1 || true
	csrf=$(awk '$6 == "webpass_csrf" {print $7}' "$stickycookie" 2>/dev/null | tail -1)
	[[ -n "$csrf" ]] || die "logged in but no bearer token or CSRF cookie was returned"
	auth_args=(-b "$stickycookie" -c "$stickycookie" -H "X-CSRF-Token: $csrf")
fi

# ---------------------------------------------------------------------------
# Upload the tar.gz through the existing import endpoint.
# ---------------------------------------------------------------------------
printf 'Uploading %d entries ...\n' "$count"
tar -czf "$workdir/passstore.tar.gz" -C "$stage" .
response=$(curl -sS --max-time 300 "${auth_args[@]}" -X POST \
	"$BASE_URL/api/$FINGERPRINT/import" \
	-H 'Content-Type: application/gzip' \
	--data-binary @"$workdir/passstore.tar.gz" -w $'\n%{http_code}')
http_code="${response##*$'\n'}"
body="${response%$'\n'*}"
[[ "$http_code" == 200 ]] || die "import failed (HTTP $http_code): $body"

imported=$(printf '%s' "$body" | jq -r '.imported // empty')
cat <<EOF

Import complete.

  Server      : $BASE_URL
  Fingerprint : $FINGERPRINT
  Store       : $STORE_DIR
  Imported    : ${imported:-$count} entries

Open the web UI and unlock the account with the same private key passphrase to
read the imported entries.
EOF
