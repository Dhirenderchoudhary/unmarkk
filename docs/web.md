# Browser App

The unmark browser app processes files entirely in your browser tab. Nothing
is uploaded, nothing is stored.

## Running Locally

From the repository root:

```bash
pnpm install
pnpm --filter @unmarkk/web dev
```

Open [http://localhost:5173](http://localhost:5173). The port may differ if
5173 is already in use — check the terminal output.

## Building for Production

```bash
pnpm --filter @unmarkk/web build
```

The output goes to `packages/web/dist/`. It is a static site — serve the
folder from any web server, CDN, or local file server.

```bash
# Preview locally
pnpm --filter @unmarkk/web preview

# Or serve with any static server
npx serve packages/web/dist
```

## How It Works

The app has two panels:

### Files Panel

Drop images (PNG, JPEG, WebP), documents (PDF, DOCX, ODT), or text files
(Markdown, HTML, SVG, plain text) into the drop zone.

Each file is:

1. **Inspected automatically** — a report shows what metadata the file carries.
2. **Cleaned on demand** — click "Clean and download" to get a copy with the
   metadata stripped.

You can drop many files at once. The "Clean all" button processes every
flagged file in one go.

### Text Panel

Paste text to see invisible characters rendered inline. Zero-width spaces,
variation selectors, bidi controls, and other codepoints that hide between
the visible characters are shown as highlighted chips.

Click "Clean the text" to strip them, then copy the result.

### Options

Expand the **Options** section to control cleaning behaviour:

| Option                      | Default | What it does                                                                                 |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| Remove all image metadata   | On      | Strip every metadata block, not just AI provenance. The privacy-first choice.                |
| Clean text inside documents | On      | Run the invisible-character pass over Markdown and HTML bodies.                              |
| Normalise exotic spaces     | On      | Fold no-break, thin, and ideographic spaces to plain spaces.                                 |
| Rewrite lookalike letters   | Off     | Replace Cyrillic and fullwidth lookalikes with ASCII. Destructive on multilingual text.      |
| Strip emoji joiners         | Off     | Remove joiners inside emoji and complex scripts. Breaks compound emoji and Persian spelling. |

## Privacy Guarantees

The page enforces three layers of isolation:

### 1. Content Security Policy

The `<meta>` CSP header declares `connect-src 'none'`, which means the
browser itself refuses every `fetch`, `XMLHttpRequest`, `WebSocket`, and
`sendBeacon` the page could attempt. This is not a promise — it is a
browser-enforced block that you can verify in the Network tab.

### 2. No Network APIs in the Code

The built bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or
`sendBeacon` calls. You can verify this:

```bash
pnpm --filter @unmarkk/web build
grep -c "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" packages/web/dist/assets/*.js
# 0
```

### 3. No Storage

The app uses no `localStorage`, no `IndexedDB`, no `sessionStorage`, no
cookies, and no service worker. Reloading the page clears everything, which
is the correct behaviour for a tool that processes private documents.

## Architecture

Processing happens in a **Web Worker** so the main thread stays responsive.
The worker imports `@unmarkk/core` directly — the same engine used by the CLI
and the server.

```
main.ts          UI shell, drag/drop, tabs, paste handling
├── bridge.ts    Typed message channel to the worker
├── worker.ts    Runs inspect() and clean() off the main thread
└── ui/
    ├── dom.ts         Small DOM helpers (el, fill, icon)
    ├── files-panel.ts File queue, inspection, cleaning, download
    ├── text-panel.ts  Live text analysis and invisible-char rendering
    └── report.ts      Renders findings, exposure, and stylometry
```

## Deployment Notes

- The app is a **static site**. No server, no API, no database.
- It works **offline** once loaded. You can download `dist/` and open
  `index.html` from the filesystem.
- The Vite config disables the **modulepreload polyfill** because it calls
  `fetch()` on preload hrefs, which the CSP would block. Since the polyfill
  is only needed for older browsers, removing it is the right tradeoff.
- **HMR is disabled** in dev mode so the development server respects the
  same CSP as production. Manual refreshes are needed during development.
