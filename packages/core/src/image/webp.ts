/**
 * WebP chunk inspection and stripping.
 *
 * WebP is RIFF: a `RIFF` header, the `WEBP` form type, then FourCC chunks with
 * little-endian lengths and even-byte padding. Metadata lives in `EXIF`, `XMP `
 * and the C2PA chunk; `ICCP` is a colour profile and is kept.
 *
 * The subtlety is `VP8X`, the extended-format header. Its first byte is a flag
 * field declaring which optional chunks exist. Removing an `EXIF` chunk without
 * clearing the corresponding flag leaves a file that says it has EXIF and does
 * not — strict decoders reject it. So the flags are rewritten to match reality.
 */

import { concatBytes, readU32LE, u32LE } from '../util/bytes.js';
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

const RIFF = 'RIFF';
const WEBP = 'WEBP';

/** VP8X feature flags, by the chunk they announce. */
const VP8X_FLAGS: ReadonlyMap<string, number> = new Map([
  ['ICCP', 0x20],
  ['EXIF', 0x08],
  ['XMP ', 0x04],
]);

export interface WebpChunk {
  readonly fourcc: string;
  readonly payload: Uint8Array;
  readonly offset: number;
  /** True when the chunk had an odd length and therefore a pad byte. */
  readonly padded: boolean;
}

export interface WebpParse {
  readonly chunks: readonly WebpChunk[];
  readonly problems: readonly string[];
}

function fourccAt(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset]!,
    data[offset + 1]!,
    data[offset + 2]!,
    data[offset + 3]!,
  );
}

/** True when the bytes are a RIFF/WEBP container. */
export function isWebp(data: Uint8Array): boolean {
  return data.length >= 12 && fourccAt(data, 0) === RIFF && fourccAt(data, 8) === WEBP;
}

export function parseWebp(data: Uint8Array): WebpParse {
  if (!isWebp(data)) return { chunks: [], problems: ['not a WebP'] };

  const problems: string[] = [];
  const declared = readU32LE(data, 4);
  if (declared + 8 !== data.length) {
    problems.push(`RIFF size mismatch: header says ${declared + 8}, file is ${data.length}`);
  }

  const chunks: WebpChunk[] = [];
  let pos = 12;
  while (pos + 8 <= data.length) {
    const fourcc = fourccAt(data, pos);
    const length = readU32LE(data, pos + 4);
    const payloadStart = pos + 8;
    const payloadEnd = payloadStart + length;
    const paddedEnd = payloadEnd + (length & 1);

    if (paddedEnd > data.length) {
      problems.push(`truncated chunk ${fourcc} at offset ${pos}`);
      break;
    }
    chunks.push({
      fourcc,
      payload: data.subarray(payloadStart, payloadEnd),
      offset: pos,
      padded: (length & 1) === 1,
    });
    pos = paddedEnd;
  }

  if (pos !== data.length && !problems.some((p) => p.startsWith('truncated'))) {
    problems.push(`${data.length - pos} trailing bytes after the last chunk`);
  }
  return { chunks, problems };
}

export function inspectWebp(data: Uint8Array): ImageScan {
  const { chunks, problems } = parseWebp(data);
  const findings: Finding[] = [];
  const notes: string[] = [...problems];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let privacy = NO_PRIVACY_FINDINGS;

  for (const chunk of chunks) {
    const name = chunk.fourcc;

    if (name.toUpperCase() === 'C2PA') {
      hasC2pa = true;
      hasAiMetadata = true;
      findings.push({
        code: 'webp.chunk.c2pa',
        message: 'C2PA chunk holds a content-credentials manifest',
        confidence: 'confirmed',
        at: `offset ${chunk.offset}`,
      });
      continue;
    }

    if (name === 'EXIF') {
      const exif = scanExif(chunk.payload);
      privacy = mergePrivacy(privacy, exif.privacy);
      findings.push({
        code: 'webp.chunk.exif',
        message:
          exif.tags.length > 0
            ? `EXIF chunk with ${exif.tags.length} identifying tags: ${exif.tags.join(', ')}`
            : 'EXIF chunk present',
        confidence: 'confirmed',
        at: `offset ${chunk.offset}`,
      });
      continue;
    }

    if (name === 'XMP ') {
      const view = asciiView(chunk.payload);
      privacy = mergePrivacy(privacy, scanPrivacy(view));
      const hits = [...new Set([...findIn(view, C2PA_MARKERS), ...findIn(view, AI_MARKERS)])];
      if (hits.length > 0) {
        hasAiMetadata = true;
        if (findIn(view, C2PA_MARKERS).length > 0) hasC2pa = true;
      }
      findings.push({
        code: hits.length > 0 ? 'webp.chunk.xmp.markers' : 'webp.chunk.xmp',
        message:
          hits.length > 0
            ? `XMP chunk contains provenance markers: ${hits.slice(0, 8).join(', ')}`
            : 'XMP metadata chunk present',
        confidence: hits.length > 0 ? markerConfidence(hits) : 'informational',
        at: `offset ${chunk.offset}`,
      });
    }
  }

  return { hasC2pa, hasAiMetadata, findings, privacy, notes };
}

export interface StripWebpOptions {
  /** Remove ICCP too. Off by default: it changes rendered colour. */
  readonly stripColorProfile?: boolean;
  /** Remove every metadata chunk rather than only marker-bearing ones. */
  readonly stripAll?: boolean;
}

/** Rebuild the WebP without metadata chunks, fixing the VP8X flags. */
export function stripWebp(data: Uint8Array, options: StripWebpOptions = {}): StripResult {
  const stripAll = options.stripAll ?? true;
  const { chunks, problems } = parseWebp(data);
  if (chunks.length === 0) {
    throw new Error(problems[0] ?? 'not a WebP');
  }
  // A malformed container cannot be safely rewritten: chunk boundaries we
  // guessed wrong would be re-emitted as truth, and bytes we failed to account
  // for would vanish from the output without anyone being told. Trailing data
  // counts here too — a file that ends mid-header leaves a tail rather than a
  // truncated chunk, and silently dropping it is the same bug wearing a hat.
  const fatal = problems.find((p) => p.startsWith('truncated') || p.includes('trailing bytes'));
  if (fatal !== undefined) throw new Error(`malformed WebP: ${fatal}`);

  const actions: Action[] = [];
  const kept: WebpChunk[] = [];
  let clearedFlags = 0;

  for (const chunk of chunks) {
    const name = chunk.fourcc;
    let drop = name.toUpperCase() === 'C2PA';

    if (name === 'EXIF' || name === 'XMP ') {
      drop =
        stripAll || findIn(asciiView(chunk.payload), [...C2PA_MARKERS, ...AI_MARKERS]).length > 0;
    } else if (name === 'ICCP') {
      drop = options.stripColorProfile === true;
    }

    if (drop) {
      actions.push({
        code: `webp.drop.${name.trim().toLowerCase()}`,
        message: `removed ${name.trim()} chunk`,
      });
      clearedFlags |= VP8X_FLAGS.get(name) ?? 0;
      continue;
    }
    kept.push(chunk);
  }

  const body: Uint8Array[] = [Uint8Array.from(WEBP, (c) => c.charCodeAt(0))];
  for (const chunk of kept) {
    let payload = chunk.payload;
    if (chunk.fourcc === 'VP8X' && payload.length >= 1 && clearedFlags !== 0) {
      payload = Uint8Array.from(payload);
      payload[0] = payload[0]! & ~clearedFlags;
      actions.push({
        code: 'webp.vp8x.flags',
        message: 'cleared VP8X feature flags for the chunks that were removed',
      });
    }
    body.push(
      Uint8Array.from(chunk.fourcc, (c) => c.charCodeAt(0)),
      u32LE(payload.length),
      payload,
    );
    if ((payload.length & 1) === 1) body.push(Uint8Array.of(0));
  }

  const bodyBytes = concatBytes(body);
  const output = concatBytes([
    Uint8Array.from(RIFF, (c) => c.charCodeAt(0)),
    u32LE(bodyBytes.length),
    bodyBytes,
  ]);

  if (actions.length === 0) {
    actions.push({ code: 'webp.clean.noop', message: 'no metadata chunks to remove' });
  }
  return { output, actions };
}
