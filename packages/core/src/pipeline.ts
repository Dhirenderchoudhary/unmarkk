/**
 * The unified entry points.
 *
 * Everything above this file is format-specific. This is where a caller hands
 * over bytes and a filename and gets back a report or a cleaned copy, without
 * having to know whether the thing is a PNG or an ODT.
 *
 * There is no I/O here and none anywhere below it. The engine cannot read a
 * file, open a socket, or phone home, because nothing in it has the capability
 * to — which is a stronger statement than a privacy policy.
 */

import type {
  CleanOptions,
  CleanResult,
  InspectOptions,
  InspectReport,
  TextCleanResult,
  TextReport,
} from './types.js';
import { CONFIDENCE_RANK } from './types.js';
import { classify, sniffBinary } from './detect.js';
import { decodeText, encodeText } from './util/text-codec.js';
import { cleanText, inspectText } from './text/unicode.js';
import { scoreStylometry, DEFAULT_THRESHOLD } from './text/stylometry.js';
import { cleanImage, inspectImage } from './image/index.js';
import { cleanContainer, inspectContainer } from './container/index.js';

/** Thrown when the input is refused rather than processed. */
export class UnmarkInputError extends Error {
  readonly advice: readonly string[];

  constructor(message: string, advice: readonly string[] = []) {
    super(message);
    this.name = 'UnmarkInputError';
    this.advice = advice;
  }
}

function guardText(data: Uint8Array, options: InspectOptions, label: string): void {
  if (options.forceText === true) return;
  const kind = sniffBinary(data);
  if (kind === null) return;
  throw new UnmarkInputError(`refusing to treat ${label} as text: it looks like ${kind}`, [
    'Let the format router handle it, or pass the force-text option to scan the raw bytes anyway.',
  ]);
}

/** Inspect bytes without modifying them. */
export async function inspect(
  data: Uint8Array,
  options: InspectOptions = {},
): Promise<InspectReport> {
  const kind = options.as ?? (await classify(data, options.filename));
  const label = options.filename ?? 'these bytes';

  if (kind === 'image') return inspectImage(data);
  if (kind === 'container') return inspectContainer(data, options.filename);

  guardText(data, options, label);
  const text = decodeText(data);
  const report = inspectText(text, {
    aggressive: options.aggressive ?? false,
  });

  if (options.stylometry !== true) return report;
  return { ...report, stylometry: scoreStylometry(text) } satisfies TextReport;
}

/** Clean bytes, returning the result and a record of what was done. */
export async function clean(data: Uint8Array, options: CleanOptions = {}): Promise<CleanResult> {
  const kind = options.as ?? (await classify(data, options.filename));
  const label = options.filename ?? 'these bytes';

  if (kind === 'image') return cleanImage(data, options);
  if (kind === 'container') return cleanContainer(data, options);

  guardText(data, options, label);
  const text = decodeText(data);
  const result = cleanText(text, {
    nfkc: options.nfkc ?? false,
    aggressive: options.aggressive ?? false,
    aggressiveHomoglyphs: options.aggressiveHomoglyphs ?? false,
    normalizeSpaces: options.normalizeSpaces ?? true,
    stripEmojiGlue: options.stripEmojiGlue ?? false,
  });
  const output = encodeText(result.text);

  return {
    kind: 'text',
    format: 'text',
    output,
    actions: [
      {
        code: 'text.unicode.clean',
        message: `removed ${result.stats.removedCount} invisible character${result.stats.removedCount === 1 ? '' : 's'}, replaced ${result.stats.replacedCount}`,
        count: result.stats.removedCount + result.stats.replacedCount,
      },
    ],
    bytesIn: data.length,
    bytesOut: output.length,
    stats: result.stats,
  } satisfies TextCleanResult;
}

/** A one-line verdict derived from a report. */
export interface Verdict {
  /** True when anything worth acting on was found. */
  readonly flagged: boolean;
  /** Strongest confidence level among the findings. */
  readonly highestConfidence: InspectReport['findings'][number]['confidence'] | 'none';
  readonly summary: string;
}

/** Reduce a report to a verdict, for exit codes and one-line output. */
export function summarise(report: InspectReport, stylometryThreshold = DEFAULT_THRESHOLD): Verdict {
  let highest: Verdict['highestConfidence'] = 'none';
  for (const finding of report.findings) {
    if (highest === 'none' || CONFIDENCE_RANK[finding.confidence] > CONFIDENCE_RANK[highest]) {
      highest = finding.confidence;
    }
  }

  if (report.kind === 'text') {
    const styleFlagged =
      report.stylometry !== undefined &&
      report.stylometry.status === 'ok' &&
      report.stylometry.score >= stylometryThreshold;
    const flagged = report.suspiciousTotal > 0 || styleFlagged;

    const parts: string[] = [];
    if (report.suspiciousTotal > 0) {
      parts.push(
        `${report.suspiciousTotal} invisible character${report.suspiciousTotal === 1 ? '' : 's'} across ${report.hits.length} codepoint${report.hits.length === 1 ? '' : 's'}`,
      );
    }
    if (styleFlagged) {
      parts.push(`stylometry ${report.stylometry!.level} (${report.stylometry!.score.toFixed(2)})`);
    }
    return {
      flagged,
      highestConfidence: highest,
      summary: parts.length > 0 ? parts.join('; ') : 'no invisible-character carriers found',
    };
  }

  const privacyFlagged =
    report.privacy.hasLocation ||
    report.privacy.hasDeviceIdentity ||
    report.privacy.hasAuthorIdentity ||
    report.privacy.hasTimestamps;

  // Anything a parser actually confirmed counts, whether or not it maps to one
  // of the four privacy categories. Keying the verdict off those categories
  // alone meant a file could carry a confirmed Exif block full of UserComment
  // and Adobe XMP and still be summarised as "clean" — the tag names simply
  // were not in a category list. A false clean is the worst outcome this tool
  // can produce, because the user then publishes the file.
  const substantiated = report.findings.filter(
    (f) => f.confidence === 'confirmed' || f.confidence === 'probable',
  );
  const flagged =
    report.hasC2pa || report.hasAiMetadata || privacyFlagged || substantiated.length > 0;

  const parts: string[] = [];
  if (report.hasC2pa) parts.push('C2PA manifest');
  else if (report.hasAiMetadata) parts.push('AI provenance metadata');
  if (report.privacy.hasLocation) parts.push('location');
  if (report.privacy.hasDeviceIdentity) parts.push('device identity');
  if (report.privacy.hasAuthorIdentity) parts.push('author identity');
  if (report.privacy.hasTimestamps) parts.push('timestamps');

  // Findings the categories did not describe still need saying out loud.
  if (parts.length === 0 && substantiated.length > 0) {
    const n = substantiated.length;
    parts.push(`${n} metadata block${n === 1 ? '' : 's'} carrying unclassified content`);
  }

  return {
    flagged,
    highestConfidence: highest,
    summary: parts.length > 0 ? parts.join(', ') : 'no metadata found',
  };
}
