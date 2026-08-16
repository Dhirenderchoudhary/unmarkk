/**
 * PDF inspection and cleaning, with no external tools.
 *
 * This is the part of the project that most needed rewriting rather than
 * translating. The usual approach — run `exiftool -all=` over the file — does
 * not do what people think it does. exiftool edits PDFs *incrementally*: it
 * appends an update that frees the Info object and drops `/Info` from the
 * trailer, but the original metadata bytes stay in the file verbatim, and
 * exiftool itself will happily put them back with `-PDF-update:all=`. A file
 * cleaned that way still contains your name; it just stops advertising it.
 *
 * So this module rebuilds the document instead. Every object is parsed out,
 * the ones carrying metadata are dropped, the survivors are re-emitted with a
 * fresh cross-reference table, and everything that was not written out is
 * simply not in the output file. There is nothing left to recover.
 *
 * What gets removed:
 *
 *   - the document information dictionary (`/Info`): title, author, subject,
 *     keywords, creator, producer, creation and modification dates
 *   - every XMP metadata stream (`/Type /Metadata`), at document and object
 *     level, which is where C2PA and most provenance claims live
 *   - `/PieceInfo` application data, where design tools cache editing state
 *   - object streams and cross-reference streams, which are re-expanded so
 *     nothing hides inside a compressed container
 *
 * What never gets touched: page content, fonts, images, annotations, form
 * fields, the structure tree. The document renders identically.
 *
 * Limits are honest rather than silent. Encrypted PDFs are refused instead of
 * mangled, and any structure the parser cannot account for results in a
 * `degraded` result that says so.
 */

import type { Action, Finding, PrivacyFindings } from '../types.js';
import { concatBytes, indexOfBytes } from '../util/bytes.js';
import { inflateZlib } from '../util/zip.js';
import { ascii } from '../util/text-codec.js';

/** Byte-exact string view: one char per byte. Round-trips through `fromLatin1`. */
function toLatin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

function fromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export interface PdfObject {
  readonly number: number;
  readonly generation: number;
  /** The dictionary (or other direct object) preceding any stream, as text. */
  readonly dict: string;
  /** Raw stream payload, when the object has one. */
  readonly stream?: Uint8Array;
}

export interface PdfDocument {
  readonly version: string;
  readonly objects: Map<number, PdfObject>;
  /** Merged trailer dictionary text, from `trailer` or an `/Type /XRef` dict. */
  readonly trailer: string;
  readonly encrypted: boolean;
  readonly problems: readonly string[];
}

const OBJ_HEADER = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;

/** True when the bytes start with a PDF header. */
export function isPdf(data: Uint8Array): boolean {
  return indexOfBytes(data.subarray(0, 1024), ascii('%PDF-')) >= 0;
}

/**
 * Find where an object's body ends.
 *
 * `endobj` can legitimately appear inside a stream's binary payload, so a
 * stream is skipped using its `/Length` when that is a direct integer, and by
 * searching for `endstream` when it is an indirect reference — which is the
 * only option available before the object graph exists.
 */
function findObjectEnd(text: string, bodyStart: number): { end: number; streamAt: number } {
  const streamMatch = /\bstream\r?\n?/.exec(text.slice(bodyStart, bodyStart + 65536));
  const endobjNaive = text.indexOf('endobj', bodyStart);

  if (streamMatch === null || (endobjNaive >= 0 && bodyStart + streamMatch.index > endobjNaive)) {
    return { end: endobjNaive < 0 ? text.length : endobjNaive, streamAt: -1 };
  }

  const dictText = text.slice(bodyStart, bodyStart + streamMatch.index);
  const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictText);
  const dataStart = bodyStart + streamMatch.index + streamMatch[0].length;

  if (lengthMatch !== null) {
    const declared = Number(lengthMatch[1]);
    const after = text.slice(dataStart + declared, dataStart + declared + 32);
    if (/^\s*endstream/.test(after)) {
      const endobj = text.indexOf('endobj', dataStart + declared);
      return { end: endobj < 0 ? text.length : endobj, streamAt: dataStart };
    }
  }

  const endstream = text.indexOf('endstream', dataStart);
  if (endstream < 0) return { end: text.length, streamAt: dataStart };
  const endobj = text.indexOf('endobj', endstream);
  return { end: endobj < 0 ? text.length : endobj, streamAt: dataStart };
}

/** Extract stream payload bounds for an object body. */
function sliceStream(text: string, streamAt: number, bodyEnd: number): string {
  const endstream = text.lastIndexOf('endstream', bodyEnd);
  if (endstream < streamAt) return '';
  let end = endstream;
  // Trim the EOL that precedes `endstream`; it is a delimiter, not data.
  if (text[end - 1] === '\n') end -= 1;
  if (text[end - 1] === '\r') end -= 1;
  return text.slice(streamAt, end);
}

/** Parse a PDF into its indirect objects. */
export function parsePdf(data: Uint8Array): PdfDocument {
  const text = toLatin1(data);
  const problems: string[] = [];

  const versionMatch = /%PDF-(\d\.\d)/.exec(text.slice(0, 1024));
  const version = versionMatch?.[1] ?? '1.7';

  const objects = new Map<number, PdfObject>();
  OBJ_HEADER.lastIndex = 0;

  for (let m = OBJ_HEADER.exec(text); m !== null; m = OBJ_HEADER.exec(text)) {
    const number = Number(m[1]);
    const generation = Number(m[2]);
    const bodyStart = m.index + m[0].length;
    const { end, streamAt } = findObjectEnd(text, bodyStart);

    const dict = streamAt < 0 ? text.slice(bodyStart, end) : text.slice(bodyStart, streamAt);
    const streamText = streamAt < 0 ? undefined : sliceStream(text, streamAt, end);

    // Later definitions win: that is what an incremental update means, and it
    // is exactly how a viewer resolves the same object number appearing twice.
    objects.set(number, {
      number,
      generation,
      dict: dict.replace(/\bstream\r?\n?$/, ''),
      ...(streamText === undefined ? {} : { stream: fromLatin1(streamText) }),
    });

    OBJ_HEADER.lastIndex = Math.max(end, bodyStart + 1);
  }

  // The trailer may be a `trailer <<…>>` block or, for cross-reference stream
  // files, the dictionary of the /Type /XRef object itself.
  let trailer = '';
  const trailerMatches = [...text.matchAll(/trailer\b([\s\S]{0,4096}?)(?:startxref|%%EOF)/g)];
  if (trailerMatches.length > 0) {
    trailer = trailerMatches.map((t) => t[1] ?? '').join('\n');
  } else {
    for (const obj of objects.values()) {
      if (/\/Type\s*\/XRef\b/.test(obj.dict)) trailer += `\n${obj.dict}`;
    }
  }

  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(trailer);
  if (objects.size === 0) problems.push('no indirect objects found');

  return { version, objects, trailer, encrypted, problems };
}

/** Resolve `/Key N 0 R` in a dictionary to the object number. */
function refIn(dict: string, key: string): number | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`).exec(dict);
  return m === undefined || m === null ? undefined : Number(m[1]);
}

const INFO_FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'] as const;
const DATE_FIELDS = ['CreationDate', 'ModDate'] as const;

export interface PdfScan {
  readonly findings: readonly Finding[];
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly privacy: PrivacyFindings;
  readonly encrypted: boolean;
}

/** Decode a PDF literal or hex string for display. */
function decodePdfString(raw: string): string {
  if (raw.startsWith('<') && raw.endsWith('>')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    // UTF-16BE strings start with a byte-order mark.
    if (out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
      let decoded = '';
      for (let i = 2; i + 1 < out.length; i += 2) {
        decoded += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
      }
      return decoded;
    }
    return out;
  }
  return raw.replace(/^\(|\)$/g, '').replace(/\\([()\\])/g, '$1');
}

/** Inspect a PDF for provenance and identifying metadata. */
export async function inspectPdf(data: Uint8Array): Promise<PdfScan> {
  const doc = parsePdf(data);
  const findings: Finding[] = [];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let hasAuthorIdentity = false;
  let hasTimestamps = false;
  let hasDeviceIdentity = false;
  let hasLocation = false;

  if (doc.encrypted) {
    findings.push({
      code: 'pdf.encrypted',
      message: 'the document is encrypted; its metadata cannot be read without the password',
      confidence: 'informational',
    });
  }
  for (const problem of doc.problems) {
    findings.push({ code: 'pdf.parse', message: problem, confidence: 'informational' });
  }

  const infoRef = refIn(doc.trailer, 'Info');
  const info = infoRef === undefined ? undefined : doc.objects.get(infoRef);
  if (info !== undefined) {
    for (const field of INFO_FIELDS) {
      const m = new RegExp(`/${field}\\s*(\\([^)]*\\)|<[0-9A-Fa-f\\s]*>)`).exec(info.dict);
      if (m === null) continue;
      const value = decodePdfString(m[1]!).trim();
      if (value === '') continue;

      if (field === 'Author') hasAuthorIdentity = true;
      if (field === 'Creator' || field === 'Producer') hasDeviceIdentity = true;

      findings.push({
        code: `pdf.info.${field.toLowerCase()}`,
        message: `document information /${field} is "${value}"`,
        confidence: 'confirmed',
        at: `object ${infoRef}`,
      });
    }
    for (const field of DATE_FIELDS) {
      if (new RegExp(`/${field}\\s*\\(`).test(info.dict)) {
        hasTimestamps = true;
        findings.push({
          code: `pdf.info.${field.toLowerCase()}`,
          message: `document information records /${field}`,
          confidence: 'confirmed',
          at: `object ${infoRef}`,
        });
      }
    }
  }

  for (const obj of doc.objects.values()) {
    if (/\/Type\s*\/Metadata\b/.test(obj.dict)) {
      const xmp = await readStreamText(obj);
      findings.push({
        code: 'pdf.metadata.xmp',
        message: `object ${obj.number} is an XMP metadata stream`,
        confidence: 'confirmed',
        at: `object ${obj.number}`,
      });
      if (/c2pa|contentcredential|jumbf/i.test(xmp)) {
        hasC2pa = true;
        hasAiMetadata = true;
        findings.push({
          code: 'pdf.metadata.c2pa',
          message: `object ${obj.number} carries a C2PA content-credentials claim`,
          confidence: 'confirmed',
          at: `object ${obj.number}`,
        });
      }
      if (/digitalSourceType|trainedAlgorithmicMedia/i.test(xmp)) {
        hasAiMetadata = true;
        findings.push({
          code: 'pdf.metadata.provenance',
          message: `object ${obj.number} declares a digital source type`,
          confidence: 'confirmed',
          at: `object ${obj.number}`,
        });
      }
      if (/<dc:creator|<xmp:CreatorTool|<photoshop:/i.test(xmp)) hasAuthorIdentity = true;
      if (/<xmp:CreateDate|<xmp:ModifyDate/i.test(xmp)) hasTimestamps = true;
      if (/<exif:GPS/i.test(xmp)) hasLocation = true;
    }

    if (/\/PieceInfo\b/.test(obj.dict)) {
      findings.push({
        code: 'pdf.pieceinfo',
        message: `object ${obj.number} has /PieceInfo application data (editing state cached by design tools)`,
        confidence: 'informational',
        at: `object ${obj.number}`,
      });
    }
  }

  return {
    findings,
    hasC2pa,
    hasAiMetadata,
    privacy: { hasLocation, hasDeviceIdentity, hasAuthorIdentity, hasTimestamps },
    encrypted: doc.encrypted,
  };
}

/** Decompress a stream for text inspection, best effort. */
async function readStreamText(obj: PdfObject): Promise<string> {
  if (obj.stream === undefined) return '';
  if (!/\/Filter/.test(obj.dict)) return toLatin1(obj.stream);
  if (!/\/FlateDecode\b/.test(obj.dict)) return '';
  try {
    return toLatin1(await inflateZlib(obj.stream));
  } catch {
    return '';
  }
}

export interface PdfCleanResult {
  readonly output: Uint8Array;
  readonly actions: readonly Action[];
  readonly degraded: boolean;
}

/**
 * Rebuild the PDF without metadata objects.
 *
 * Object numbers are preserved. Renumbering would mean rewriting every
 * reference in every object, including references inside compressed content
 * streams — far more ways to break a document than keeping the gaps and
 * marking them free in the cross-reference table, which is exactly what free
 * entries are for.
 */
export async function cleanPdf(data: Uint8Array): Promise<PdfCleanResult> {
  const doc = parsePdf(data);
  const actions: Action[] = [];

  if (doc.encrypted) {
    throw new Error(
      'refusing to rewrite an encrypted PDF: its objects cannot be re-serialised without the password',
    );
  }
  if (doc.objects.size === 0) {
    throw new Error(
      'no PDF objects found; the file may be damaged or use an unsupported structure',
    );
  }

  const objects = new Map(doc.objects);
  let degraded = doc.problems.length > 0;

  // Expand object streams so nothing stays hidden inside a compressed
  // container. Anything left inside one would survive the clean untouched.
  const objStmNumbers: number[] = [];
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
    objStmNumbers.push(obj.number);
    try {
      const expanded = await expandObjectStream(obj);
      for (const inner of expanded) {
        if (!objects.has(inner.number)) objects.set(inner.number, inner);
      }
      actions.push({
        code: 'pdf.objstm.expand',
        message: `expanded object stream ${obj.number} into ${expanded.length} top-level objects`,
        count: expanded.length,
      });
    } catch (error) {
      degraded = true;
      actions.push({
        code: 'pdf.objstm.failed',
        message: `could not expand object stream ${obj.number} (${(error as Error).message}); objects inside it are dropped`,
      });
    }
  }

  const dropped = new Set<number>(objStmNumbers);

  const infoRef = refIn(doc.trailer, 'Info');
  if (infoRef !== undefined && objects.has(infoRef)) {
    dropped.add(infoRef);
    actions.push({
      code: 'pdf.drop.info',
      message: `removed the document information dictionary (object ${infoRef}): title, author, creator, producer and dates`,
    });
  }

  let metadataStreams = 0;
  let xrefStreams = 0;
  for (const obj of objects.values()) {
    if (dropped.has(obj.number)) continue;
    if (/\/Type\s*\/Metadata\b/.test(obj.dict)) {
      dropped.add(obj.number);
      metadataStreams += 1;
    } else if (/\/Type\s*\/XRef\b/.test(obj.dict)) {
      dropped.add(obj.number);
      xrefStreams += 1;
    }
  }
  if (metadataStreams > 0) {
    actions.push({
      code: 'pdf.drop.metadata',
      message: `removed ${metadataStreams} XMP metadata stream${metadataStreams === 1 ? '' : 's'}`,
      count: metadataStreams,
    });
  }
  if (xrefStreams > 0) {
    actions.push({
      code: 'pdf.drop.xref-stream',
      message: `replaced ${xrefStreams} cross-reference stream${xrefStreams === 1 ? '' : 's'} with a plain cross-reference table`,
      count: xrefStreams,
    });
  }

  // Strip dangling references and application scratch data from survivors.
  let editedDicts = 0;
  for (const [number, obj] of objects) {
    if (dropped.has(number)) continue;
    let dict = obj.dict;
    const before = dict;

    dict = dict.replace(/\/Metadata\s+\d+\s+\d+\s+R\s*/g, '');
    dict = dict.replace(/\/PieceInfo\s*<<[\s\S]*?>>\s*/g, '');
    dict = dict.replace(/\/PieceInfo\s+\d+\s+\d+\s+R\s*/g, '');
    dict = dict.replace(/\/LastModified\s*\([^)]*\)\s*/g, '');
    // /AF associates external files with the document; C2PA rides on it.
    dict = dict.replace(/\/AF\s*\[[^\]]*\]\s*/g, '');

    if (dict !== before) {
      objects.set(number, { ...obj, dict });
      editedDicts += 1;
    }
  }
  if (editedDicts > 0) {
    actions.push({
      code: 'pdf.strip.references',
      message: `removed /Metadata, /PieceInfo, /AF and /LastModified entries from ${editedDicts} object${editedDicts === 1 ? '' : 's'}`,
      count: editedDicts,
    });
  }

  const rootRef = refIn(doc.trailer, 'Root') ?? findCatalog(objects);
  if (rootRef === undefined) {
    throw new Error('no document catalog found; refusing to write a PDF without a root');
  }

  const output = serialise(doc.version, objects, dropped, rootRef);

  actions.push({
    code: 'pdf.rebuild',
    message:
      'rebuilt the file from its object graph with a fresh cross-reference table — removed objects are absent from the output, not merely unreferenced',
  });

  return { output, actions, degraded };
}

/** Locate a `/Type /Catalog` object when the trailer does not name one. */
function findCatalog(objects: ReadonlyMap<number, PdfObject>): number | undefined {
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(obj.dict)) return obj.number;
  }
  return undefined;
}

/** Pull the objects out of a `/Type /ObjStm` compressed object stream. */
async function expandObjectStream(obj: PdfObject): Promise<PdfObject[]> {
  if (obj.stream === undefined) throw new Error('object stream has no payload');
  if (/\/Predictor\b/.test(obj.dict)) throw new Error('predictor filters are not supported');
  if (!/\/FlateDecode\b/.test(obj.dict)) throw new Error('unsupported filter');

  const raw = toLatin1(await inflateZlib(obj.stream));
  const count = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? '0');
  const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? '0');
  if (count === 0 || first === 0) throw new Error('object stream is missing /N or /First');

  const header = raw.slice(0, first).trim().split(/\s+/).map(Number);
  const out: PdfObject[] = [];

  for (let i = 0; i < count; i += 1) {
    const number = header[i * 2];
    const offset = header[i * 2 + 1];
    if (number === undefined || offset === undefined) break;
    const start = first + offset;
    const nextOffset = header[i * 2 + 3];
    const end = nextOffset === undefined ? raw.length : first + nextOffset;
    out.push({ number, generation: 0, dict: raw.slice(start, end) });
  }
  return out;
}

/** Write objects out with a classic cross-reference table. */
function serialise(
  version: string,
  objects: ReadonlyMap<number, PdfObject>,
  dropped: ReadonlySet<number>,
  rootRef: number,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  // A binary comment on line 2 tells transfer tools the file is not text.
  push(fromLatin1(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`));

  const numbers = [...objects.keys()].filter((n) => !dropped.has(n)).sort((a, b) => a - b);
  const maxNumber = numbers.length === 0 ? 0 : numbers[numbers.length - 1]!;
  const offsets = new Map<number, number>();

  for (const number of numbers) {
    const obj = objects.get(number)!;
    offsets.set(number, offset);

    // Trim both ends, not just the tail. The parser captures everything after
    // `N G obj`, which includes the newline that followed it — so emitting
    // `obj\n${dict}` reintroduced that newline every time. Cleaning the same
    // file twice grew it by one byte per object and never converged.
    const dict = obj.dict.trim();
    if (obj.stream === undefined) {
      push(fromLatin1(`${number} 0 obj\n${dict}\nendobj\n`));
    } else {
      // /Length must match the payload we are about to write, and an indirect
      // /Length would point at an object that may no longer exist.
      const withLength = dict.replace(
        /\/Length\s+(?:\d+|\d+\s+\d+\s+R)/,
        `/Length ${obj.stream.length}`,
      );
      const fixed = /\/Length/.test(withLength)
        ? withLength
        : withLength.replace(/>>\s*$/, `/Length ${obj.stream.length}>>`);
      push(fromLatin1(`${number} 0 obj\n${fixed}\nstream\n`));
      push(obj.stream);
      push(fromLatin1('\nendstream\nendobj\n'));
    }
  }

  const xrefOffset = offset;
  const rows: string[] = ['xref', `0 ${maxNumber + 1}`, '0000000000 65535 f '];
  for (let n = 1; n <= maxNumber; n += 1) {
    const at = offsets.get(n);
    rows.push(
      at === undefined ? '0000000000 65535 f ' : `${at.toString().padStart(10, '0')} 00000 n `,
    );
  }
  push(fromLatin1(`${rows.join('\n')}\n`));
  push(
    fromLatin1(
      `trailer\n<< /Size ${maxNumber + 1} /Root ${rootRef} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  );

  return concatBytes(chunks);
}
