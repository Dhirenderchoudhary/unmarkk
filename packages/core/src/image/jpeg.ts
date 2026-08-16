/**
 * JPEG segment inspection and stripping.
 *
 * A JPEG is a chain of `FF xx` marked segments ending in the entropy-coded
 * scan. Metadata lives in the `APPn` segments before the scan:
 *
 *   APP1  Exif (GPS, camera serial, timestamps) and XMP
 *   APP2  ICC colour profile, and MPF on multi-picture files
 *   APP11 JUMBF — where C2PA content credentials go
 *   APP13 Photoshop IRB / IPTC — captions, bylines, credit lines
 *   COM   free-text comment
 *
 * Removing them is lossless: the compressed image data is untouched, so the
 * output decodes to exactly the same pixels. Two segments are deliberately
 * kept because dropping them changes how the image *renders*: APP0 (JFIF
 * density) and APP14 (the Adobe colour-transform flag, without which CMYK and
 * YCCK files decode with inverted or wrong colours).
 */

import { concatBytes, readU16BE, startsWith, u16BE } from '../util/bytes.js';
import {
  AI_MARKERS,
  C2PA_MARKERS,
  asciiView,
  findIn,
  markerConfidence,
  mergePrivacy,
  scanPrivacy,
} from '../markers.js';
import { scanExif } from './exif.js';
import type { Action, Finding } from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';
import type { ImageScan, StripResult } from './png.js';

const SOI = Uint8Array.of(0xff, 0xd8);

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_COM = 0xfe;
const APP0 = 0xe0;
const APP11 = 0xeb;
const APP14 = 0xee;
const APP15 = 0xef;

/** Segments whose removal would change how the image decodes. */
const RENDER_CRITICAL_APPS: ReadonlySet<number> = new Set([APP0, APP14]);

const EXIF_INTRO = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0x00, 0x00); // "Exif\0\0"

export interface JpegSegment {
  readonly marker: number;
  readonly payload: Uint8Array;
  readonly offset: number;
}

export interface JpegParse {
  readonly segments: readonly JpegSegment[];
  /** Offset where the entropy-coded scan begins, or -1 if never reached. */
  readonly scanOffset: number;
  readonly problems: readonly string[];
}

/** Walk segments up to the start of scan. */
export function parseJpeg(data: Uint8Array): JpegParse {
  const segments: JpegSegment[] = [];
  const problems: string[] = [];

  if (!startsWith(data, SOI)) {
    return { segments, scanOffset: -1, problems: ['not a JPEG (no SOI)'] };
  }

  let i = 2;
  const n = data.length;
  while (i + 2 <= n) {
    if (data[i] !== 0xff) {
      problems.push(`expected a marker at offset ${i}`);
      break;
    }
    // Fill bytes: any number of 0xFF may precede the marker code.
    while (i < n && data[i] === 0xff) i += 1;
    if (i >= n) break;

    const marker = data[i]!;
    const markerStart = i - 1;
    i += 1;

    // Standalone markers carry no length field.
    if (marker === MARKER_SOI || marker === MARKER_EOI || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, payload: new Uint8Array(0), offset: markerStart });
      continue;
    }

    if (marker === MARKER_SOS) {
      if (i + 2 > n) {
        problems.push('truncated SOS header');
        break;
      }
      const headerLength = readU16BE(data, i);
      segments.push({
        marker,
        payload: data.subarray(i + 2, Math.min(i + headerLength, n)),
        offset: markerStart,
      });
      return { segments, scanOffset: markerStart, problems };
    }

    if (i + 2 > n) {
      problems.push(`truncated segment header at offset ${markerStart}`);
      break;
    }
    const length = readU16BE(data, i);
    if (length < 2 || i + length > n) {
      problems.push(`bad segment length ${length} at offset ${markerStart}`);
      break;
    }
    segments.push({ marker, payload: data.subarray(i + 2, i + length), offset: markerStart });
    i += length;
  }

  return { segments, scanOffset: -1, problems };
}

function appName(marker: number): string {
  return marker >= APP0 && marker <= APP15 ? `APP${marker - APP0}` : `0x${marker.toString(16)}`;
}

export function inspectJpeg(data: Uint8Array): ImageScan {
  const { segments, problems } = parseJpeg(data);
  const findings: Finding[] = [];
  const notes: string[] = [...problems];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let privacy = NO_PRIVACY_FINDINGS;

  for (const seg of segments) {
    const { marker, payload } = seg;

    if (marker === APP11) {
      hasC2pa = true;
      hasAiMetadata = true;
      findings.push({
        code: 'jpeg.app11.jumbf',
        message: 'APP11 segment carries a JUMBF box — the C2PA content-credentials container',
        confidence: 'confirmed',
        at: `offset ${seg.offset}`,
      });
      continue;
    }

    if (marker === MARKER_COM) {
      const view = asciiView(payload);
      privacy = mergePrivacy(privacy, scanPrivacy(view));
      findings.push({
        code: 'jpeg.com',
        message: `free-text comment segment (${payload.length} bytes)`,
        confidence: 'informational',
        at: `offset ${seg.offset}`,
      });
      continue;
    }

    if (marker < APP0 || marker > APP15) continue;

    // APP1 with the Exif introducer is a full TIFF block; parse it properly
    // rather than string-matching binary tag numbers.
    if (marker === 0xe1 && startsWith(payload, EXIF_INTRO)) {
      const exif = scanExif(payload.subarray(EXIF_INTRO.length));
      privacy = mergePrivacy(privacy, exif.privacy);
      findings.push({
        code: 'jpeg.app1.exif',
        message:
          exif.tags.length > 0
            ? `Exif block with ${exif.tags.length} identifying tags: ${exif.tags.join(', ')}`
            : 'Exif block present',
        confidence: 'confirmed',
        at: `offset ${seg.offset}`,
      });
      continue;
    }

    const view = asciiView(payload);
    const c2paHits = findIn(view, C2PA_MARKERS);
    const aiHits = findIn(view, AI_MARKERS);

    if (c2paHits.length > 0) hasC2pa = true;
    if (aiHits.length > 0) hasAiMetadata = true;
    if (c2paHits.length > 0 || aiHits.length > 0) {
      const hits = [...new Set([...c2paHits, ...aiHits])];
      findings.push({
        code: 'jpeg.app.markers',
        message: `${appName(marker)} contains provenance markers: ${hits.slice(0, 8).join(', ')}`,
        confidence: markerConfidence(hits),
        at: `offset ${seg.offset}`,
      });
    }

    const segPrivacy = scanPrivacy(view);
    privacy = mergePrivacy(privacy, segPrivacy);
    if (marker === 0xe1 && view.includes('xmpmeta')) {
      findings.push({
        code: 'jpeg.app1.xmp',
        message: 'APP1 segment carries an XMP packet',
        confidence: 'informational',
        at: `offset ${seg.offset}`,
      });
    }
    if (marker === 0xed) {
      findings.push({
        code: 'jpeg.app13.iptc',
        message: 'APP13 segment carries a Photoshop IRB / IPTC block (captions, byline, credit)',
        confidence: 'confirmed',
        at: `offset ${seg.offset}`,
      });
      privacy = mergePrivacy(privacy, { ...NO_PRIVACY_FINDINGS, hasAuthorIdentity: true });
    }
  }

  return { hasC2pa, hasAiMetadata, findings, privacy, notes };
}

export interface StripJpegOptions {
  /** Drop every APPn except the render-critical ones. Default true. */
  readonly stripAll?: boolean;
}

/** Rebuild the JPEG without metadata segments, preserving the scan verbatim. */
export function stripJpeg(data: Uint8Array, options: StripJpegOptions = {}): StripResult {
  const stripAll = options.stripAll ?? true;
  const { segments, scanOffset, problems } = parseJpeg(data);
  if (segments.length === 0) {
    throw new Error(problems[0] ?? 'not a JPEG');
  }

  const actions: Action[] = [];
  const dropped = new Map<string, number>();
  const out: Uint8Array[] = [SOI];

  for (const seg of segments) {
    const { marker, payload } = seg;

    if (marker === MARKER_SOI) continue; // already emitted
    if (marker === MARKER_SOS) break; // handled below, with the scan

    let drop = false;
    if (marker === APP11) {
      drop = true;
    } else if (marker === MARKER_COM) {
      drop = true;
    } else if (marker >= APP0 && marker <= APP15 && !RENDER_CRITICAL_APPS.has(marker)) {
      drop = stripAll || findIn(asciiView(payload), [...C2PA_MARKERS, ...AI_MARKERS]).length > 0;
    }

    if (drop) {
      const name = marker === MARKER_COM ? 'COM' : appName(marker);
      dropped.set(name, (dropped.get(name) ?? 0) + 1);
      continue;
    }

    out.push(Uint8Array.of(0xff, marker));
    if (payload.length > 0 || (marker >= APP0 && marker <= APP15)) {
      out.push(u16BE(payload.length + 2), payload);
    }
  }

  if (scanOffset < 0) {
    throw new Error('JPEG has no start-of-scan marker; refusing to write a truncated image');
  }
  // Everything from the SOS marker to EOF is entropy-coded image data plus the
  // EOI. Copying it as one block is both faster and safer than re-deriving the
  // byte-stuffed boundaries.
  out.push(data.subarray(scanOffset));

  for (const [name, count] of dropped) {
    actions.push({
      code: `jpeg.drop.${name.toLowerCase()}`,
      message: `removed ${count} ${name} segment${count === 1 ? '' : 's'}`,
      count,
    });
  }
  if (actions.length === 0) {
    actions.push({ code: 'jpeg.clean.noop', message: 'no metadata segments to remove' });
  }
  actions.push({
    code: 'jpeg.keep.render-critical',
    message: 'kept APP0/APP14 so JFIF density and Adobe colour transform still decode correctly',
  });

  return { output: concatBytes(out), actions };
}

/** True when the bytes begin with a JPEG SOI marker. */
export function isJpeg(data: Uint8Array): boolean {
  return startsWith(data, Uint8Array.of(0xff, 0xd8, 0xff));
}
