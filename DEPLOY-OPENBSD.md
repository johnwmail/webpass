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
provisioned separately, e.g. with `acme-client`), then set
`COOKIE_SECURE=true` (and optionally `CORS_ORIGINS`) in `/etc/webpass.env` and
restart the service. WebPass does not do its own TLS.

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

- The binary is built with `CGO_ENABLED=0`: it has no libc dependency and only
  relies on the OpenBSD runtime loader, so OpenBSD W^X is satisfied.
- DNS for outbound git sync uses Go's built-in resolver.
- Do not place `/var/webpass` on a filesystem without POSIX file locking
  (e.g. NFS); SQLite requires working `fcntl` locks.
- If you prefer to serve the SPA from disk instead of the embedded copy, set
  `STATIC_DIR` in `/etc/webpass.env` and make the directory readable by
  `_webpass`.

## 8. Uninstall

```sh
rcctl stop webpass
rcctl disable webpass
rm /etc/rc.d/webpass /etc/webpass.env /usr/local/bin/webpass-server
userdel _webpass
rm -rf /var/webpass
```
