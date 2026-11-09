# Deploying WebPass on OpenBSD

WebPass builds into a single, self-contained binary: the Go API server plus the
Preact SPA (embedded via `//go:embed`) and a pure-Go SQLite engine. There is no
CGO and no runtime dependency, so it runs directly on OpenBSD.

Supported OpenBSD targets: `amd64`, `arm64` (also `386`, `arm`, `ppc64`,
`riscv64` via Go, but only `amd64`/`arm64` are exercised by CI).

## 1. Build the binary

The frontend must be built before the Go binary so the assets get embedded.

### Cross-compile from Linux/macOS

```sh
cd frontend && npm ci && npm run build && cd ..

CGO_ENABLED=0 GOOS=openbsd GOARCH=amd64 \
  go build -ldflags="-s -w" -o webpass-server ./cmd/srv
```

Use `GOARCH=arm64` for arm64 machines. Cross-compiling is fully supported; the
resulting static binary is copied to the OpenBSD host.

### Build natively on OpenBSD

```sh
pkg_add go node
cd frontend && npm ci && npm run build && cd ..
CGO_ENABLED=0 go build -ldflags="-s -w" -o webpass-server ./cmd/srv
```

> If `pkg_add go` provides an older Go than `go.mod` requires, Go's toolchain
> auto-download (`GOTOOLCHAIN=auto`) fetches the matching OpenBSD toolchain.

The `Release` CI workflow publishes prebuilt binaries to the GitHub Releases
page on every version tag: `webpass-server-openbsd-amd64` (plus Linux
`amd64`/`arm64`), so you can download it and skip local compilation.

## 2. Create the service user and directories

As `root`:

```sh
groupadd _webpass
useradd -s /sbin/nologin -d /var/webpass -g _webpass _webpass
install -d -o _webpass -g _webpass -m 0700 /var/webpass
```

`/var/webpass` holds the SQLite database (`db.sqlite3`, plus `-wal`/`-shm`) and
the git repositories used by git sync. Everything under it must be writable by
`_webpass`.

## 3. Install the binary and service files

From the repository checkout on the OpenBSD host:

```sh
install -o root -g bin -m 0755 webpass-server /usr/local/bin/webpass-server

install -o root -g wheel -m 0755 openbsd/webpass.rc /etc/rc.d/webpass

install -o root -g _webpass -m 0640 openbsd/webpass.env.example /etc/webpass.env
```

Edit `/etc/webpass.env` and at minimum set `JWT_SECRET` to a fresh value:

```sh
openssl rand -hex 32
```

The `webpass` rc.d script sources `/etc/webpass.env` as `_webpass`, so the file
must stay readable by that user (mode `0640`, group `_webpass`). Secrets stay
out of the process list because they are not passed as command-line arguments.

## 4. Enable and start the service

```sh
rcctl enable webpass
rcctl start webpass
rcctl check webpass
```

Logs go to syslog with tag `webpass` (priority `daemon.info`):

```sh
tail -f /var/log/messages
```

The server listens on `PORT` (default `8080`). Verify locally:

```sh
ftp -Vo - http://127.0.0.1:8080/api/health
```

## 5. Put TLS in front (recommended)

The embedded SPA is served same-origin, so a small reverse proxy is all that is
needed. OpenBSD `httpd` cannot proxy plain HTTP upstreams, so use `relayd` for
TLS termination and forwarding:

```sh
# /etc/relayd.conf
ip4="192.0.2.10"

http protocol "webpassproto" {
	tcp { nodelay }
}

relay "webpassrelay" {
	listen on $ip4 port 443 tls
	protocol "webpassproto"
	forward to <webpass> port 8080 check http "/api/health" code 200
}

table <webpass> { 127.0.0.1 }
```

Enable it with `rcctl enable relayd && rcctl start relayd` (TLS certificates are
provisioned separately, e.g. with `acme-client`). Session cookies are always
marked `Secure`, so cookie-based auth requires HTTPS; set `CORS_ORIGINS` in
`/etc/webpass.env` if needed and restart the service. WebPass does not do its
own TLS.

Passkeys (Face ID / Touch ID / security keys) also need HTTPS. To enable them,
set `WEBAUTHN_RP_ID` to the public registrable domain (no scheme or port) and
optionally `WEBAUTHN_RP_ORIGINS` to the exact `https://` origin(s) in
`/etc/webpass.env`, then `rcctl restart webpass`. See
[`openbsd/webpass.env.example`](openbsd/webpass.env.example) for the commented
example. Leave `WEBAUTHN_RP_ID` unset to keep passkeys disabled.

## 6. Backups and upgrades

- **Database**: stop the service (or use `.backup`) and copy
  `/var/webpass/db.sqlite3` together with any `-wal`/`-shm` files. The SQLite
  database uses WAL mode.
- **Git repos**: `/var/webpass/git-repos` (encrypted blobs only).
- **Upgrade**: install the new binary over `/usr/local/bin/webpass-server` and
  `rcctl restart webpass`. Schema migrations run automatically on startup and
  are forward-only — never downgrade a database with an older binary.
- **Restore**: copy the database back into `/var/webpass` while the service is
  stopped, then start it.

## 7. Notes and caveats

### OpenBSD sandbox (pledge/unveil)

On OpenBSD the server applies `unveil(2)` and then `pledge(2)` before opening the
database or listening on the network.

Default settings (no configuration required):

| Variable | Default | Description |
| --- | --- | --- |
| `DISABLE_SANDBOX` | unset (sandbox enabled) | `1`/`true` disables unveil/pledge. Debug only. |
| `OPENBSD_PLEDGE_PROMISES` | `stdio rpath wpath cpath inet dns unix flock fattr` | Overrides the pledge promise set. Invalid promises make startup fail closed with `EINVAL`. |
| `OPENBSD_UNVEIL_EXTRA_PATHS` | empty | Comma-separated extra paths in `path[:flags]` form. `flags` is a subset of `r`/`w`/`c` (default `r`). Paths with `w`/`c` also unveil their parent directory. |

Automatically unveiled paths:

- the database directory plus WAL/SHM files, and `data_encryption.key`
  (unless `DATA_ENCRYPTION_KEY` is set)
- `GIT_REPO_ROOT`
- the registration code file
- an optional `STATIC_DIR`
- `os.TempDir()` (`TMPDIR`, default `/tmp`) and `/tmp`
- `SSL_CERT_FILE` / `SSL_CERT_DIR` when set
- `/etc/{resolv.conf,hosts,services,ssl,localtime}`
- `/dev/{urandom,null}`

Example for a custom CA bundle and cache directory:

```sh
OPENBSD_PLEDGE_PROMISES="stdio rpath wpath cpath inet dns unix flock fattr"
OPENBSD_UNVEIL_EXTRA_PATHS="/etc/custom-certs:r,/var/cache/webpass:rwc"
```

Opening up promises or unveiling extra paths weakens the sandbox; only do it
when a deployment genuinely needs additional syscall families or paths. If the
server fails at startup with `pledge ... invalid argument` or an unveil-related
error, fix the configuration rather than disabling the sandbox; use
`DISABLE_SANDBOX=1` only temporarily while debugging.

The Linux/macOS build is unaffected; CI cross-compiles the OpenBSD binary and
runs an OpenBSD 8.0 VM smoke test (`.github/workflows/openbsd.yml`) that
exercises registration, login and an entry round-trip with the sandbox active.

## 8. Uninstall

```sh
rcctl stop webpass
rcctl disable webpass
rm /etc/rc.d/webpass /etc/webpass.env /usr/local/bin/webpass-server
userdel _webpass
rm -rf /var/webpass
```
