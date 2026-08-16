# @unmarkk/web

The browser front end for [unmark](../../README.md). Drag a file in, read what it carries, download a cleaned copy.

```bash
pnpm --filter @unmarkk/web dev
pnpm --filter @unmarkk/web build   # static site in dist/
```

## The point of it

This is where the privacy claim is easiest to verify, because the browser enforces it for you.

The page sets `connect-src 'none'` in its Content-Security-Policy. That means every `fetch`, XHR, WebSocket and beacon it could attempt is **refused by the browser**, not merely not-attempted by the code. Open the Network tab, drop a file in, and watch nothing happen.

The built bundle also contains no network API at all:

```bash
grep -c "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" dist/assets/*.js   # 0
```

CI fails the build if either of those stops being true.

Nothing is stored either: no `localStorage`, no IndexedDB, no service worker. Reload and it is gone — which is the correct behaviour for a tool people point at private documents.

Processing happens in a Web Worker, so a large PDF does not freeze the tab.

## Hosting it

It is a static site with no backend. Build it and serve the folder from anywhere — or open it with the network unplugged, which works exactly as well.

## Development note

Vite's hot reload needs a WebSocket, which `connect-src 'none'` forbids. HMR is therefore switched off, so the development server enforces exactly the same policy as production. Refresh manually.

## License

MIT © Dhirender Choudhary
