/**
 * The only code in this project that opens a socket.
 *
 * It exists for one command — auditing a public website — and it is written
 * defensively, because "fetch a URL the user supplied" is the classic
 * server-side request forgery primitive. Point it at `http://169.254.169.254/`
 * on a cloud host and a naive implementation hands back instance credentials.
 *
 * The protections, in the order they matter:
 *
 *   1. **Connect-time address validation.** The `lookup` hook is where the
 *      check belongs. Resolving the name first and then calling `fetch`
 *      leaves a window in which DNS can change its answer between the check
 *      and the connection — a DNS rebinding attack. Validating inside the
 *      lookup means the address the socket actually uses is the address that
 *      was checked.
 *   2. **Every redirect hop is re-validated.** A public URL that redirects to
 *      `127.0.0.1` is the same attack with an extra step, so redirects are
 *      followed manually rather than by the HTTP client.
 *   3. **Scheme and credential rules.** `http(s)` only, and no `user:pass@`.
 *   4. **Hard caps** on body size, redirect count and time.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';

export const USER_AGENT = 'unmark-audit/1.0 (+https://www.npmjs.com/package/@unmarkk/cli)';

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Reject addresses that are not on the public internet.
 *
 * Loopback, private ranges, link-local (which is where cloud metadata services
 * live), carrier-grade NAT, and the IPv6 equivalents including IPv4-mapped
 * addresses — `::ffff:127.0.0.1` is loopback wearing a disguise.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped: ::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped !== null) return isPrivateAddress(mapped[1]!);
    return false;
  }

  return false;
}

export interface FetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Permit private and loopback addresses. Only for auditing your own intranet. */
  readonly allowPrivate?: boolean;
}

export interface FetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  /** True when the body was cut off at the size cap. */
  readonly truncated: boolean;
}

/** Strip the brackets IPv6 hostnames carry inside a URL. */
function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Validate a URL's shape before any network activity.
 *
 * The literal-IP check here is not redundant with `guardedLookup`: Node only
 * calls `lookup` when it has a *name* to resolve, so a URL like
 * `http://169.254.169.254/` — the cloud metadata endpoint — skips DNS entirely
 * and would connect straight through a lookup-only guard.
 */
function parseSafeUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`unsupported scheme ${url.protocol} — only http and https are allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchError('credentials embedded in a URL are not accepted');
  }
  if (url.hostname === '') throw new FetchError('URL has no hostname');

  const host = bareHostname(url);
  if (!allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new FetchError(
      `refusing to connect to ${host}: it is a private, loopback or link-local address`,
    );
  }
  return url;
}

/**
 * A `lookup` implementation that refuses to resolve to a private address.
 *
 * Node calls this at connect time, so the address it returns is the address
 * the socket uses — there is no window for the answer to change afterwards.
 */
function guardedLookup(allowPrivate: boolean): RequestOptions['lookup'] {
  return ((hostname, options, callback) => {
    const done = callback as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;

    dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err !== null) {
        done(err, '', 0);
        return;
      }
      const list = addresses as LookupAddress[];
      const allowed = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));

      if (allowed.length === 0) {
        done(
          new FetchError(
            `refusing to connect to ${hostname}: it resolves only to private or loopback addresses`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      // `all` was requested by the caller if options.all was set; otherwise
      // Node expects a single address.
      if ((options as { all?: boolean }).all === true) {
        done(null, allowed);
      } else {
        done(null, allowed[0]!.address, allowed[0]!.family);
      }
    });
  }) as RequestOptions['lookup'];
}

function once(
  url: URL,
  options: FetchOptions,
): Promise<{ result: FetchResult; location?: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        lookup: guardedLookup(options.allowPrivate ?? false),
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && typeof location === 'string') {
          res.resume(); // discard the body; we are following the redirect
          resolve({
            result: {
              url: url.href,
              status,
              contentType: '',
              body: new Uint8Array(0),
              truncated: false,
            },
            location,
          });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          total += chunk.length;
          if (total > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const finish = (): void =>
          resolve({
            result: {
              url: url.href,
              status,
              contentType: String(res.headers['content-type'] ?? ''),
              body: new Uint8Array(Buffer.concat(chunks)),
              truncated,
            },
          });

        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (err) => reject(new FetchError(err.message)));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new FetchError(`timed out after ${timeoutMs}ms: ${url.href}`));
    });
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError(err.message)));
    req.end();
  });
}

/** Fetch a URL, following redirects with every hop re-validated. */
export async function safeFetch(raw: string, options: FetchOptions = {}): Promise<FetchResult> {
  const allowPrivate = options.allowPrivate ?? false;
  let url = parseSafeUrl(raw, allowPrivate);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { result, location } = await once(url, options);
    if (location === undefined) return result;

    // Resolve relative redirects against the current URL, then run the new
    // target through the same validation as the original. A public URL that
    // redirects to 127.0.0.1 is the same attack with one extra step.
    url = parseSafeUrl(new URL(location, url).href, allowPrivate);
  }

  throw new FetchError(`more than ${MAX_REDIRECTS} redirects: ${raw}`);
}

const MAX_SITEMAP_BYTES = 64 * 1024 * 1024;

/** Decompress a sitemap body when it is gzipped, with a decompression budget. */
export function decompressSitemap(body: Uint8Array): Uint8Array {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body;
  const out = gunzipSync(Buffer.from(body), { maxOutputLength: MAX_SITEMAP_BYTES });
  return new Uint8Array(out);
}

/**
 * Pull `<loc>` values out of a sitemap or sitemap index.
 *
 * A regex rather than an XML parser: the only thing needed from the document
 * is the text of one element type, and pulling in a parser to read it would
 * mean a dependency in a tool whose selling point is not having any. Entities
 * are decoded because `&amp;` in a query string is extremely common.
 */
export function parseSitemap(xml: string): { isIndex: boolean; urls: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];

  for (const match of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const value = decodeEntities(match[1]!.trim());
    if (value !== '') urls.push(value);
  }
  return { isIndex, urls };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&amp;/g, '&');
}

/** Guess a filename for a URL, so format routing has an extension to use. */
export function filenameForUrl(url: string, contentType: string): string {
  const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const byType: Record<string, string> = {
    'text/html': '.html',
    'application/xhtml+xml': '.html',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.oasis.opendocument.text': '.odt',
    'text/markdown': '.md',
    'text/plain': '.txt',
  };

  const fromType = byType[type];
  if (fromType !== undefined) return `page${fromType}`;

  try {
    const path = new URL(url).pathname;
    const base = path
      .split('/')
      .filter((s) => s !== '')
      .pop();
    if (base !== undefined && base.includes('.')) return base;
  } catch {
    // fall through
  }
  return 'page.html';
}
