#!/usr/bin/env bash
# create-account.sh — create a WebPass account from the command line.
#
# Generates a passphrase-protected OpenPGP keypair with GnuPG, registers the
# account through the WebPass HTTP API, and writes the armored public/private
# keys to disk. Import the private key into the WebPass web UI (Setup → Import
# key) to use the same account there.
#
# Requirements: bash, curl, gpg >= 2.2, jq
#
# Examples:
#   ./scripts/create-account.sh --url https://webpass.example.com
#
#   WEBPASS_URL=https://webpass.example.com \
#   WEBPASS_PASSWORD='login-password-12+' \
#   WEBPASS_PGP_PASSPHRASE='private-key-passphrase' \
#   ./scripts/create-account.sh
#
# Options:
#   --url URL             Base URL of the WebPass server (required)
#   --password PW         Login password (12-72 bytes); prompted if omitted
#   --pgp-passphrase PW   Private-key passphrase (>= 12 chars); prompted if omitted
#   --name NAME           OpenPGP user ID name (default: WebPass User)
#   --email EMAIL         Optional OpenPGP user ID email
#   --code CODE           Registration code for protected mode
#   --out-dir DIR         Where to write the keys (default: current directory)
#   -h, --help            Show this help
#
# Environment equivalents: WEBPASS_URL, WEBPASS_PASSWORD,
# WEBPASS_PGP_PASSPHRASE, WEBPASS_ACCOUNT_NAME, WEBPASS_EMAIL,
# WEBPASS_REGISTRATION_CODE, WEBPASS_OUT_DIR.
#
# Passing --password on the command line exposes it in shell history; prefer
# the environment variables or the interactive prompt.

set -euo pipefail
umask 077

BASE_URL="${WEBPASS_URL:-}"
LOGIN_PASSWORD="${WEBPASS_PASSWORD:-}"
PGP_PASSPHRASE="${WEBPASS_PGP_PASSPHRASE:-}"
ACCOUNT_NAME="${WEBPASS_ACCOUNT_NAME:-WebPass User}"
EMAIL="${WEBPASS_EMAIL:-}"
REGISTRATION_CODE="${WEBPASS_REGISTRATION_CODE:-}"
OUT_DIR="${WEBPASS_OUT_DIR:-.}"

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
create-account.sh — create a WebPass account from the command line.

Generates a passphrase-protected OpenPGP keypair with GnuPG, registers the
account through the WebPass HTTP API, and writes the armored public/private
keys to disk. Import the private key into the WebPass web UI (Setup → Import
key) to use the same account there.

Requirements: bash, curl, gpg >= 2.2, jq

Examples:
  ./scripts/create-account.sh --url https://webpass.example.com

  WEBPASS_URL=https://webpass.example.com \
  WEBPASS_PASSWORD='login-password-12+' \
  WEBPASS_PGP_PASSPHRASE='private-key-passphrase' \
  ./scripts/create-account.sh

Options:
  --url URL             Base URL of the WebPass server (required)
  --password PW         Login password (12-72 bytes); prompted if omitted
  --pgp-passphrase PW   Private-key passphrase (>= 12 chars); prompted if omitted
  --name NAME           OpenPGP user ID name (default: WebPass User)
  --email EMAIL         Optional OpenPGP user ID email
  --code CODE           Registration code for protected mode
  --out-dir DIR         Where to write the keys (default: current directory)
  -h, --help            Show this help

Environment equivalents: WEBPASS_URL, WEBPASS_PASSWORD,
WEBPASS_PGP_PASSPHRASE, WEBPASS_ACCOUNT_NAME, WEBPASS_EMAIL,
WEBPASS_REGISTRATION_CODE, WEBPASS_OUT_DIR.

Passing --password on the command line exposes it in shell history; prefer
the environment variables or the interactive prompt.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--url) BASE_URL="${2:-}"; shift 2 ;;
		--password) LOGIN_PASSWORD="${2:-}"; shift 2 ;;
		--pgp-passphrase) PGP_PASSPHRASE="${2:-}"; shift 2 ;;
		--name) ACCOUNT_NAME="${2:-}"; shift 2 ;;
		--email) EMAIL="${2:-}"; shift 2 ;;
		--code) REGISTRATION_CODE="${2:-}"; shift 2 ;;
		--out-dir) OUT_DIR="${2:-}"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option: $1 (try --help)" ;;
	esac
done

for cmd in curl gpg jq; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but was not found"
done

[[ -n "$BASE_URL" ]] || die "--url or WEBPASS_URL is required"
while [[ "$BASE_URL" == */ ]]; do BASE_URL="${BASE_URL%/}"; done

if [[ -z "$LOGIN_PASSWORD" ]]; then
	read -rsp "Login password (12-72 bytes): " LOGIN_PASSWORD || die "aborted"
	printf '\n'
	read -rsp "Confirm login password: " confirm || die "aborted"
	printf '\n'
	[[ "$LOGIN_PASSWORD" == "$confirm" ]] || die "login passwords do not match"
	unset confirm
fi

if [[ -z "$PGP_PASSPHRASE" ]]; then
	read -rsp "Private-key passphrase (12+ chars): " PGP_PASSPHRASE || die "aborted"
	printf '\n'
	read -rsp "Confirm private-key passphrase: " confirm || die "aborted"
	printf '\n'
	[[ "$PGP_PASSPHRASE" == "$confirm" ]] || die "private-key passphrases do not match"
	unset confirm
fi

pw_bytes=$(printf '%s' "$LOGIN_PASSWORD" | LC_ALL=C wc -c | tr -d '[:space:]')
if (( pw_bytes < 12 || pw_bytes > 72 )); then
	die "login password must be 12-72 bytes (got $pw_bytes)"
fi
if (( $(printf '%s' "$PGP_PASSPHRASE" | LC_ALL=C wc -c | tr -d '[:space:]') < 12 )); then
	die "private-key passphrase must be at least 12 characters"
fi

printf 'Checking %s ...\n' "$BASE_URL"
mode_json=$(curl -fsS --max-time 15 "$BASE_URL/api/registration/mode" 2>/dev/null) ||
	die "cannot reach $BASE_URL (is the server running and the URL correct?)"
mode=$(printf '%s' "$mode_json" | jq -r '.mode // empty')
case "$mode" in
	open) ;;
	protected)
		[[ -n "$REGISTRATION_CODE" ]] ||
			die "registration is protected; pass --code CODE or WEBPASS_REGISTRATION_CODE"
		;;
	disabled) die "registration is disabled on this server" ;;
	*) die "unexpected registration mode: ${mode:-<empty>}" ;;
esac

workdir=$(mktemp -d "${TMPDIR:-/tmp}/webpass-account.XXXXXX")
gpg_home=$(mktemp -d "${TMPDIR:-/tmp}/webpass-gnupg.XXXXXX")
chmod 700 "$gpg_home"

cleanup() {
	if command -v gpgconf >/dev/null 2>&1; then
		gpgconf --homedir "$gpg_home" --kill gpg-agent >/dev/null 2>&1 || true
	fi
	rm -rf "$workdir" "$gpg_home"
}
trap cleanup EXIT

uid_string="$ACCOUNT_NAME"
[[ -n "$EMAIL" ]] && uid_string="$ACCOUNT_NAME <$EMAIL>"

printf 'Generating OpenPGP key (ed25519/cv25519) ...\n'
gpg --homedir "$gpg_home" --batch --quiet --pinentry-mode loopback \
	--passphrase-fd 3 --quick-generate-key "$uid_string" ed25519 default 0 \
	3<<<"$PGP_PASSPHRASE"

fingerprint=$(gpg --homedir "$gpg_home" --batch --with-colons --list-keys |
	awk -F: '/^fpr:/ {print $10; exit}')
[[ -n "$fingerprint" ]] || die "key generation failed"

gpg --homedir "$gpg_home" --batch --quiet --pinentry-mode loopback \
	--passphrase-fd 3 --quick-add-key "$fingerprint" cv25519 encr 0 \
	3<<<"$PGP_PASSPHRASE"

gpg --homedir "$gpg_home" --batch --armor --export "$fingerprint" >"$workdir/public.asc"
gpg --homedir "$gpg_home" --batch --pinentry-mode loopback --passphrase-fd 3 \
	--armor --export-secret-keys "$fingerprint" >"$workdir/private.asc" \
	3<<<"$PGP_PASSPHRASE"
[[ -s "$workdir/public.asc" && -s "$workdir/private.asc" ]] || die "key export failed"

mkdir -p "$OUT_DIR"
public_file="$OUT_DIR/webpass-$fingerprint.public.asc"
private_file="$OUT_DIR/webpass-$fingerprint.private.asc"
cp "$workdir/public.asc" "$public_file"
cp "$workdir/private.asc" "$private_file"
chmod 644 "$public_file"
chmod 600 "$private_file"

printf 'Registering account %s ...\n' "$fingerprint"
# Read secrets from files rather than jq's argv so they do not show up in ps.
printf '%s' "$LOGIN_PASSWORD" >"$workdir/login_password"
payload=$(jq -n --rawfile pw "$workdir/login_password" --rawfile pub "$public_file" \
	--arg fp "$fingerprint" '{password: $pw, public_key: $pub, fingerprint: $fp}')

curl_args=(-sS --max-time 30 -X POST "$BASE_URL/api" -H 'Content-Type: application/json')
[[ -n "$REGISTRATION_CODE" ]] && curl_args+=(-H "X-Registration-Code: $REGISTRATION_CODE")

response=$(printf '%s' "$payload" | curl "${curl_args[@]}" --data-binary @- -w $'\n%{http_code}')
http_code="${response##*$'\n'}"
body="${response%$'\n'*}"
case "$http_code" in
	201) ;;
	409) die "an account with fingerprint $fingerprint already exists on the server" ;;
	*) die "registration failed (HTTP $http_code): $body" ;;
esac

printf 'Verifying login ...\n'
login_payload=$(jq -n --rawfile pw "$workdir/login_password" '{password: $pw}')
login_response=$(curl -sS --max-time 30 -X POST "$BASE_URL/api/$fingerprint/login" \
	-H 'Content-Type: application/json' --data-binary "$login_payload" -w $'\n%{http_code}')
login_code="${login_response##*$'\n'}"
[[ "$login_code" == 200 ]] ||
	die "account created but the login test failed (HTTP $login_code): ${login_response%$'\n'*}"

cat <<EOF

Account created.

  Server      : $BASE_URL
  Fingerprint : $fingerprint
  Public key  : $public_file
  Private key : $private_file

Next steps:
  1. Back up the private key file and remember the private-key passphrase.
     Without them the encrypted vault cannot be recovered.
  2. In the WebPass web UI choose "Import key", paste the private key file,
     enter the private-key passphrase, and use the same login password.
  3. Keep the private key out of version control and off shared machines.
EOF
