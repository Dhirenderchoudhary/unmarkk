/**
 * PNG chunk inspection and stripping.
 *
 * A PNG is a signature followed by length-prefixed chunks. Everything that
 * identifies you lives in ancillary chunks — `eXIf` (a whole TIFF block with
 * GPS in it), `tEXt`/`iTXt`/`zTXt` (author, comments, software, and the usual
 * place generators write "made with X"), `tIME` (when you last saved it), and
 * the private chunks C2PA uses for its manifests.
 *
 * None of those are needed to render the image, which is why removing them is
 * lossless: the pixels are in `IDAT` and are never touched.
 */

import { concatBytes, matchesAt, readU32BE, startsWith, u32BE } from '../util/bytes.js';
import { crc32Of } from '../util/crc32.js';
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
import type { Action, Finding, PrivacyFindings } from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Chunks required to render the image correctly. Never dropped. */
const CRITICAL_CHUNKS: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP', // colour profile: dropping it visibly shifts colours
  'sBIT',
  'bKGD',
  'hIST',
  'pHYs',
  'sPLT',
  'acTL', // APNG control
  'fcTL',
  'fdAT',
]);

/** Chunks that are pure metadata: always removed by a full strip. */
const METADATA_CHUNKS: ReadonlySet<string> = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export interface PngChunk {
  readonly type: string;
  readonly payload: Uint8Array;
  /** Offset of the chunk's length field. */
  readonly offset: number;
  readonly crcValid: boolean;
}

export interface PngParse {
  readonly chunks: readonly PngChunk[];
  /** Structural problems found while walking, e.g. truncation. */
  readonly problems: readonly string[];
}

/** Walk the chunk list. Stops cleanly at the first structural problem. */
export function parsePng(data: Uint8Array): PngParse {
  const chunks: PngChunk[] = [];
  const problems: string[] = [];

  if (!startsWith(data, PNG_SIGNATURE)) {
    return { chunks, problems: ['not a PNG (bad signature)'] };
  }

  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= data.length) {
    const length = readU32BE(data, pos);
    const typeBytes = data.subarray(pos + 4, pos + 8);
    const type = String.fromCharCode(...typeBytes);
    const payloadStart = pos + 8;
    const payloadEnd = payloadStart + length;

    if (payloadEnd + 4 > data.length) {
      problems.push(`truncated chunk ${type} at offset ${pos}`);
      break;
    }

    const payload = data.subarray(payloadStart, payloadEnd);
    const storedCrc = readU32BE(data, payloadEnd);
    chunks.push({
      type,
      payload,
      offset: pos,
      crcValid: crc32Of(typeBytes, payload) === storedCrc,
    });

    pos = payloadEnd + 4;
    if (type === 'IEND') break;
  }

  // A file that stops mid-header exits the loop without tripping the
  // truncation check above, so the missing terminator is what catches it.
  if (problems.length === 0 && chunks[chunks.length - 1]?.type !== 'IEND') {
    problems.push('no IEND chunk: the file is truncated');
  }

  return { chunks, problems };
}

/** A private chunk type that looks like a C2PA container. */
function isC2paChunk(type: string): boolean {
  return type === 'caBX' || type === 'juMB' || type === 'jumb' || type.startsWith('c2');
}

export interface ImageScan {
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly findings: readonly Finding[];
  readonly privacy: PrivacyFindings;
  readonly notes: readonly string[];
}

/** Text-chunk keywords that name a person or a moment. */
const IDENTIFYING_KEYWORDS: readonly string[] = [
  'author',
  'copyright',
  'creation time',
  'comment',
  'source',
  'software',
  'disclaimer',
  'warning',
];

/**
 * The keyword of a `tEXt`, `zTXt` or `iTXt` chunk.
 *
 * All three start with a Latin-1 keyword terminated by a NUL byte, and the
 * separator matters: splitting on whitespace instead reports
 * `Author\0Jane Smith` as the keyword "author.jane", which is both wrong and
 * leaks the value into a field that is meant to name the field.
 *
 * Returned lowercased, since every caller matches case-insensitively.
 */
function textChunkKeyword(payload: Uint8Array): string {
  const end = payload.indexOf(0);
  // The spec caps keywords at 79 bytes; a chunk with no NUL is malformed, so
  // read no further than a valid keyword could possibly extend.
  const limit = end === -1 ? Math.min(payload.length, 79) : end;
  let keyword = '';
  for (let i = 0; i < limit; i += 1) keyword += String.fromCharCode(payload[i]!);
  return keyword.toLowerCase();
}

export function inspectPng(data: Uint8Array): ImageScan {
  const { chunks, problems } = parsePng(data);
  const findings: Finding[] = [];
  const notes: string[] = [...problems];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let privacy = NO_PRIVACY_FINDINGS;

  for (const chunk of chunks) {
    if (!chunk.crcValid && chunk.type !== 'IEND') {
      notes.push(`chunk ${chunk.type} has a bad CRC; the file may be damaged or hand-edited`);
    }

    if (isC2paChunk(chunk.type)) {
      hasC2pa = true;
      hasAiMetadata = true;
      findings.push({
        code: 'png.chunk.c2pa',
        message: `private chunk ${chunk.type} holds a C2PA/JUMBF container`,
        confidence: 'confirmed',
        at: `offset ${chunk.offset}`,
      });
      continue;
    }

    if (chunk.type === 'eXIf') {
      const exif = scanExif(chunk.payload);
      privacy = mergePrivacy(privacy, exif.privacy);
      findings.push({
        code: 'png.chunk.exif',
        message:
          exif.tags.length > 0
            ? `eXIf block with ${exif.tags.length} identifying tags: ${exif.tags.join(', ')}`
            : 'eXIf block present',
        confidence: 'confirmed',
        at: `offset ${chunk.offset}`,
      });
      continue;
    }

    if (chunk.type === 'tIME') {
      privacy = mergePrivacy(privacy, { ...NO_PRIVACY_FINDINGS, hasTimestamps: true });
      findings.push({
        code: 'png.chunk.time',
        message: 'tIME chunk records when the file was last modified',
        confidence: 'confirmed',
        at: `offset ${chunk.offset}`,
      });
      continue;
    }

    if (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') {
      const view = asciiView(chunk.payload);
      const keyword = textChunkKeyword(chunk.payload);

      const c2paHits = findIn(view, C2PA_MARKERS);
      const aiHits = findIn(view, AI_MARKERS);
      if (c2paHits.length > 0) hasC2pa = true;
      if (aiHits.length > 0) hasAiMetadata = true;

      if (aiHits.length > 0 || c2paHits.length > 0) {
        const hits = [...new Set([...c2paHits, ...aiHits])];
        findings.push({
          code: 'png.chunk.text.ai',
          message: `${chunk.type} chunk contains provenance markers: ${hits.slice(0, 8).join(', ')}`,
          confidence: markerConfidence(hits),
          at: `offset ${chunk.offset}`,
        });
      }

      privacy = mergePrivacy(privacy, scanPrivacy(view));
      if (IDENTIFYING_KEYWORDS.some((k) => keyword.includes(k))) {
        privacy = mergePrivacy(privacy, {
          ...NO_PRIVACY_FINDINGS,
          hasAuthorIdentity: keyword.includes('author') || keyword.includes('copyright'),
          hasTimestamps: keyword.includes('creation time'),
        });
        findings.push({
          code: 'png.chunk.text.identity',
          message: `${chunk.type} chunk keyword "${keyword}" carries identifying text`,
          confidence: 'confirmed',
          at: `offset ${chunk.offset}`,
        });
      }
    }
  }

  return { hasC2pa, hasAiMetadata, findings, privacy, notes };
}

export interface StripResult {
  readonly output: Uint8Array;
  readonly actions: readonly Action[];
}

export interface StripPngOptions {
  /** Remove every metadata chunk, not only provenance-looking ones. */
  readonly stripAll?: boolean;
}

/**
 * Rebuild the PNG without metadata chunks.
 *
 * Chunks are re-emitted byte for byte with a freshly computed CRC, so the
 * output is a well-formed PNG even when the input had damaged checksums.
 */
export function stripPng(data: Uint8Array, options: StripPngOptions = {}): StripResult {
  const stripAll = options.stripAll ?? true;
  const { chunks, problems } = parsePng(data);
  if (problems.length > 0 && chunks.length === 0) {
    throw new Error(problems[0]);
  }

  const actions: Action[] = [];
  const dropped = new Map<string, number>();
  const out: Uint8Array[] = [PNG_SIGNATURE];

  for (const chunk of chunks) {
    let drop = false;

    if (isC2paChunk(chunk.type)) {
      drop = true;
    } else if (METADATA_CHUNKS.has(chunk.type)) {
      drop =
        stripAll || findIn(asciiView(chunk.payload), [...C2PA_MARKERS, ...AI_MARKERS]).length > 0;
    } else if (!CRITICAL_CHUNKS.has(chunk.type)) {
      // Unknown ancillary chunk. Drop it only when it carries a marker, so a
      // legitimate application chunk survives a normal clean.
      drop = findIn(asciiView(chunk.payload), C2PA_MARKERS).length > 0;
    }

    if (drop) {
      dropped.set(chunk.type, (dropped.get(chunk.type) ?? 0) + 1);
      continue;
    }

    const typeBytes = Uint8Array.from(chunk.type, (c) => c.charCodeAt(0));
    out.push(
      u32BE(chunk.payload.length),
      typeBytes,
      chunk.payload,
      u32BE(crc32Of(typeBytes, chunk.payload)),
    );
  }

  for (const [type, count] of dropped) {
    actions.push({
      code: `png.drop.${type.toLowerCase()}`,
      message: `removed ${count} ${type} chunk${count === 1 ? '' : 's'}`,
      count,
    });
  }
  if (actions.length === 0) {
    actions.push({ code: 'png.clean.noop', message: 'no metadata chunks to remove' });
  }

  return { output: concatBytes(out), actions };
}

/** True when the bytes begin with a PNG signature. */
export function isPng(data: Uint8Array): boolean {
  return matchesAt(data, 0, PNG_SIGNATURE);
}
