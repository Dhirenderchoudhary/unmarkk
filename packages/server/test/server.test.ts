/**
 * Server tests.
 *
 * The server is started on an ephemeral port for each block rather than
 * mocked, so what is exercised is the real request path: body limits, content
 * negotiation, auth and the security headers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../src/server.js';
import { isPubliclyBound, resolveConfig } from '../src/config.js';

async function start(overrides: Parameters<typeof createServer>[0] = {}): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer({ port: 0, host: '127.0.0.1', ...overrides });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('routes', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await start());
  });
  afterAll(() => stop(server));

  it('reports health', async () => {
    const body = await (await fetch(`${url}/health`)).json();
    expect(body).toMatchObject({ ok: true });
    expect(typeof body.version).toBe('string');
  });

  it('describes its capabilities honestly', async () => {
    const body = await (await fetch(`${url}/capabilities`)).json();
    expect(body.formats.pdf.clean).toBe(true);
    expect(body.privacy).toMatchObject({
      networkEgress: false,
      diskWrites: false,
      contentLogging: false,
    });
  });

  it('serves an OpenAPI document that matches its routes', async () => {
    const spec = await (await fetch(`${url}/openapi.json`)).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/capabilities',
      '/clean',
      '/health',
      '/inspect',
      '/openapi.json',
    ]);
  });

  it('sets headers that stop a response being cached or framed', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('answers at / instead of 404ing the URL it just printed', async () => {
    // The startup banner prints this URL. Returning "not found" here reads as
    // a broken install to anyone who opens it in a browser.
    const body = await (await fetch(`${url}/`)).json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('unmark');
    expect(Object.keys(body.endpoints)).toContain('GET /health');
  });

  it('serves a readable page to a browser', async () => {
    const response = await fetch(`${url}/`, { headers: { Accept: 'text/html' } });
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('running');
    expect(html).toContain('/health');
  });

  it('serves the browser app at / when it is bundled', async () => {
    const response = await fetch(`${url}/`, { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);
    const body = await response.text();
    // Either the app itself, or the endpoint index when it was not built.
    expect(body).toMatch(/Drop files here|unmark <span class="ok">running|running/);
  });

  it('keeps the app locked down when it serves it', async () => {
    const response = await fetch(`${url}/`, { headers: { Accept: 'text/html' } });
    const csp = response.headers.get('content-security-policy') ?? '';
    // Whichever page came back, it must not be allowed to phone anywhere.
    expect(csp).toContain("connect-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses to serve anything outside the app directory', async () => {
    for (const path of [
      '/../../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/assets/../../../../etc/passwd',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const response = await fetch(`${url}${path}`);
      const body = response.ok ? await response.text() : '';
      expect(body, path).not.toMatch(/^root:/m);
    }
  });

  it('answers HEAD as well as GET', async () => {
    // Browsers, proxies and health checks all send HEAD; 404ing it makes the
    // app look absent.
    const response = await fetch(`${url}/`, { method: 'HEAD' });
    expect(response.status).toBe(200);
  });

  it('404s an unknown path', async () => {
    const response = await fetch(`${url}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});

describe('inspect and clean', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await start());
  });
  afterAll(() => stop(server));

  it('inspects a JSON envelope', async () => {
    const response = await fetch(`${url}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: b64('he​llo'), name: 'note.txt' }),
    });
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('text');
    expect(body.flagged).toBe(true);
    expect(body.report.suspiciousTotal).toBe(1);
  });

  it('accepts a raw binary body with a filename header', async () => {
    const response = await fetch(`${url}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Unmark-Filename': 'note.md' },
      body: '---\ngenerator: ChatGPT\n---\n\nBody\n',
    });
    const body = await response.json();
    expect(body.kind).toBe('container');
    expect(body.format).toBe('markdown');
  });

  it('cleans and returns the bytes', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: b64('a​b'), name: 'note.txt' }),
    });
    const body = await response.json();
    expect(Buffer.from(body.cleaned, 'base64').toString('utf8')).toBe('ab');
    expect(body.report.stats.removedCount).toBe(1);
    // The cleaned bytes ride in the envelope, never as a stray top-level field.
    expect(body.report.output).toBeUndefined();
  });

  it('passes options through', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: b64('pаypal'),
        name: 'note.txt',
        options: { aggressiveHomoglyphs: true },
      }),
    });
    const body = await response.json();
    expect(Buffer.from(body.cleaned, 'base64').toString('utf8')).toBe('paypal');
  });

  it('rejects an unknown option instead of ignoring it', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: b64('x'), options: { wipeEverything: true } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('unknown option');
  });

  it('rejects a non-boolean option', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: b64('x'), options: { nfkc: 'yes' } }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects input that is not base64', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'definitely!not!base64' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('base64');
  });

  it('rejects a missing file field', async () => {
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${url}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);
  });

  it('rejects an unsupported content type', async () => {
    const response = await fetch(`${url}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'file=x',
    });
    expect(response.status).toBe(415);
  });

  it('surfaces the engine advice when it refuses binary as text', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const response = await fetch(`${url}/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: png.toString('base64'), options: { as: 'text' } }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('PNG');
    expect(body.advice.length).toBeGreaterThan(0);
  });

  it('does not leak a path traversal filename into anything', async () => {
    const response = await fetch(`${url}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: b64('hello'), name: '../../../etc/passwd' }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('etc/passwd');
  });
});

describe('limits and auth', () => {
  it('refuses a body past the cap', async () => {
    const { server, url } = await start({ maxBodyBytes: 1024 });
    try {
      const response = await fetch(`${url}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: 'x'.repeat(5000),
      });
      expect(response.status).toBe(413);
    } finally {
      await stop(server);
    }
  });

  it('requires the bearer token when one is configured', async () => {
    const { server, url } = await start({ apiKey: 'secret-token' });
    try {
      expect((await fetch(`${url}/health`)).status).toBe(401);
      expect(
        (await fetch(`${url}/health`, { headers: { Authorization: 'Bearer wrong' } })).status,
      ).toBe(401);

      const ok = await fetch(`${url}/health`, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(ok.status).toBe(200);
    } finally {
      await stop(server);
    }
  });

  it('leaves the OpenAPI document readable without a token', async () => {
    const { server, url } = await start({ apiKey: 'secret-token' });
    try {
      const response = await fetch(`${url}/openapi.json`);
      expect(response.status).toBe(200);
      expect((await response.json()).security).toEqual([{ bearerAuth: [] }]);
    } finally {
      await stop(server);
    }
  });

  it('sends no CORS headers unless an origin is allowed', async () => {
    const { server, url } = await start();
    try {
      const response = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.test' } });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await stop(server);
    }
  });

  it('sends CORS headers only to a configured origin', async () => {
    const { server, url } = await start({ allowedOrigins: ['https://good.test'] });
    try {
      const allowed = await fetch(`${url}/health`, { headers: { Origin: 'https://good.test' } });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://good.test');

      const denied = await fetch(`${url}/health`, { headers: { Origin: 'https://evil.test' } });
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await stop(server);
    }
  });
});

describe('configuration', () => {
  it('defaults to loopback and no key', () => {
    const config = resolveConfig();
    expect(config.host).toBe('127.0.0.1');
    expect(config.apiKey).toBeUndefined();
    expect(config.allowedOrigins).toEqual([]);
    expect(config.logRequests).toBe(false);
  });

  it('knows which binds are reachable from outside', () => {
    expect(isPubliclyBound('127.0.0.1')).toBe(false);
    expect(isPubliclyBound('localhost')).toBe(false);
    expect(isPubliclyBound('::1')).toBe(false);
    expect(isPubliclyBound('0.0.0.0')).toBe(true);
    expect(isPubliclyBound('192.168.1.10')).toBe(true);
  });
});
