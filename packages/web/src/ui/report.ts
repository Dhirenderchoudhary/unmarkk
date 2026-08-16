/**
 * Rendering a report so a person can act on it.
 *
 * The design problem here is not layout, it is *ranking*. A raw findings list
 * puts "an XMP packet exists" next to "this file contains the coordinates of
 * where it was taken", and a reader treats them the same. So findings are
 * grouped by what they mean to the person reading, exposure is surfaced as
 * its own row above everything else, and the unreliable byte-scan hits are
 * folded away until asked for.
 */

import type { Confidence, Finding, InspectReport, PrivacyFindings } from '@unmarkk/core';
import { el, icon } from './dom.js';

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: 'confirmed',
  probable: 'probable',
  informational: 'context',
  'likely-false-positive': 'unreliable',
};

/** The four things that identify a person, with an icon each. */
const EXPOSURE = [
  {
    key: 'hasLocation' as const,
    icon: 'location' as const,
    label: 'Location',
    detail: 'GPS coordinates of where this was taken',
  },
  {
    key: 'hasDeviceIdentity' as const,
    icon: 'camera' as const,
    label: 'Device',
    detail: 'camera make, model or serial number',
  },
  {
    key: 'hasAuthorIdentity' as const,
    icon: 'person' as const,
    label: 'Identity',
    detail: 'a name, company or copyright holder',
  },
  {
    key: 'hasTimestamps' as const,
    icon: 'clock' as const,
    label: 'Timestamps',
    detail: 'when it was created or last edited',
  },
];

/** The row of chips showing what a file gives away about its owner. */
export function renderExposure(privacy: PrivacyFindings): HTMLElement | null {
  const present = EXPOSURE.filter((row) => privacy[row.key]);
  if (present.length === 0) return null;

  return el(
    'div',
    { class: 'exposure', role: 'list' },
    ...present.map((row) =>
      el(
        'span',
        { class: 'chip chip-exposure', role: 'listitem', title: row.detail },
        icon(row.icon, 14),
        row.label,
      ),
    ),
  );
}

/** Which bucket a finding belongs in, from its stable code. */
function bucketOf(finding: Finding): 'provenance' | 'identity' | 'invisible' | 'context' {
  if (finding.confidence === 'likely-false-positive' || finding.confidence === 'informational') {
    return 'context';
  }
  if (finding.code.startsWith('text.unicode')) return 'invisible';
  if (/c2pa|jumbf|provenance|generator|\.ai\b|jsonld|data-ai/.test(finding.code)) {
    return 'provenance';
  }
  return 'identity';
}

const BUCKET_TITLES = {
  provenance: 'Provenance claims',
  identity: 'Identifying metadata',
  invisible: 'Invisible characters',
  context: 'Context',
} as const;

function renderFinding(finding: Finding): HTMLElement {
  return el(
    'li',
    { class: 'finding' },
    el('span', { class: `tag tag-${finding.confidence}` }, CONFIDENCE_LABEL[finding.confidence]),
    el(
      'span',
      { class: 'finding-body' },
      finding.message,
      finding.at === undefined ? null : el('span', { class: 'finding-at' }, finding.at),
    ),
  );
}

/** Findings, grouped, with the low-signal ones folded away. */
export function renderFindings(findings: readonly Finding[]): HTMLElement | null {
  if (findings.length === 0) return null;

  const buckets = new Map<ReturnType<typeof bucketOf>, Finding[]>();
  for (const finding of findings) {
    const bucket = bucketOf(finding);
    const list = buckets.get(bucket);
    if (list === undefined) buckets.set(bucket, [finding]);
    else list.push(finding);
  }

  const container = el('div', { class: 'findings' });

  for (const key of ['provenance', 'identity', 'invisible'] as const) {
    const group = buckets.get(key);
    if (group === undefined) continue;
    container.append(
      el('h4', { class: 'findings-title' }, BUCKET_TITLES[key]),
      el('ul', { class: 'finding-list' }, ...group.map(renderFinding)),
    );
  }

  // Context findings are real but rarely what someone is looking for. They go
  // behind a disclosure so the important rows are not buried under them.
  const context = buckets.get('context');
  if (context !== undefined) {
    container.append(
      el(
        'details',
        { class: 'context-block' },
        el(
          'summary',
          {},
          `${context.length} more note${context.length === 1 ? '' : 's'} (context and low-confidence)`,
        ),
        el('ul', { class: 'finding-list' }, ...context.map(renderFinding)),
      ),
    );
  }

  return container;
}

/** A short sentence saying what the file gives away, in plain language. */
export function plainSummary(report: InspectReport): string {
  if (report.kind === 'text') {
    if (report.suspiciousTotal === 0) return 'No invisible characters found.';
    const n = report.suspiciousTotal;
    const kinds = report.hits.length;
    return `${n} invisible character${n === 1 ? '' : 's'} across ${kinds} codepoint${kinds === 1 ? '' : 's'}.`;
  }

  const parts: string[] = [];
  const present = EXPOSURE.filter((row) => report.privacy[row.key]);
  if (present.length > 0) {
    parts.push(`This file records ${present.map((r) => r.detail).join(', ')}`);
  }
  if (report.hasC2pa) parts.push('It carries a C2PA content-credentials manifest');
  else if (report.hasAiMetadata) parts.push('It carries AI provenance metadata');

  if (parts.length === 0) return 'No identifying metadata or provenance marks found.';
  return `${parts.join('. ')}.`;
}

/** The stylometry note, worded so nobody mistakes it for a verdict. */
export function renderStylometry(report: InspectReport): HTMLElement | null {
  if (report.kind !== 'text' || report.stylometry === undefined) return null;
  const s = report.stylometry;
  if (s.status !== 'ok') return null;

  return el(
    'div',
    { class: 'note note-neutral' },
    icon('spark', 15),
    el(
      'div',
      {},
      el('strong', {}, `Writing style: ${s.level.toLowerCase()}`),
      ` (${s.score.toFixed(2)}). This measures how the text reads — sentence evenness, formulaic phrasing, vocabulary spread. It is a heuristic, not evidence of how the text was produced, and nothing here can change it.`,
    ),
  );
}

/** Notes the engine attached, rendered small. */
export function renderNotes(notes: readonly string[]): HTMLElement | null {
  if (notes.length === 0) return null;
  return el(
    'details',
    { class: 'context-block' },
    el('summary', {}, 'Scope and caveats'),
    el('ul', { class: 'note-list' }, ...notes.map((n) => el('li', {}, n))),
  );
}

/** The collapsible raw JSON, for people who want the whole thing. */
export function renderRaw(value: unknown): HTMLElement {
  return el(
    'details',
    { class: 'context-block' },
    el('summary', {}, 'Full report (JSON)'),
    el('pre', { class: 'raw' }, JSON.stringify(value, null, 2)),
  );
}
