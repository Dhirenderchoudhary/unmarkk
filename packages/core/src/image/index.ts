/** Format routing for raster images. */

import type {
  Action,
  BinaryCleanResult,
  CleanOptions,
  Finding,
  ImageFormat,
  ImageReport,
} from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';
import { C2PA_MARKERS, asciiView, describePrivacy, findIn, hasAnyPrivacyRisk } from '../markers.js';
import { inspectJpeg, isJpeg, stripJpeg } from './jpeg.js';
import { inspectPng, isPng, stripPng } from './png.js';
import { inspectWebp, isWebp, stripWebp } from './webp.js';

export * from './png.js';
export * from './jpeg.js';
export * from './webp.js';
export * from './exif.js';

/**
 * Cap for the raw byte-scan fallback.
 *
 * Scanning a whole 50 MB image for ASCII markers costs a 50 MB string and
 * finds mostly noise — compressed pixel data hits "c2pa" by chance often
 * enough that these results are reported as likely false positives anyway.
 */
const BYTE_SCAN_LIMIT = 4 << 20;

/** Identify a raster format from its magic bytes. */
export function detectImageFormat(data: Uint8Array): ImageFormat | 'unknown' {
  if (isPng(data)) return 'png';
  if (isJpeg(data)) return 'jpeg';
  if (isWebp(data)) return 'webp';
  return 'unknown';
}

/** Inspect a raster image for provenance manifests and identifying metadata. */
export function inspectImage(data: Uint8Array): ImageReport {
  const format = detectImageFormat(data);

  if (format === 'unknown') {
    return {
      kind: 'image',
      format: 'unknown',
      hasC2pa: false,
      hasAiMetadata: false,
      privacy: NO_PRIVACY_FINDINGS,
      findings: [],
      notes: ['Unrecognised image format. Only PNG, JPEG and WebP are parsed.'],
    };
  }

  const scan =
    format === 'png' ? inspectPng(data) : format === 'jpeg' ? inspectJpeg(data) : inspectWebp(data);

  const findings: Finding[] = [...scan.findings];
  let hasC2pa = scan.hasC2pa;

  // Last resort: a marker anywhere in the raw bytes. This catches manifests in
  // places the structured parsers do not model, at the cost of colliding with
  // compressed data — hence the confidence level.
  if (!hasC2pa) {
    const hits = findIn(asciiView(data, BYTE_SCAN_LIMIT), C2PA_MARKERS);
    if (hits.length > 0) {
      hasC2pa = true;
      findings.push({
        code: 'image.bytescan.c2pa',
        message: `raw byte scan matched ${hits.slice(0, 6).join(', ')} outside any parsed structure`,
        confidence: 'likely-false-positive',
      });
    }
  }

  const notes = [...scan.notes];
  const privacyLabels = describePrivacy(scan.privacy);
  if (privacyLabels.length > 0) {
    notes.push(`Identifying metadata present: ${privacyLabels.join('; ')}.`);
  }

  return {
    kind: 'image',
    format,
    hasC2pa,
    hasAiMetadata: scan.hasAiMetadata || hasC2pa,
    privacy: scan.privacy,
    findings,
    notes,
  };
}

/** Strip metadata from a raster image, then re-inspect the result. */
export function cleanImage(data: Uint8Array, options: CleanOptions = {}): BinaryCleanResult {
  const format = detectImageFormat(data);
  if (format === 'unknown') {
    throw new Error('unsupported image format: expected PNG, JPEG or WebP');
  }

  const stripAll = options.stripAllMetadata ?? true;
  const before = inspectImage(data);

  const stripped =
    format === 'png'
      ? stripPng(data, { stripAll })
      : format === 'jpeg'
        ? stripJpeg(data, { stripAll })
        : stripWebp(data, { stripAll });

  const after = inspectImage(stripped.output);
  const actions: Action[] = [...stripped.actions];

  if (hasAnyPrivacyRisk(before.privacy) && !hasAnyPrivacyRisk(after.privacy)) {
    actions.push({
      code: 'image.privacy.cleared',
      message: `removed identifying metadata: ${describePrivacy(before.privacy).join('; ')}`,
    });
  }

  return {
    kind: 'image',
    format,
    output: stripped.output,
    actions,
    bytesIn: data.length,
    bytesOut: stripped.output.length,
    residual: {
      hasC2pa: after.hasC2pa,
      hasAiMetadata: after.hasAiMetadata,
      findings: after.findings,
    },
    // Only a byte-scan hit can survive a successful structural rebuild, and
    // that is precisely the finding class we already label unreliable.
    degraded: false,
    details: { privacyBefore: before.privacy, privacyAfter: after.privacy },
  };
}
