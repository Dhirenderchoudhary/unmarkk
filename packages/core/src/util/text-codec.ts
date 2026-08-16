/**
 * Lossless UTF-8 <-> string conversion.
 *
 * `TextDecoder` replaces every byte it cannot decode with U+FFFD, which is
 * fine for display and catastrophic for a tool that writes the file back:
 * cleaning a Latin-1 or Shift-JIS document would silently corrupt every
 * non-ASCII byte in it. The fix is to escape rather than replace: an
 * undecodable byte `0xNN` becomes the lone low surrogate `U+DCNN`, which
 * encodes back to exactly `0xNN`.
 *
 * The round trip is byte-exact for *any* input, valid UTF-8 or not.
 */

const SURROGATE_ESCAPE_BASE = 0xdc00;

/** Decode UTF-8, escaping undecodable bytes into the U+DC80–U+DCFF range. */
export function decodeText(bytes: Uint8Array): string {
  const out: string[] = [];
  // Chunked to keep String.fromCharCode.apply-style growth predictable and to
  // avoid one enormous array for large files.
  let chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length > 0) {
      out.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  };
  const emitCode = (cp: number): void => {
    if (cp <= 0xffff) {
      chunk.push(cp);
    } else {
      const v = cp - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    if (chunk.length >= 4096) flush();
  };
  const escapeByte = (b: number): void => emitCode(SURROGATE_ESCAPE_BASE | b);

  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i]!;

    if (b0 < 0x80) {
      emitCode(b0);
      i += 1;
      continue;
    }

    const width = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 0;
    if (width === 0 || i + width > n) {
      escapeByte(b0);
      i += 1;
      continue;
    }

    // Every continuation byte must be 10xxxxxx, else the lead byte alone is
    // bad and we retry from the next one rather than swallowing good bytes.
    let cp = b0 & (0xff >> (width + 1));
    let ok = true;
    for (let k = 1; k < width; k += 1) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }

    const minimum = width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    const isSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (!ok || cp < minimum || cp > 0x10ffff || isSurrogate) {
      // Overlong forms, CESU-8 surrogate halves and out-of-range values are
      // all rejected: they are the classic way to smuggle bytes past a filter.
      escapeByte(b0);
      i += 1;
      continue;
    }

    emitCode(cp);
    i += width;
  }
  flush();
  return out.join('');
}

/** Encode to UTF-8, turning U+DC80–U+DCFF escapes back into raw bytes. */
export function encodeText(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const cu = text.charCodeAt(i);

    if (cu >= 0xdc80 && cu <= 0xdcff) {
      out.push(cu & 0xff);
      continue;
    }

    let cp = cu;
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (cu - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i += 1;
      } else {
        // Lone high surrogate: nothing valid to emit, so use the replacement
        // character rather than producing invalid UTF-8.
        cp = 0xfffd;
      }
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decode bytes as ASCII for marker matching. Non-ASCII becomes `.`. */
export function decodeAsciiLoose(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return s;
}

/** Encode an ASCII literal to bytes. Throws on non-ASCII input. */
export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) throw new RangeError(`not ASCII: ${JSON.stringify(text)}`);
    out[i] = c;
  }
  return out;
}
