/**
 * The HTTP surface.
 *
 * Built on `node:http` with no framework, because every dependency in a
 * privacy tool is another party you are asking users to trust. The routing
 * needs here are five paths and two verbs, which is not worth a supply chain.
 *
 * Request bodies live in memory for exactly as long as the request does. They
 * are never written to a temporary file, never cached, and never logged. The
 * access log records method, path, status and duration — not filenames, which
 * are themselves often the most sensitive part of a request.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  clean,
  inspect,
  summarise,
  UnmarkInputError,
  VERSION,
  type CleanOptions,
  type InspectOptions,
  type Kind,
} from '@unmarkk/core';
import { isPubliclyBound, resolveConfig, type ServerConfig } from './config.js';
import { openApiDocument } from './openapi.js';

const CLEAN_OPTION_KEYS = new Set([
  'nfkc',
  'aggressive',
  'aggressiveHomoglyphs',
  'normalizeSpaces',
  'stripEmojiGlue',
  'stripAllMetadata',
  'cleanTextBodies',
  'forceText',
  'as',
]);

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read the whole body, refusing anything past the cap. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `request body exceeds the ${limit} byte limit`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    // Checked as we go, because Content-Length is a claim, not a guarantee.
    if (total > limit) throw new HttpError(413, `request body exceeds the ${limit} byte limit`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface ParsedRequest {
  readonly data: Uint8Array;
  readonly filename: string | undefined;
  readonly options: Record<string, unknown>;
}

/** Reduce a client-supplied filename to a bare extension-bearing basename. */
function safeFilename(name: unknown): string | undefined {
  if (typeof name !== 'string' || name === '') return undefined;
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  if (base === '' || base === '.' || base === '..') return undefined;
  // Only the extension is ever used, but keeping the basename makes error
  // messages readable without ever touching the file system.
  return base.slice(0, 255);
}

function parseRequest(
  body: Buffer,
  contentType: string,
  headers: IncomingMessage['headers'],
): ParsedRequest {
  if (contentType.startsWith('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'request body is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope['file'] !== 'string') {
      throw new HttpError(400, "missing string field 'file' (base64-encoded bytes)");
    }

    const raw = envelope['file'];
    const decoded = Buffer.from(raw, 'base64');
    // Buffer.from is lenient; re-encoding catches input that is not base64 at
    // all rather than silently processing a truncated file.
    if (decoded.toString('base64').replace(/=+$/, '') !== raw.replace(/[\s=]+$/g, '')) {
      throw new HttpError(400, "'file' is not valid base64");
    }

    const options = envelope['options'];
    if (
      options !== undefined &&
      (typeof options !== 'object' || options === null || Array.isArray(options))
    ) {
      throw new HttpError(400, "'options' must be an object");
    }

    return {
      data: new Uint8Array(decoded),
      filename: safeFilename(envelope['name']),
      options: (options as Record<string, unknown>) ?? {},
    };
  }

  if (
    contentType.startsWith('application/octet-stream') ||
    contentType === '' ||
    contentType.startsWith('image/') ||
    contentType.startsWith('text/') ||
    contentType.startsWith('application/pdf')
  ) {
    return {
      data: new Uint8Array(body),
      filename: safeFilename(headers['x-unmark-filename']),
      options: {},
    };
  }

  throw new HttpError(415, `unsupported content type: ${contentType}`);
}

/** Validate and narrow the client-supplied option bag. */
function toCleanOptions(raw: Record<string, unknown>, filename: string | undefined): CleanOptions {
  for (const key of Object.keys(raw)) {
    if (!CLEAN_OPTION_KEYS.has(key)) throw new HttpError(400, `unknown option: ${key}`);
  }

  const bool = (key: string): boolean | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new HttpError(400, `option ${key} must be a boolean`);
    return value;
  };

  const as = raw['as'];
  if (as !== undefined && as !== 'text' && as !== 'image' && as !== 'container') {
    throw new HttpError(400, 'option as must be text, image or container');
  }

  const options: Record<string, unknown> = { filename };
  for (const key of [
    'nfkc',
    'aggressive',
    'aggressiveHomoglyphs',
    'normalizeSpaces',
    'stripEmojiGlue',
    'stripAllMetadata',
    'cleanTextBodies',
    'forceText',
  ]) {
    const value = bool(key);
    if (value !== undefined) options[key] = value;
  }
  if (as !== undefined) options['as'] = as as Kind;
  return options as CleanOptions;
}

function capabilities(): Record<string, unknown> {
  return {
    version: VERSION,
    engine: 'pure TypeScript, no external binaries',
    formats: {
      text: { inspect: true, clean: true, notes: 'invisible and format Unicode' },
      png: { inspect: true, clean: true },
      jpeg: { inspect: true, clean: true },
      webp: { inspect: true, clean: true },
      pdf: { inspect: true, clean: true, notes: 'structural rewrite; encrypted files are refused' },
      docx: { inspect: true, clean: true },
      odt: { inspect: true, clean: true },
      svg: { inspect: true, clean: true },
      html: { inspect: true, clean: true },
      markdown: { inspect: true, clean: true },
    },
    scorers: { stylometry: true },
    privacy: {
      networkEgress: false,
      diskWrites: false,
      contentLogging: false,
      retention: 'none — bodies are discarded when the response is sent',
    },
  };
}

function send(
  response: ServerResponse,
  status: number,
  payload: unknown,
  config: ServerConfig,
  origin?: string,
): void {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    // Nothing here should ever be cached: responses derive from a document the
    // user did not intend to publish.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...corsHeaders(config, origin),
  });
  response.end(body);
}

function corsHeaders(config: ServerConfig, origin: string | undefined): Record<string, string> {
  if (origin === undefined || !config.allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Unmark-Filename',
    Vary: 'Origin',
  };
}

/** Constant-time bearer token comparison. */
function authorised(request: IncomingMessage, config: ServerConfig): boolean {
  if (config.apiKey === undefined) return true;
  const header = request.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${config.apiKey}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Build the HTTP server. Exported so tests can drive it without a port. */
export function createServer(overrides: Partial<ServerConfig> = {}): Server {
  const config = resolveConfig(overrides);

  return createHttpServer((request, response) => {
    const started = Date.now();
    const origin = request.headers.origin;

    void handle(request, response, config)
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          send(response, error.status, { ok: false, error: error.message }, config, origin);
          return;
        }
        if (error instanceof UnmarkInputError) {
          send(
            response,
            400,
            { ok: false, error: error.message, advice: error.advice },
            config,
            origin,
          );
          return;
        }
        // Never surface an internal message: it can quote file content.
        process.stderr.write(
          `unmark: unhandled error on ${request.method} ${request.url}: ${String(error)}\n`,
        );
        send(response, 500, { ok: false, error: 'internal error' }, config, origin);
      })
      .finally(() => {
        if (config.logRequests) {
          const path = (request.url ?? '/').split('?')[0];
          process.stderr.write(
            `${request.method} ${path} ${response.statusCode} ${Date.now() - started}ms\n`,
          );
        }
      });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const origin = request.headers.origin;
  const path = (request.url ?? '/').split('?')[0] ?? '/';

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(config, origin));
    response.end();
    return;
  }

  if (path === '/openapi.json' && request.method === 'GET') {
    send(response, 200, openApiDocument(config), config, origin);
    return;
  }

  if (!authorised(request, config)) {
    send(response, 401, { ok: false, error: 'unauthorized' }, config, origin);
    return;
  }

  if (request.method === 'GET') {
    if (path === '/health') {
      send(response, 200, { ok: true, version: VERSION }, config, origin);
      return;
    }
    if (path === '/capabilities') {
      send(response, 200, { ok: true, ...capabilities() }, config, origin);
      return;
    }
    send(response, 404, { ok: false, error: 'not found' }, config, origin);
    return;
  }

  if (request.method !== 'POST' || (path !== '/inspect' && path !== '/clean')) {
    send(response, 404, { ok: false, error: 'not found' }, config, origin);
    return;
  }

  const body = await readBody(request, config.maxBodyBytes);
  const contentType = (request.headers['content-type'] ?? '').toLowerCase();
  const parsed = parseRequest(body, contentType, request.headers);

  if (path === '/inspect') {
    const options: InspectOptions = toCleanOptions(parsed.options, parsed.filename);
    const report = await inspect(parsed.data, { ...options, stylometry: true });
    const verdict = summarise(report);
    send(
      response,
      200,
      {
        ok: true,
        kind: report.kind,
        format: report.format,
        flagged: verdict.flagged,
        verdict,
        report,
      },
      config,
      origin,
    );
    return;
  }

  const options = toCleanOptions(parsed.options, parsed.filename);
  const result = await clean(parsed.data, options);
  const { output, ...report } = result;

  send(
    response,
    200,
    {
      ok: true,
      kind: result.kind,
      format: result.format,
      cleaned: Buffer.from(output).toString('base64'),
      report,
    },
    config,
    origin,
  );
}

/** Start listening, printing the warnings that matter for a privacy tool. */
export async function listen(overrides: Partial<ServerConfig> = {}): Promise<Server> {
  const config = resolveConfig(overrides);
  const server = createServer(config);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  process.stderr.write(`unmark ${VERSION} listening on http://${config.host}:${config.port}\n`);
  if (isPubliclyBound(config.host)) {
    process.stderr.write(
      `warning: bound to ${config.host}, which may be reachable from the network.\n` +
        "         Anything sent here is someone else's private document. Use a token,\n" +
        '         put it behind TLS, or bind 127.0.0.1 instead.\n',
    );
    if (config.apiKey === undefined) {
      process.stderr.write('warning: no API key set on a non-loopback bind.\n');
    }
  }
  return server;
}

export { resolveConfig };
export type { ServerConfig };
