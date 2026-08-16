/**
 * Minimal TIFF/EXIF directory walker.
 *
 * EXIF is binary TIFF: tags are numeric, so the string scan that works on XMP
 * finds nothing in it. Without this walker a photo straight off a phone would
 * be reported as having "no identifying metadata" while carrying the exact
 * coordinates of the room it was taken in. That gap is the whole reason this
 * file exists.
 *
 * It reads structure only — it never decodes values, so a malformed offset can
 * mislead the report but cannot be used to read out of bounds. Every read is
 * range-checked, directory counts are capped, and pointer chasing is depth
 * limited, because the input is by definition untrusted.
 */

import { readU16BE, readU16LE, readU32BE, readU32LE } from '../util/bytes.js';
import type { PrivacyFindings } from '../types.js';

const MAX_ENTRIES_PER_IFD = 512;
const MAX_IFD_CHAIN = 8;

/** IFD0 / IFD1 tags worth naming. */
const TIFF_TAGS: ReadonlyMap<number, string> = new Map([
  [0x010f, 'Make'],
  [0x0110, 'Model'],
  [0x0131, 'Software'],
  [0x0132, 'DateTime'],
  [0x013b, 'Artist'],
  [0x013c, 'HostComputer'],
  [0x8298, 'Copyright'],
  [0x02bc, 'XMP'],
  [0x83bb, 'IPTC'],
  [0x8769, 'ExifIFDPointer'],
  [0x8825, 'GPSInfoIFDPointer'],
]);

/** Exif sub-IFD tags worth naming. */
const EXIF_TAGS: ReadonlyMap<number, string> = new Map([
  [0x9003, 'DateTimeOriginal'],
  [0x9004, 'DateTimeDigitized'],
  [0x927c, 'MakerNote'],
  [0x9286, 'UserComment'],
  [0xa005, 'InteroperabilityIFDPointer'],
  [0xa430, 'CameraOwnerName'],
  [0xa431, 'BodySerialNumber'],
  [0xa433, 'LensMake'],
  [0xa434, 'LensModel'],
  [0xa435, 'LensSerialNumber'],
  [0xc62f, 'CameraSerialNumber'],
]);

const LOCATION_TAGS = new Set([0x8825]);
const DEVICE_TAGS = new Set([
  0x010f, 0x0110, 0x013c, 0x927c, 0xa431, 0xa433, 0xa434, 0xa435, 0xc62f,
]);
const AUTHOR_TAGS = new Set([0x013b, 0x8298, 0xa430]);
const TIMESTAMP_TAGS = new Set([0x0132, 0x9003, 0x9004]);

export interface ExifScan {
  /** True when the bytes parsed as a TIFF header at all. */
  readonly parsed: boolean;
  /** Names of tags that were present, for reporting. */
  readonly tags: readonly string[];
  readonly privacy: PrivacyFindings;
}

const EMPTY: ExifScan = Object.freeze({
  parsed: false,
  tags: Object.freeze([]),
  privacy: Object.freeze({
    hasLocation: false,
    hasDeviceIdentity: false,
    hasAuthorIdentity: false,
    hasTimestamps: false,
  }),
});

/**
 * Walk an EXIF/TIFF block and report which identifying tags it contains.
 *
 * `data` should start at the TIFF header (`II*\0` or `MM\0*`). For JPEG APP1
 * that means the bytes after the `Exif\0\0` introducer.
 */
export function scanExif(data: Uint8Array): ExifScan {
  if (data.length < 8) return EMPTY;

  const b0 = data[0]!;
  const b1 = data[1]!;
  const little = b0 === 0x49 && b1 === 0x49;
  const big = b0 === 0x4d && b1 === 0x4d;
  if (!little && !big) return EMPTY;

  const u16 = (o: number): number => (little ? readU16LE(data, o) : readU16BE(data, o));
  const u32 = (o: number): number => (little ? readU32LE(data, o) : readU32BE(data, o));

  if (u16(2) !== 0x002a) return EMPTY;

  const tags = new Set<string>();
  let hasLocation = false;
  let hasDeviceIdentity = false;
  let hasAuthorIdentity = false;
  let hasTimestamps = false;

  const seen = new Set<number>();

  const walk = (offset: number, names: ReadonlyMap<number, string>, depth: number): void => {
    if (depth > MAX_IFD_CHAIN) return;
    if (offset < 8 || offset + 2 > data.length) return;
    if (seen.has(offset)) return; // a self-referential IFD chain is a valid file to write
    seen.add(offset);

    const count = Math.min(u16(offset), MAX_ENTRIES_PER_IFD);
    const entriesEnd = offset + 2 + count * 12;
    if (entriesEnd > data.length) return;

    for (let i = 0; i < count; i += 1) {
      const at = offset + 2 + i * 12;
      const tag = u16(at);
      const value = u32(at + 8);

      const name = names.get(tag);
      if (name !== undefined) tags.add(name);

      if (LOCATION_TAGS.has(tag)) hasLocation = true;
      if (DEVICE_TAGS.has(tag)) hasDeviceIdentity = true;
      if (AUTHOR_TAGS.has(tag)) hasAuthorIdentity = true;
      if (TIMESTAMP_TAGS.has(tag)) hasTimestamps = true;

      if (tag === 0x8769) walk(value, EXIF_TAGS, depth + 1);
      if (tag === 0x8825) {
        hasLocation = true;
        // The GPS IFD's own tags are all location by definition; presence of
        // the directory is the signal, so there is nothing to gain by walking in.
        tags.add('GPSInfo');
      }
      if (tag === 0xa005) walk(value, EXIF_TAGS, depth + 1);
    }

    // IFD1 (the embedded thumbnail) carries its own copy of most tags, and a
    // thumbnail that still shows the unredacted original is a real leak.
    const nextOffset = entriesEnd + 4 <= data.length ? u32(entriesEnd) : 0;
    if (nextOffset !== 0) walk(nextOffset, names, depth + 1);
  };

  walk(u32(4), TIFF_TAGS, 0);

  return {
    parsed: true,
    tags: [...tags].sort(),
    privacy: { hasLocation, hasDeviceIdentity, hasAuthorIdentity, hasTimestamps },
  };
}
