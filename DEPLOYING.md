# Deploying

Three things can be deployed, and they are independent:

| What                                  | Where it goes              | Needs a server? |
| ------------------------------------- | -------------------------- | --------------- |
| [The web app](#the-web-app)           | Any static host            | No              |
| [The HTTP service](#the-http-service) | Docker, a VPS, your laptop | Yes             |
| The npm packages                      | npm registry               | No              |

Most people only need the first.

---

## The web app

It is a static site. No backend, no database, no environment variables, no
build-time secrets. Build it and serve the folder.

```bash
pnpm install
pnpm --filter @unmarkk/core build
pnpm --filter @unmarkk/web build
# -> packages/web/dist/
```

The build uses a **relative base path**, so the same output works at a domain
root, in a subdirectory, or opened directly from the filesystem. You can put
`dist/` on a USB stick, open `index.html` with the network unplugged, and it
works — which is a reasonable thing to want from a tool like this.

### GitHub Pages

Two steps, because a workflow cannot detect whether Pages is enabled and a job
that always ran would fail every release until somebody ticked the box:

1. Settings → Pages → Source → **GitHub Actions**
2. Settings → Secrets and variables → Actions → **Variables** → new repository
   variable `DEPLOY_PAGES` = `true`

Until that variable is set the deploy job is skipped, not failed.

Already wired up in
[`.github/workflows/release.yml`](.github/workflows/release.yml). Enable it
once:

1. Settings → Pages → Source → **GitHub Actions**
2. Push a tag: `git tag v1.0.0 && git push origin v1.0.0`

Live at `https://<username>.github.io/<repo>/`.

To deploy on every push to `main` instead of on tags, move the `pages` job into
`ci.yml` and change its `if:` condition.

### Netlify

```
Build command:    pnpm install && pnpm --filter @unmarkk/core build && pnpm --filter @unmarkk/web build
Publish directory: packages/web/dist
```

### Vercel

```
Framework preset:  Other
Build command:     pnpm --filter @unmarkk/core build && pnpm --filter @unmarkk/web build
Output directory:  packages/web/dist
Install command:   pnpm install
```

### Cloudflare Pages

Same as Netlify. Set `NODE_VERSION=22` in the environment.

### Any web server

```bash
rsync -av packages/web/dist/ user@host:/var/www/unmark/
```

nginx needs nothing special — no rewrite rules, no SPA fallback. It is one HTML
file and two assets.

### Serving it with the right headers

The page carries its own Content-Security-Policy in a `<meta>` tag, so it is
protected wherever it is hosted. If you control the server, send it as a header
too — a header cannot be stripped by an HTML rewriter the way a meta tag can:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'none'; worker-src 'self' blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Content-Type-Options "nosniff" always;
```

`connect-src 'none'` is the load-bearing part. It is what makes "nothing is
uploaded" something a visitor can verify rather than something they have to
take on trust.

### Verifying a deployment

```bash
curl -s https://your-host/ | grep -c "connect-src 'none'"   # 1 or more
```

Then open it, put a photo in, and watch the Network tab stay empty.

---

## The HTTP service

Only needed when something other than a terminal has to strip metadata — an
editor plugin, a scanner, a watch folder on a home server.

### Docker

```bash
docker compose up -d
curl localhost:8765/health
```

[`compose.yaml`](compose.yaml) publishes on **loopback only**
(`127.0.0.1:8765:8765`), runs read-only with all capabilities dropped, and
starts as an unprivileged user.

### Directly

```bash
npm install -g @unmarkk/server
unmark-server --port 8765
```

### Options

```
--host <addr>       Interface to bind (default 127.0.0.1)
--port <n>          Port (default 8765)
--api-key <token>   Require "Authorization: Bearer <token>"
--allow-origin <o>  Permit browser requests from this origin (repeatable)
--max-body <bytes>  Largest accepted body (default 128 MiB)
--log               One line per request — never filenames, never content
```

Environment equivalents: `UNMARK_HOST`, `UNMARK_PORT`, `UNMARK_API_KEY`,
`UNMARK_ALLOWED_ORIGINS`, `UNMARK_MAX_BODY_BYTES`, `UNMARK_LOG_REQUESTS`.

### Before you expose it to a network

The default is loopback, and the service warns when it is not. Everything sent
to it is a document somebody did not intend to publish. If you make it
reachable:

1. **Set a token.** `--api-key "$(openssl rand -hex 32)"`, compared in constant
   time.
2. **Put TLS in front of it.** The service speaks plain HTTP by design — TLS
   belongs in a reverse proxy that someone else keeps patched.
3. **Do not open CORS unless you need it.** With no configured origin, no CORS
   headers are sent at all, so a page on another site cannot make a visitor's
   browser POST documents to your service.

```nginx
server {
  listen 443 ssl http2;
  server_name unmark.example.com;

  client_max_body_size 128M;

  location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_request_buffering off;   # stream large uploads through
  }
}
```

### systemd

```ini
[Unit]
Description=unmark metadata service
After=network.target

[Service]
ExecStart=/usr/bin/unmark-server --port 8765
Environment=UNMARK_API_KEY=change-me
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` and `ProtectHome=yes` are safe here: the service holds
request bodies in memory and never writes to disk.

---

## Using it in CI

`unmark scan` exits `1` when something needs attention, which makes it a check:

```yaml
- name: No metadata in committed assets
  run: npx @unmarkk/cli scan . --quiet
```

Useful on a docs or marketing repository where images get committed by people
who did not think about EXIF. Start with `--quiet` on a subdirectory; running
it across an entire existing repository for the first time tends to produce a
long list.

---

## Related

- [docs/threat-model.md](docs/threat-model.md) — what the guarantees actually cover
