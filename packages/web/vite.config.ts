import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/ rather than the domain
  // root, which breaks absolute asset paths. A relative base works from any
  // subdirectory, and from `file://` — so the built folder can be opened
  // straight off a USB stick with the network unplugged, which is a use this
  // project should support.
  base: process.env['UNMARK_BASE_PATH'] ?? './',
  build: {
    target: 'es2022',
    // No remote chunks, no dynamic CDN fallbacks: the whole app must be
    // servable from a folder with the network unplugged.
    assetsInlineLimit: 0,
    // Vite's modulepreload polyfill calls fetch() on preload hrefs. It is
    // same-origin and harmless, but it is also the only network API that would
    // otherwise appear in the bundle — and "grep the build for fetch and find
    // nothing" is a claim worth being able to make literally. The CSP blocks
    // the call anyway, so the polyfill buys nothing here.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    // The page's Content-Security-Policy sets `connect-src 'none'`, which is
    // the mechanism that makes "nothing is uploaded" checkable rather than
    // promised. Vite's hot reload needs a WebSocket, so it is switched off:
    // dev and production get to enforce exactly the same policy.
    hmr: false,
  },
});
