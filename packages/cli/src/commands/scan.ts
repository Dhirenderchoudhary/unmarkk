/**
 * `unmark scan` — walk a directory and report what is leaking.
 *
 * Read-only by design. Scanning is how you find out what a folder gives away
 * before deciding what to do about it; nothing here writes.
 *
 * The output is ordered worst-first, because an audit gets read from the top
 * and abandoned somewhere in the middle.
 */

import { readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import {
  auditBytes,
  buildAuditReport,
  rankItems,
  type AuditItem,
  type AuditReport,
} from '@unmarkk/core';
import { CliError, MAX_INPUT_BYTES, readInput } from '../io.js';
import { json, out, style } from '../render.js';

/** Directories never worth walking into. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  'vendor',
]);

const SCANNABLE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.pdf',
  '.docx',
  '.odt',
  '.html',
  '.htm',
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
]);

export interface ScanArgs {
  readonly paths: readonly string[];
  readonly json: boolean;
  /** Try every file, not just recognised extensions. */
  readonly all: boolean;
  /** Only print items that need attention. */
  readonly quiet: boolean;
  /** Also score prose for machine-authorship style. */
  readonly stylometry: boolean;
  /** Extra directory names to skip. */
  readonly skip: readonly string[];
}

/**
 * Show a path relative to the working directory, but only when that is
 * actually shorter. Scanning `/tmp` from a deep project directory otherwise
 * produces `../../../../tmp/x`, which is harder to read than the real path.
 */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (rel === '') return path;
  return rel.startsWith('..') ? path : rel;
}

async function* walk(root: string, skip: ReadonlySet<string>): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(full, skip);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Exit code: 0 when nothing needs attention, 1 when something does. */
export async function runScan(args: ScanArgs): Promise<number> {
  if (args.paths.length === 0) throw new CliError('scan needs at least one directory');

  const skip = new Set([...SKIP_DIRECTORIES, ...args.skip]);
  const items: AuditItem[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const root of args.paths) {
    for await (const path of walk(root, skip)) {
      if (!args.all && !SCANNABLE_EXTENSIONS.has(extname(path).toLowerCase())) continue;

      const display = displayPath(path);
      let data: Uint8Array;
      try {
        data = await readInput(path);
      } catch (error) {
        skipped.push({
          name: display,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (data.length > MAX_INPUT_BYTES) {
        skipped.push({ name: display, reason: 'larger than the input cap' });
        continue;
      }

      items.push(await auditBytes(data, basename(path), { stylometry: args.stylometry }));
      // auditBytes only sees the basename, for format routing. Restore the
      // path the user recognises for display.
      const last = items[items.length - 1]!;
      items[items.length - 1] = { ...last, name: display };
    }
  }

  const report = buildAuditReport(args.paths.join(', '), rankItems(items), skipped);

  if (args.json) {
    json(report);
  } else {
    renderAudit(report, args.quiet);
  }

  return report.summary.actionable > 0 ? 1 : 0;
}

/** Shared renderer, also used by the website audit. */
export function renderAudit(report: AuditReport, quiet: boolean): void {
  const { summary } = report;

  for (const item of report.items) {
    if (quiet && !item.actionable) continue;

    if (item.error !== undefined) {
      out(`${style.red('?')} ${item.name}  ${style.dim(item.error)}`);
      continue;
    }

    const mark = item.actionable ? style.yellow('!') : style.green('.');
    const parts: string[] = [];
    if (item.hasC2pa) parts.push('C2PA manifest');
    else if (item.hasAiMetadata) parts.push('AI provenance');
    parts.push(...item.privacy.map((p) => p.split(' (')[0]!));
    if (item.suspiciousTotal > 0) parts.push(`${item.suspiciousTotal} invisible`);
    if (item.stylometryLevel !== undefined && item.stylometryLevel !== 'CLEAN') {
      parts.push(`style ${item.stylometryLevel}`);
    }

    out(
      `${mark} ${item.name}${style.dim(` · ${item.format}`)}` +
        (parts.length > 0 ? `  ${style.dim(parts.join(', '))}` : ''),
    );
  }

  out();
  out(
    `${style.bold(String(summary.total))} scanned · ` +
      `${style.bold(String(summary.actionable))} need attention` +
      (summary.errored > 0 ? ` · ${summary.errored} unreadable` : '') +
      (report.skipped.length > 0 ? style.dim(` · ${report.skipped.length} skipped`) : ''),
  );

  const kinds = Object.entries(summary.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`);
  if (kinds.length > 0) out(style.dim(`  by format: ${kinds.join(', ')}`));

  const confidence = (['confirmed', 'probable', 'informational', 'likely-false-positive'] as const)
    .filter((level) => summary.byConfidence[level] > 0)
    .map((level) => `${level} ${summary.byConfidence[level]}`);
  if (confidence.length > 0) out(style.dim(`  findings: ${confidence.join(', ')}`));

  const exposure: string[] = [];
  if (summary.withLocation > 0) exposure.push(`${summary.withLocation} with location`);
  if (summary.withDeviceIdentity > 0)
    exposure.push(`${summary.withDeviceIdentity} with device identity`);
  if (summary.withAuthorIdentity > 0)
    exposure.push(`${summary.withAuthorIdentity} naming a person`);
  if (summary.withTimestamps > 0) exposure.push(`${summary.withTimestamps} with timestamps`);
  if (exposure.length > 0) out(style.magenta(`  ${exposure.join(', ')}`));

  if (summary.actionable > 0) {
    out();
    out(style.dim('  clean them with: unmark clean <path> --in-place'));
  }
}
