/** Small byte helpers shared by the binary parsers. No dependencies. */

/** True when `haystack` starts with `needle`. */
export function startsWith(haystack: Uint8Array, needle: readonly number[] | Uint8Array): boolean {
  if (needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}

/** True when the bytes at `offset` equal `needle`. */
export function matchesAt(
  haystack: Uint8Array,
  offset: number,
  needle: readonly number[] | Uint8Array,
): boolean {
  if (offset < 0 || offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

/** Index of `needle` in `haystack` at or after `from`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const limit = haystack.length - needle.length;
  const first = needle[0]!;
  for (let i = Math.max(0, from); i <= limit; i += 1) {
    if (haystack[i] !== first) continue;
    let hit = true;
    for (let k = 1; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Read a big-endian uint32. */
export function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/** Read a big-endian uint16. */
export function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 8) | bytes[offset + 1]!) >>> 0;
}

/** Read a little-endian uint32. */
export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/** Read a little-endian uint16. */
export function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8)) >>> 0;
}

/** Write a big-endian uint32. */
export function u32BE(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/** Write a big-endian uint16. */
export function u16BE(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

/** Write a little-endian uint32. */
export function u32LE(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

/** Write a little-endian uint16. */
export function u16LE(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}
