/**
 * A ZIP reader and writer built on the platform's own compression streams.
 *
 * DOCX and ODT are ZIP archives of XML, so editing them means unpacking and
 * repacking. `CompressionStream`/`DecompressionStream` ship in Node 18+ and
 * every current browser, which is what lets this package stay dependency-free
 * and run unchanged on both — the same guarantee the privacy story rests on.
 *
 * Two properties matter for round-tripping office documents:
 *
 *   - Entry order is preserved. ODT is only valid if `mimetype` is the first
 *     entry, stored uncompressed, so order is not cosmetic.
 *   - The original compression method is preserved per entry, for the same
 *     reason.
 *
 * Everything is bounds-checked and budgeted: an archive is attacker-controlled
 * input, and a 40 KB file that expands to 4 GB is a classic denial of service.
 */

import { concatBytes, readU16LE, readU32LE, u16LE, u32LE } from './bytes.js';
import { crc32 } from './crc32.js';
import { decodeText, encodeText } from './text-codec.js';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Refuse archives that expand past this. Office documents are far smaller. */
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** Refuse absurd entry counts before allocating anything per entry. */
const MAX_ENTRIES = 20000;

export interface ZipEntry {
  readonly name: string;
  /** Decompressed contents. */
  readonly data: Uint8Array;
  /** 0 = stored, 8 = deflate. Preserved so repacking matches the original. */
  readonly method: number;
  /** MS-DOS time/date, preserved verbatim to avoid inventing timestamps. */
  readonly dosTime: number;
  readonly dosDate: number;
  /** External attributes from the central directory (unix mode, dir flag). */
  readonly externalAttributes: number;
}

async function throughStream(data: Uint8Array, transform: TransformStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const response = new Response(source.pipeThrough(transform));
  return new Uint8Array(await response.arrayBuffer());
}

/** Raw DEFLATE decompression (no zlib wrapper), as ZIP stores it. */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new DecompressionStream('deflate-raw'));
}

/** Raw DEFLATE compression. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new CompressionStream('deflate-raw'));
}

/**
 * zlib-wrapped DEFLATE decompression, as PDF's `/FlateDecode` uses.
 *
 * Falls back to raw DEFLATE: some producers omit the two-byte zlib header, and
 * a reader that rejects those files is a reader that fails on real documents.
 */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await throughStream(data, new DecompressionStream('deflate'));
  } catch {
    return inflateRaw(data);
  }
}

/** zlib-wrapped DEFLATE compression. */
export async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  return throughStream(data, new CompressionStream('deflate'));
}

/** True when the bytes look like any ZIP-family archive. */
export function isZip(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const sig = readU32LE(data, 0);
  return sig === LOCAL_HEADER_SIG || sig === 0x06054b50 || sig === 0x08074b50;
}

/** Locate the end-of-central-directory record, scanning back over the comment. */
function findEocd(data: Uint8Array): number {
  const minStart = Math.max(0, data.length - 0xffff - 22);
  for (let i = data.length - 22; i >= minStart; i -= 1) {
    if (readU32LE(data, i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Read every entry, decompressing as we go. */
export async function readZip(data: Uint8Array): Promise<ZipEntry[]> {
  const eocd = findEocd(data);
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  if (eocd >= 20 && readU32LE(data, eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error('ZIP64 archives are not supported');
  }

  const total = readU16LE(data, eocd + 10);
  if (total > MAX_ENTRIES) throw new Error(`ZIP has too many entries (${total})`);
  let offset = readU32LE(data, eocd + 16);

  const entries: ZipEntry[] = [];
  let budget = 0;

  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > data.length || readU32LE(data, offset) !== CENTRAL_HEADER_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }

    const method = readU16LE(data, offset + 10);
    const dosTime = readU16LE(data, offset + 12);
    const dosDate = readU16LE(data, offset + 14);
    const compressedSize = readU32LE(data, offset + 20);
    const uncompressedSize = readU32LE(data, offset + 24);
    const nameLength = readU16LE(data, offset + 28);
    const extraLength = readU16LE(data, offset + 30);
    const commentLength = readU16LE(data, offset + 32);
    const externalAttributes = readU32LE(data, offset + 38);
    const localOffset = readU32LE(data, offset + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('ZIP64 entry sizes are not supported');
    }

    budget += uncompressedSize;
    if (budget > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP expands past the ${MAX_UNCOMPRESSED_BYTES} byte cap; refusing to unpack it`,
      );
    }

    const name = decodeText(data.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > data.length || readU32LE(data, localOffset) !== LOCAL_HEADER_SIG) {
      throw new Error(`corrupt local header for ${name}`);
    }
    // The local header's own name/extra lengths may differ from the central
    // directory's; the local ones describe where the data actually starts.
    const localNameLength = readU16LE(data, localOffset + 26);
    const localExtraLength = readU16LE(data, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > data.length) throw new Error(`entry ${name} runs past the end of the archive`);

    const raw = data.subarray(dataStart, dataEnd);
    let contents: Uint8Array;
    if (method === METHOD_STORED) {
      contents = raw;
    } else if (method === METHOD_DEFLATE) {
      contents = await inflateRaw(raw);
    } else {
      throw new Error(`entry ${name} uses unsupported compression method ${method}`);
    }

    entries.push({ name, data: contents, method, dosTime, dosDate, externalAttributes });
  }

  return entries;
}

/** Repack entries into a new archive, preserving order and per-entry method. */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encodeText(entry.name);
    const checksum = crc32(entry.data);
    const stored = entry.method === METHOD_STORED;
    const payload = stored ? entry.data : await deflateRaw(entry.data);
    const method = stored ? METHOD_STORED : METHOD_DEFLATE;

    const local = concatBytes([
      u32LE(LOCAL_HEADER_SIG),
      u16LE(20), // version needed
      u16LE(0), // flags: no data descriptor, sizes are known up front
      u16LE(method),
      u16LE(entry.dosTime),
      u16LE(entry.dosDate),
      u32LE(checksum),
      u32LE(payload.length),
      u32LE(entry.data.length),
      u16LE(nameBytes.length),
      u16LE(0), // extra field length
      nameBytes,
      payload,
    ]);
    locals.push(local);

    centrals.push(
      concatBytes([
        u32LE(CENTRAL_HEADER_SIG),
        u16LE(20), // version made by
        u16LE(20), // version needed
        u16LE(0),
        u16LE(method),
        u16LE(entry.dosTime),
        u16LE(entry.dosDate),
        u32LE(checksum),
        u32LE(payload.length),
        u32LE(entry.data.length),
        u16LE(nameBytes.length),
        u16LE(0), // extra
        u16LE(0), // comment
        u16LE(0), // disk number
        u16LE(0), // internal attributes
        u32LE(entry.externalAttributes),
        u32LE(offset),
        nameBytes,
      ]),
    );

    offset += local.length;
  }

  const centralBytes = concatBytes(centrals);
  const eocd = concatBytes([
    u32LE(EOCD_SIG),
    u16LE(0),
    u16LE(0),
    u16LE(entries.length),
    u16LE(entries.length),
    u32LE(centralBytes.length),
    u32LE(offset),
    u16LE(0),
  ]);

  return concatBytes([...locals, centralBytes, eocd]);
}

/** Names present in an archive, without decompressing anything. */
export async function listZipNames(data: Uint8Array): Promise<string[]> {
  const eocd = findEocd(data);
  if (eocd < 0) return [];
  const total = Math.min(readU16LE(data, eocd + 10), MAX_ENTRIES);
  let offset = readU32LE(data, eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > data.length || readU32LE(data, offset) !== CENTRAL_HEADER_SIG) break;
    const nameLength = readU16LE(data, offset + 28);
    const extraLength = readU16LE(data, offset + 30);
    const commentLength = readU16LE(data, offset + 32);
    names.push(decodeText(data.subarray(offset + 46, offset + 46 + nameLength)));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
