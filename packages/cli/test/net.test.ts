/**
 * Tests for the only code in the project that opens a socket.
 *
 * "Fetch a URL the user supplied" is the classic server-side request forgery
 * primitive, so these assert the guards rather than the happy path. Several of
 * them would have caught a real hole found during development: literal-IP URLs
 * skip DNS entirely, so a guard that only hooks `lookup` never runs for
 * `http://169.254.169.254/` — the cloud metadata endpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  decompressSitemap,
  filenameForUrl,
  isPrivateAddress,
  parseSitemap,
  safeFetch,
} from '../src/net.js';
import { checkEndpoint } from '../src/rewrite-backends.js';
import { CliError } from '../src/io.js';
import { gzipSync } from 'node:zlib';

describe('isPrivateAddress', () => {
  it('rejects IPv4 ranges that are not on the public internet', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.167.1.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('rejects IPv6 loopback, link-local and unique-local', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('sees through IPv4-mapped IPv6', () => {
    // ::ffff:127.0.0.1 is loopback wearing a disguise.
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('safeFetch guards', () => {
  it('refuses a literal private address before connecting', async () => {
    // The important case: no DNS lookup happens for a literal IP, so a guard
    // that only hooks `lookup` would let this straight through.
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private, loopback or link-local/,
    );
    await expect(safeFetch('http://127.0.0.1:9/x')).rejects.toThrow(/private, loopback/);
    await expect(safeFetch('http://[::1]/x')).rejects.toThrow(/private, loopback/);
    await expect(safeFetch('http://10.0.0.5/x')).rejects.toThrow(/private, loopback/);
  });

  it('refuses non-http schemes', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/only http and https/);
    await expect(safeFetch('ftp://example.com/x')).rejects.toThrow(/only http and https/);
    await expect(safeFetch('gopher://example.com/')).rejects.toThrow(/only http and https/);
  });

  it('refuses credentials embedded in the URL', async () => {
    await expect(safeFetch('http://user:pass@example.com/')).rejects.toThrow(/credentials/);
  });

  it('refuses a malformed URL', async () => {
    await expect(safeFetch('not a url')).rejects.toThrow(/not a valid URL/);
  });

  it('permits a private address when explicitly allowed', async () => {
    // Port 9 (discard) is reliably closed; the point is that the *guard* let it
    // through, so the failure is a connection error rather than a refusal.
    await expect(safeFetch('http://127.0.0.1:9/x', { allowPrivate: true })).rejects.toThrow(
      /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|socket hang up/,
    );
  });
});

describe('parseSitemap', () => {
  it('extracts locations', () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://a.test/1</loc></url><url><loc>https://a.test/2</loc></url></urlset>`;
    const { isIndex, urls } = parseSitemap(xml);
    expect(isIndex).toBe(false);
    expect(urls).toEqual(['https://a.test/1', 'https://a.test/2']);
  });

  it('recognises a sitemap index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml).isIndex).toBe(true);
  });

  it('decodes entities, which query strings are full of', () => {
    const xml = `<urlset><url><loc>https://a.test/p?a=1&amp;b=2</loc></url></urlset>`;
    expect(parseSitemap(xml).urls[0]).toBe('https://a.test/p?a=1&b=2');
  });

  it('tolerates whitespace and namespaces', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>
          https://a.test/spaced
        </loc>
      </url>
    </urlset>`;
    expect(parseSitemap(xml).urls).toEqual(['https://a.test/spaced']);
  });

  it('returns nothing for a document with no locations', () => {
    expect(parseSitemap('<urlset></urlset>').urls).toEqual([]);
  });
});

describe('decompressSitemap', () => {
  it('passes plain XML through untouched', () => {
    const plain = new TextEncoder().encode('<urlset/>');
    expect(decompressSitemap(plain)).toEqual(plain);
  });

  it('decompresses a gzipped sitemap', () => {
    const gz = new Uint8Array(gzipSync(Buffer.from('<urlset><url><loc>x</loc></url></urlset>')));
    expect(new TextDecoder().decode(decompressSitemap(gz))).toContain('<loc>x</loc>');
  });
});

describe('filenameForUrl', () => {
  it('prefers the content type', () => {
    expect(filenameForUrl('https://a.test/thing', 'image/jpeg')).toBe('page.jpg');
    expect(filenameForUrl('https://a.test/thing', 'application/pdf')).toBe('page.pdf');
    expect(filenameForUrl('https://a.test/x', 'text/html; charset=utf-8')).toBe('page.html');
  });

  it('falls back to the path', () => {
    expect(filenameForUrl('https://a.test/files/report.docx', '')).toBe('report.docx');
  });

  it('defaults to html for an extensionless page', () => {
    expect(filenameForUrl('https://a.test/about', '')).toBe('page.html');
  });
});

describe('rewrite endpoint policy', () => {
  it('allows loopback without comment', () => {
    expect(checkEndpoint('http://127.0.0.1:11434', false)).toBeNull();
    expect(checkEndpoint('http://localhost:8080', false)).toBeNull();
  });

  it('refuses a remote endpoint by default', () => {
    expect(() => checkEndpoint('https://api.example.com', false)).toThrow(CliError);
    expect(() => checkEndpoint('https://api.example.com', false)).toThrow(/not this machine/);
  });

  it('warns rather than refuses when remote is opted into', () => {
    const warning = checkEndpoint('https://api.example.com', true);
    expect(warning).toContain('leaving this machine');
  });

  it('refuses a non-http scheme', () => {
    expect(() => checkEndpoint('file:///model', true)).toThrow(/http or https/);
  });

  it('refuses a malformed URL', () => {
    expect(() => checkEndpoint('::::', true)).toThrow(/not a valid/);
  });
});
