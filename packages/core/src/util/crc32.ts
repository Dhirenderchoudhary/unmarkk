/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320).
 *
 * Needed twice: PNG chunks carry one per chunk, and ZIP local/central headers
 * carry one per entry. Both use the same variant, so one 40-line table beats
 * pulling in a dependency for it.
 */

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `bytes`, optionally continuing from a previous value. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 over several chunks without concatenating them first. */
export function crc32Of(...chunks: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const bytes of chunks) {
    for (let i = 0; i < bytes.length; i += 1) {
      c = (TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
