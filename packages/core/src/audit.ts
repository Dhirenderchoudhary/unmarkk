/**
 * Aggregate auditing.
 *
 * Inspecting one file answers "what is in this?". Auditing answers a different
 * question — "of these four hundred things, which ones do I actually need to
 * deal with?" — and that needs the findings flattened into a shape you can
 * count, sort and threshold.
 *
 * The unit is an `AuditItem`: one file or URL, normalised so a directory walk
 * and a website crawl produce the same summary. Callers supply the bytes;
 * nothing here reads a file or opens a socket, same as the rest of the engine.
 */

import type { Confidence, Finding, InspectReport, Kind } from './types.js';
import { CONFIDENCE_RANK } from './types.js';
import { inspect } from './pipeline.js';
import { describePrivacy } from './markers.js';
import { scoreStylometry, DEFAULT_THRESHOLD } from './text/stylometry.js';
import { decodeText } from './util/text-codec.js';

/** One audited file or URL, flattened for counting. */
export interface AuditItem {
  /** Path or URL, as the caller wants it displayed. */
  readonly name: string;
  readonly kind: Kind | 'error';
  /** Concrete format, or `error` when the item could not be read. */
  readonly format: string;
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  /** Identifying-metadata categories present, already rendered for display. */
  readonly privacy: readonly string[];
  /** Count of invisible characters, for text-bearing items. */
  readonly suspiciousTotal: number;
  readonly findings: readonly Finding[];
  /** True when this item is worth a human's attention. */
  readonly actionable: boolean;
  readonly notes: readonly string[];
  /** Present only when stylometry was requested and the sample was long enough. */
  readonly stylometryScore?: number;
  readonly stylometryLevel?: string;
  /** Set instead of everything else when the item could not be inspected. */
  readonly error?: string;
  readonly bytes?: number;
}

export interface AuditSummary {
  readonly total: number;
  readonly actionable: number;
  readonly errored: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byConfidence: Readonly<Record<Confidence, number>>;
  readonly withC2pa: number;
  readonly withAiMetadata: number;
  readonly withInvisibleText: number;
  readonly withLocation: number;
  readonly withDeviceIdentity: number;
  readonly withAuthorIdentity: number;
  readonly withTimestamps: number;
  /** Strongest confidence seen anywhere in the audit. */
  readonly highestConfidence: Confidence | 'none';
}

export interface AuditReport {
  /** Directory root or sitemap URL the audit covered. */
  readonly root: string;
  readonly summary: AuditSummary;
  readonly items: readonly AuditItem[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

export interface AuditFileOptions {
  /** Also score text for machine-authorship style. Slower, and a heuristic. */
  readonly stylometry?: boolean;
  /** Score at or above which stylometry contributes a finding. */
  readonly stylometryThreshold?: number;
}

/**
 * An item earns attention when something was actually parsed out of it, or
 * when it identifies a person or a place.
 *
 * A `likely-false-positive` byte-scan hit on its own does not qualify — that
 * is the whole reason the confidence levels exist. An audit that flags
 * everything gets ignored, and then the real findings go unread too.
 */
function isActionable(
  findings: readonly Finding[],
  hasC2pa: boolean,
  privacy: readonly string[],
  suspiciousTotal: number,
): boolean {
  if (hasC2pa) return true;
  if (privacy.length > 0) return true;
  if (suspiciousTotal > 0) return true;
  return findings.some((f) => f.confidence === 'confirmed' || f.confidence === 'probable');
}

/** Inspect one item's bytes and flatten the result into an audit row. */
export async function auditBytes(
  data: Uint8Array,
  name: string,
  options: AuditFileOptions = {},
): Promise<AuditItem> {
  let report: InspectReport;
  try {
    report = await inspect(data, { filename: name });
  } catch (error) {
    return {
      name,
      kind: 'error',
      format: 'error',
      hasC2pa: false,
      hasAiMetadata: false,
      privacy: [],
      suspiciousTotal: 0,
      findings: [],
      actionable: false,
      notes: [],
      error: error instanceof Error ? error.message : String(error),
      bytes: data.length,
    };
  }

  const findings = [...report.findings];
  const privacy = report.kind === 'text' ? [] : describePrivacy(report.privacy);
  const hasC2pa = report.kind === 'text' ? false : report.hasC2pa;
  const hasAiMetadata = report.kind === 'text' ? false : report.hasAiMetadata;
  let suspiciousTotal = report.kind === 'text' ? report.suspiciousTotal : 0;

  let stylometryScore: number | undefined;
  let stylometryLevel: string | undefined;

  // Stylometry applies to anything that is prose underneath: plain text, and
  // the body of a Markdown or HTML document.
  const isProse =
    report.kind === 'text' ||
    (report.kind === 'container' && (report.format === 'markdown' || report.format === 'html'));

  if (options.stylometry === true && isProse) {
    const score = scoreStylometry(decodeText(data));
    if (score.status === 'ok') {
      stylometryScore = score.score;
      stylometryLevel = score.level;
      if (score.score >= (options.stylometryThreshold ?? DEFAULT_THRESHOLD)) {
        findings.push({
          code: 'text.stylometry.flagged',
          message: `writing style scores ${score.score.toFixed(2)} (${score.level}) on the machine-authorship heuristic`,
          confidence: 'informational',
        });
        suspiciousTotal += 1;
      }
    }
  }

  return {
    name,
    kind: report.kind,
    format: report.format,
    hasC2pa,
    hasAiMetadata,
    privacy,
    suspiciousTotal,
    findings,
    actionable: isActionable(findings, hasC2pa, privacy, suspiciousTotal),
    notes: report.notes,
    ...(stylometryScore === undefined ? {} : { stylometryScore, stylometryLevel }),
    bytes: data.length,
  };
}

/** Build the summary block shared by directory and website audits. */
export function summariseAudit(items: readonly AuditItem[]): AuditSummary {
  const byKind: Record<string, number> = {};
  const byConfidence: Record<Confidence, number> = {
    confirmed: 0,
    probable: 0,
    informational: 0,
    'likely-false-positive': 0,
  };

  let actionable = 0;
  let errored = 0;
  let withC2pa = 0;
  let withAiMetadata = 0;
  let withInvisibleText = 0;
  let withLocation = 0;
  let withDeviceIdentity = 0;
  let withAuthorIdentity = 0;
  let withTimestamps = 0;
  let highest: Confidence | 'none' = 'none';

  for (const item of items) {
    const key = item.error === undefined ? item.format : 'error';
    byKind[key] = (byKind[key] ?? 0) + 1;

    if (item.error !== undefined) errored += 1;
    if (item.actionable) actionable += 1;
    if (item.hasC2pa) withC2pa += 1;
    if (item.hasAiMetadata) withAiMetadata += 1;
    if (item.suspiciousTotal > 0) withInvisibleText += 1;

    for (const label of item.privacy) {
      if (label.startsWith('location')) withLocation += 1;
      else if (label.startsWith('device')) withDeviceIdentity += 1;
      else if (label.startsWith('author')) withAuthorIdentity += 1;
      else if (label.startsWith('capture')) withTimestamps += 1;
    }

    for (const finding of item.findings) {
      byConfidence[finding.confidence] += 1;
      if (highest === 'none' || CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[highest]) {
        highest = finding.confidence;
      }
    }
  }

  return {
    total: items.length,
    actionable,
    errored,
    byKind,
    byConfidence,
    withC2pa,
    withAiMetadata,
    withInvisibleText,
    withLocation,
    withDeviceIdentity,
    withAuthorIdentity,
    withTimestamps,
    highestConfidence: highest,
  };
}

/** Assemble a complete report from already-audited items. */
export function buildAuditReport(
  root: string,
  items: readonly AuditItem[],
  skipped: readonly { name: string; reason: string }[] = [],
): AuditReport {
  return { root, summary: summariseAudit(items), items, skipped };
}

/**
 * Order items worst-first.
 *
 * An audit is read from the top and abandoned somewhere in the middle, so the
 * ordering is the part that decides whether it was useful.
 */
export function rankItems(items: readonly AuditItem[]): AuditItem[] {
  const weight = (item: AuditItem): number => {
    let score = 0;
    for (const finding of item.findings) score += CONFIDENCE_RANK[finding.confidence] * 10;
    score += item.privacy.length * 25;
    if (item.hasC2pa) score += 40;
    if (item.suspiciousTotal > 0) score += 15;
    return score;
  };
  return [...items].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
}
