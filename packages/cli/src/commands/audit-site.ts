/**
 * `unmark audit-site` — audit the pages and assets a public site publishes.
 *
 * The use case: you run a site, things get uploaded to it over years by
 * different people and different tools, and you would like to know how many of
 * those images still carry the GPS coordinates of wherever they were taken.
 * Checking by hand stops being realistic at about ten files.
 *
 * This is the one command that makes network requests. It only ever issues
 * GETs, against URLs listed in a sitemap you named, through the hardened
 * fetcher in `net.ts`. Nothing is uploaded — bytes come in, are inspected in
 * memory, and are discarded.
 */

import { auditBytes, buildAuditReport, decodeText, rankItems, type AuditItem } from '@unmarkk/core';
import { CliError } from '../io.js';
import { err, json, out, style } from '../render.js';
import { renderAudit } from './scan.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  decompressSitemap,
  filenameForUrl,
  parseSitemap,
  safeFetch,
} from '../net.js';

export interface AuditSiteArgs {
  /** A sitemap URL, or a single page URL to audit on its own. */
  readonly target: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly stylometry: boolean;
  readonly limit: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Permit private and loopback addresses, for auditing an intranet you own. */
  readonly allowPrivate: boolean;
}

export const AUDIT_SITE_DEFAULTS = {
  limit: 200,
  concurrency: 4,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBytes: DEFAULT_MAX_BYTES,
} as const;

/** Follow a sitemap, including one level of sitemap index. */
async function collectUrls(args: AuditSiteArgs): Promise<string[]> {
  const target = args.target;
  const looksLikeSitemap = /\.xml(\.gz)?(\?.*)?$/i.test(target);
  if (!looksLikeSitemap) return [target];

  const response = await safeFetch(target, {
    timeoutMs: args.timeoutMs,
    maxBytes: args.maxBytes,
    allowPrivate: args.allowPrivate,
  });
  if (response.status !== 200) {
    throw new CliError(`sitemap returned HTTP ${response.status}: ${target}`);
  }

  const { isIndex, urls } = parseSitemap(decodeText(decompressSitemap(response.body)));
  if (urls.length === 0) throw new CliError(`no <loc> entries found in ${target}`);
  if (!isIndex) return urls.slice(0, args.limit);

  // A sitemap index points at more sitemaps. One level of nesting is the
  // common shape; deeper nesting is rare and unbounded, so it is not followed.
  const collected: string[] = [];
  for (const child of urls) {
    if (collected.length >= args.limit) break;
    try {
      const nested = await safeFetch(child, {
        timeoutMs: args.timeoutMs,
        maxBytes: args.maxBytes,
        allowPrivate: args.allowPrivate,
      });
      collected.push(...parseSitemap(decodeText(decompressSitemap(nested.body))).urls);
    } catch (error) {
      err(style.dim(`  skipped nested sitemap ${child}: ${(error as Error).message}`));
    }
  }
  return collected.slice(0, args.limit);
}

/** Run `worker` over `items` with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

/** Exit code: 0 when nothing needs attention, 1 when something does. */
export async function runAuditSite(args: AuditSiteArgs): Promise<number> {
  if (args.target === '') throw new CliError('audit-site needs a sitemap or page URL');

  if (!args.json) err(style.dim(`resolving ${args.target}…`));

  const urls = await collectUrls(args);
  if (!args.json) {
    err(style.dim(`auditing ${urls.length} URL${urls.length === 1 ? '' : 's'}…`));
    err('');
  }

  const skipped: { name: string; reason: string }[] = [];

  const results = await mapWithConcurrency(urls, args.concurrency, async (url) => {
    try {
      const response = await safeFetch(url, {
        timeoutMs: args.timeoutMs,
        maxBytes: args.maxBytes,
        allowPrivate: args.allowPrivate,
      });

      if (response.status !== 200) {
        skipped.push({ name: url, reason: `HTTP ${response.status}` });
        return undefined;
      }

      const item = await auditBytes(response.body, filenameForUrl(url, response.contentType), {
        stylometry: args.stylometry,
      });

      const notes = response.truncated
        ? [
            ...item.notes,
            `Only the first ${args.maxBytes} bytes were fetched; anything past that was not inspected.`,
          ]
        : item.notes;

      return { ...item, name: url, notes } satisfies AuditItem;
    } catch (error) {
      skipped.push({ name: url, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  });

  const audited = results.filter((item): item is AuditItem => item !== undefined);
  const report = buildAuditReport(args.target, rankItems(audited), skipped);

  if (args.json) {
    json(report);
    return report.summary.actionable > 0 ? 1 : 0;
  }

  renderAudit(report, args.quiet);

  if (skipped.length > 0) {
    out();
    out(style.dim('  not fetched:'));
    for (const item of skipped.slice(0, 10)) {
      out(style.dim(`    ${item.name} — ${item.reason}`));
    }
    if (skipped.length > 10) out(style.dim(`    …and ${skipped.length - 10} more`));
  }

  out();
  out(
    style.dim(
      '  A remote audit sees what the server sends. Download an asset and run `unmark inspect` on it for the full picture.',
    ),
  );

  return report.summary.actionable > 0 ? 1 : 0;
}
