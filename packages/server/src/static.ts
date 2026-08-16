/**
 * Serving the browser app from the local service.
 *
 * Running `unmark-server` and opening the URL it prints should give you the
 * actual tool, not an endpoint list. The built app is ~130 KB of static files,
 * so it ships inside this package and is served from `/`.
 *
 * This does not weaken the app's guarantee. The page still carries
 * `connect-src 'none'`, so once the browser has it, it cannot call anything —
 * including back to this server. Delivery over loopback and processing in the
 * tab are separate things; the files come from here, the work happens there.
 *
 * The one real hazard in any static server is path traversal: a request for
 * `/../../etc/passwd` must not escape the app directory. Every path is
 * resolved and then checked to be inside the root, which is the only check
 * that actually holds — string matching on `..` misses encodings of it.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

/** The built app, copied in at build time. */
const APP_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'app');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The app's own policy, sent as a header as well as the meta tag it carries.
 *
 * A header cannot be stripped by anything rewriting the HTML, so the guarantee
 * survives a proxy that a meta tag would not.
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/** Is the built app present in this install? */
export async function appAvailable(): Promise<boolean> {
  try {
    return (await stat(join(APP_ROOT, 'index.html'))).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a URL path to a file inside the app, or null if it escapes.
 *
 * `normalize` collapses `..` segments, and the containment check afterwards is
 * what actually enforces the boundary — a resolved path that does not start
 * with the root plus a separator is outside it, however it was spelled.
 */
function resolveWithin(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const relative = normalize(decoded)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '');
  const candidate = resolve(APP_ROOT, relative === '' ? 'index.html' : relative);

  if (candidate !== APP_ROOT && !candidate.startsWith(APP_ROOT + sep)) return null;
  return candidate;
}

/** Serve a file from the app. Returns false when there is nothing to serve. */
export async function serveApp(
  urlPath: string,
  response: ServerResponse,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): Promise<boolean> {
  const path = resolveWithin(urlPath === '/' ? 'index.html' : urlPath);
  if (path === null) return false;

  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const extension = extname(path).toLowerCase();
  const isHtml = extension === '.html';

  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': String(info.size),
    // Asset filenames carry a content hash, so they can be cached hard. The
    // HTML must not be, or a stale shell keeps pointing at deleted assets.
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(isHtml ? { 'Content-Security-Policy': APP_CSP } : {}),
    ...extraHeaders,
  });

  // HEAD gets the same headers and no body: browsers, proxies and health
  // checks all send it, and answering 404 makes the app look absent.
  if (headOnly) {
    response.end();
    return true;
  }

  await new Promise<void>((done, failed) => {
    const stream = createReadStream(path);
    stream.on('error', failed);
    stream.on('end', () => done());
    stream.pipe(response);
  });
  return true;
}
