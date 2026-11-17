#!/bin/sh
# download-latest.sh — download the latest prebuilt webpass-server binary.
#
# Works on Linux and OpenBSD using only base tools (curl, wget or ftp, plus
# sha256sum/sha256). It only downloads; it does not install or restart anything.
#
# Examples:
#   ./scripts/download-latest.sh
#   ./scripts/download-latest.sh -o /tmp/webpass-server
#   ./scripts/download-latest.sh --check
#
# Requirements: sh, uname, mktemp, and one of curl/wget/ftp.
# Checksum verification is skipped when the release has no SHA256SUMS asset.

set -eu

REPO="${WEBPASS_REPO:-johnwmail/webpass}"
API="${WEBPASS_API:-https://api.github.com/repos/${REPO}/releases/latest}"
RELEASES="${WEBPASS_RELEASES:-https://github.com/${REPO}/releases}"

OUTPUT=""
CHECK_ONLY=0
FORCE=0
OS=""
ARCH=""
VERSION=""

usage() {
	cat <<'EOF'
Usage: download-latest.sh [options]

Download the latest webpass-server release binary from GitHub.

Options:
  -o, --output PATH   Write the binary to PATH
                      (default: ./webpass-server-<tag>-<os>-<arch>)
  -c, --check         Print the latest version and asset name; do not download
  -f, --force         Overwrite an existing output file
  -V, --version TAG   Download a specific tag instead of the latest
      --os OS         Override OS detection (linux, openbsd)
      --arch ARCH     Override architecture detection (amd64, arm64)
  -h, --help          Show this help

Environment:
  WEBPASS_REPO        GitHub repository (default: johnwmail/webpass)
  WEBPASS_API         Override the "latest release" API URL
  WEBPASS_RELEASES    Override the releases base URL (mirrors/tests)
  TMPDIR              Temporary directory (default: /tmp)
EOF
}

die() {
	printf 'download-latest: %s\n' "$*" >&2
	exit 1
}

have() {
	command -v "$1" >/dev/null 2>&1
}

while [ $# -gt 0 ]; do
	case "$1" in
		-o|--output)
			[ $# -ge 2 ] || die "$1 needs a value"
			OUTPUT=$2
			shift 2
			;;
		-c|--check)
			CHECK_ONLY=1
			shift
			;;
		-f|--force)
			FORCE=1
			shift
			;;
		-V|--version)
			[ $# -ge 2 ] || die "$1 needs a value"
			VERSION=$2
			shift 2
			;;
		--os)
			[ $# -ge 2 ] || die "$1 needs a value"
			OS=$2
			shift 2
			;;
		--arch)
			[ $# -ge 2 ] || die "$1 needs a value"
			ARCH=$2
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			die "unknown option: $1 (try --help)"
			;;
	esac
done

if [ -z "$OS" ]; then
	case "$(uname -s)" in
		Linux) OS=linux ;;
		OpenBSD) OS=openbsd ;;
		Darwin) die "no macOS binary is published; build from source" ;;
		*) die "unsupported OS: $(uname -s)" ;;
	esac
fi

if [ -z "$ARCH" ]; then
	case "$(uname -m)" in
		x86_64|amd64) ARCH=amd64 ;;
		aarch64|arm64) ARCH=arm64 ;;
		*) die "unsupported architecture: $(uname -m)" ;;
	esac
fi

ASSET="webpass-server-${OS}-${ARCH}"

# --- download helpers -------------------------------------------------------

download_to() {
	url=$1
	dest=$2
	if have curl; then
		curl -fsSL --retry 3 --connect-timeout 15 -o "$dest" "$url"
	elif have wget; then
		wget -q -O "$dest" "$url"
	elif have ftp; then
		ftp -o "$dest" "$url"
	else
		die "need curl, wget or ftp to download"
	fi
}

fetch_text() {
	tmp=$(mktemp "${TMPDIR:-/tmp}/webpass-fetch.XXXXXX")
	if ! download_to "$1" "$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	cat "$tmp"
	rm -f "$tmp"
}

hash_file() {
	if have sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif have sha256; then
		sha256 -q "$1"
	fi
}

# --- resolve the latest release --------------------------------------------

TAG=""
if [ -n "$VERSION" ]; then
	TAG=$VERSION
elif JSON=$(fetch_text "$API" 2>/dev/null); then
	TAG=$(printf '%s\n' "$JSON" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
		head -n 1)
fi

if [ -n "$TAG" ]; then
	BASE="${RELEASES}/download/${TAG}"
else
	# Fall back to GitHub's stable "latest" redirect; the version is then
	# unknown but the download still works.
	BASE="${RELEASES}/latest/download"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
	printf 'latest: %s\n' "${TAG:-unknown}"
	printf 'asset:  %s\n' "$ASSET"
	exit 0
fi

if [ -z "$OUTPUT" ]; then
	OUTPUT="./webpass-server-${TAG:-latest}-${OS}-${ARCH}"
fi
if [ -e "$OUTPUT" ] && [ "$FORCE" -ne 1 ]; then
	die "$OUTPUT already exists (use -f to overwrite)"
fi

tmp=$(mktemp "${OUTPUT}.XXXXXX")
trap 'rm -f "$tmp"' EXIT INT TERM

printf 'Downloading %s (%s/%s) ...\n' "${TAG:-latest}" "$OS" "$ARCH"
download_to "${BASE}/${ASSET}" "$tmp" ||
	die "download failed: ${BASE}/${ASSET}"

# --- verify checksum when the release publishes one ------------------------

sums=$(mktemp "${TMPDIR:-/tmp}/webpass-sums.XXXXXX")
if download_to "${BASE}/SHA256SUMS" "$sums" 2>/dev/null; then
	line=$(grep -E "^[0-9a-fA-F]{64}[[:space:]]+\*?${ASSET}$" "$sums" | head -n 1 || true)
	if [ -n "$line" ]; then
		want=$(printf '%s\n' "$line" | awk '{print $1}')
		got=$(hash_file "$tmp")
		if [ -z "$got" ]; then
			printf 'note: no sha256sum/sha256 tool; skipping checksum verification\n'
		elif [ "$want" != "$got" ]; then
			rm -f "$sums"
			die "checksum mismatch for ${ASSET}"
		else
			printf 'checksum: ok\n'
		fi
	else
		printf 'note: %s is not listed in SHA256SUMS; skipping verification\n' "$ASSET"
	fi
else
	printf 'note: this release has no SHA256SUMS; skipping checksum verification\n'
fi
rm -f "$sums"

chmod 0755 "$tmp"
mv -f "$tmp" "$OUTPUT"
trap - EXIT INT TERM

size=$(wc -c <"$OUTPUT" | tr -d ' ')
printf '\nDownloaded %s -> %s (%s bytes)\n' "${TAG:-latest}" "$OUTPUT" "$size"
printf '\nInstall and restart:\n'
printf '  sudo install -o root -g bin -m 0755 %s /usr/local/bin/webpass-server\n' "$OUTPUT"
printf '  sudo rcctl restart webpass        # OpenBSD\n'
printf '  sudo systemctl restart webpass    # Linux (systemd)\n'
