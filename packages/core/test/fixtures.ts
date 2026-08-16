/**
 * Builders for synthetic test files.
 *
 * Real files are not checked in: a repository about metadata should not ship
 * binaries whose metadata nobody has read. Every fixture here is constructed
 * byte by byte in code, so what is being tested is visible in the test.
 */

import { crc32Of } from '../src/util/crc32.js';
import { concatBytes, u16BE, u16LE, u32BE, u32LE } from '../src/util/bytes.js';
import { encodeText } from '../src/util/text-codec.js';
import { writeZip, type ZipEntry } from '../src/util/zip.js';

const fourcc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

// --- PNG -----------------------------------------------------------------

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A single PNG chunk with a correct CRC. */
export function pngChunk(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const typeBytes = fourcc(type);
  return concatBytes([
    u32BE(payload.length),
    typeBytes,
    payload,
    u32BE(crc32Of(typeBytes, payload)),
  ]);
}

/** A 1x1 PNG with whatever extra chunks you pass, inserted before IDAT. */
export function makePng(
  extra: ReadonlyArray<{ type: string; payload: Uint8Array }> = [],
): Uint8Array {
  const ihdr = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0);
  // A valid zlib stream for one fully transparent pixel.
  const idat = Uint8Array.of(0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01);
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...extra.map((c) => pngChunk(c.type, c.payload)),
    pngChunk('IDAT', idat),
    pngChunk('IEND'),
  ]);
}

/** A `tEXt` payload: NUL-separated keyword and value. */
export function textChunk(keyword: string, value: string): Uint8Array {
  return concatBytes([encodeText(keyword), Uint8Array.of(0), encodeText(value)]);
}

// --- EXIF ----------------------------------------------------------------

export interface ExifTag {
  readonly tag: number;
  /** Only the raw 4-byte value slot matters for structural detection. */
  readonly value?: number;
}

/**
 * A minimal little-endian TIFF block containing the given IFD0 tags.
 *
 * Values are not real strings — the scanner reports which tags exist, and
 * pointing every one at offset 0 is enough to exercise that.
 */
export function makeExif(tags: readonly ExifTag[]): Uint8Array {
  const header = concatBytes([
    fourcc('II'),
    u16LE(0x2a),
    u32LE(8), // IFD0 begins right after the header
  ]);
  const entries = tags.map((t) =>
    concatBytes([
      u16LE(t.tag),
      u16LE(3), // SHORT
      u32LE(1),
      u32LE(t.value ?? 0),
    ]),
  );
  return concatBytes([header, u16LE(tags.length), ...entries, u32LE(0)]);
}

export const EXIF_TAG = {
  Make: 0x010f,
  Model: 0x0110,
  DateTime: 0x0132,
  Artist: 0x013b,
  Copyright: 0x8298,
  GpsInfo: 0x8825,
  ExifIfd: 0x8769,
} as const;

// --- JPEG ----------------------------------------------------------------

export interface JpegSegmentSpec {
  readonly marker: number;
  readonly payload: Uint8Array;
}

/** A JPEG with the given segments, a stub scan and an EOI. */
export function makeJpeg(segments: readonly JpegSegmentSpec[] = []): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  for (const segment of segments) {
    parts.push(
      Uint8Array.of(0xff, segment.marker),
      u16BE(segment.payload.length + 2),
      segment.payload,
    );
  }
  // A start-of-frame so the file is structurally plausible, then a scan.
  parts.push(Uint8Array.of(0xff, 0xc0), u16BE(11), Uint8Array.of(8, 0, 1, 0, 1, 1, 1, 0x11, 0));
  parts.push(Uint8Array.of(0xff, 0xda), u16BE(8), Uint8Array.of(1, 1, 0, 0, 0x3f, 0));
  parts.push(Uint8Array.of(0x00, 0x11, 0x22, 0x33));
  parts.push(Uint8Array.of(0xff, 0xd9));
  return concatBytes(parts);
}

/** An APP1 payload carrying an Exif block. */
export function app1Exif(exif: Uint8Array): Uint8Array {
  return concatBytes([encodeText('Exif'), Uint8Array.of(0, 0), exif]);
}

/** An APP1 payload carrying an XMP packet. */
export function app1Xmp(xml: string): Uint8Array {
  return concatBytes([
    encodeText('http://ns.adobe.com/xap/1.0/'),
    Uint8Array.of(0),
    encodeText(xml),
  ]);
}

// --- WebP ----------------------------------------------------------------

export interface WebpChunkSpec {
  readonly fourcc: string;
  readonly payload: Uint8Array;
}

/** An extended-format WebP with a VP8X header and the given chunks. */
export function makeWebp(chunks: readonly WebpChunkSpec[] = []): Uint8Array {
  let flags = 0;
  for (const chunk of chunks) {
    if (chunk.fourcc === 'ICCP') flags |= 0x20;
    if (chunk.fourcc === 'EXIF') flags |= 0x08;
    if (chunk.fourcc === 'XMP ') flags |= 0x04;
  }

  const all: WebpChunkSpec[] = [
    { fourcc: 'VP8X', payload: Uint8Array.of(flags, 0, 0, 0, 0, 0, 0, 0, 0, 0) },
    { fourcc: 'VP8 ', payload: Uint8Array.of(1, 2, 3, 4) },
    ...chunks,
  ];

  const body: Uint8Array[] = [fourcc('WEBP')];
  for (const chunk of all) {
    body.push(fourcc(chunk.fourcc), u32LE(chunk.payload.length), chunk.payload);
    if ((chunk.payload.length & 1) === 1) body.push(Uint8Array.of(0));
  }
  const bodyBytes = concatBytes(body);
  return concatBytes([fourcc('RIFF'), u32LE(bodyBytes.length), bodyBytes]);
}

// --- Office documents ----------------------------------------------------

function entry(name: string, text: string, method = 8): ZipEntry {
  return {
    name,
    data: encodeText(text),
    method,
    dosTime: 0,
    dosDate: 33,
    externalAttributes: 0,
  };
}

export interface DocxOptions {
  readonly creator?: string;
  readonly lastModifiedBy?: string;
  readonly company?: string;
  readonly application?: string;
  readonly body?: string;
  readonly withCustomXml?: boolean;
  readonly withCustomProps?: boolean;
}

export async function makeDocx(options: DocxOptions = {}): Promise<Uint8Array> {
  const {
    creator = 'Dhirender Choudhary',
    lastModifiedBy = 'Dhirender Choudhary',
    company = 'Acme Holdings',
    application = 'Microsoft Office Word',
    body = 'A memo that discusses OpenAI and Claude at length.',
    withCustomXml = true,
    withCustomProps = true,
  } = options;

  const entries: ZipEntry[] = [
    entry(
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="doc"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="core"/>` +
        (withCustomProps
          ? `<Override PartName="/docProps/custom.xml" ContentType="custom"/>`
          : '') +
        (withCustomXml ? `<Override PartName="/customXml/item1.xml" ContentType="cx"/>` : '') +
        `</Types>`,
    ),
    entry(
      '_rels/.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="t/document" Target="word/document.xml"/>` +
        (withCustomProps
          ? `<Relationship Id="rId3" Type="t/custom-properties" Target="docProps/custom.xml"/>`
          : '') +
        `</Relationships>`,
    ),
    entry(
      'word/document.xml',
      `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    entry(
      'docProps/core.xml',
      `<?xml version="1.0"?><cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t">` +
        `<dc:title>Q3 Strategy</dc:title><dc:creator>${creator}</dc:creator>` +
        `<cp:lastModifiedBy>${lastModifiedBy}</cp:lastModifiedBy><cp:revision>17</cp:revision>` +
        `<dcterms:created>2026-01-05T09:12:00Z</dcterms:created>` +
        `<dcterms:modified>2026-01-09T18:44:00Z</dcterms:modified></cp:coreProperties>`,
    ),
    entry(
      'docProps/app.xml',
      `<?xml version="1.0"?><Properties><Application>${application}</Application>` +
        `<Company>${company}</Company><Manager>A Manager</Manager><TotalTime>487</TotalTime></Properties>`,
    ),
  ];

  if (withCustomProps) {
    entries.push(
      entry(
        'docProps/custom.xml',
        `<?xml version="1.0"?><Properties><property name="generator"><vt:lpwstr>ChatGPT</vt:lpwstr></property></Properties>`,
      ),
    );
  }
  if (withCustomXml) {
    entries.push(
      entry(
        'customXml/item1.xml',
        `<?xml version="1.0"?><provenance digitalSourceType="trainedAlgorithmicMedia"/>`,
      ),
    );
  }

  return writeZip(entries);
}

export interface OdtOptions {
  readonly creator?: string;
  readonly generator?: string;
}

export async function makeOdt(options: OdtOptions = {}): Promise<Uint8Array> {
  const { creator = 'Dhirender Choudhary', generator = 'LibreOffice/7.4' } = options;

  return writeZip([
    // ODT requires this exact first entry, stored uncompressed.
    entry('mimetype', 'application/vnd.oasis.opendocument.text', 0),
    entry(
      'meta.xml',
      `<?xml version="1.0"?><office:document-meta xmlns:office="o" xmlns:meta="m" xmlns:dc="d">` +
        `<office:meta><meta:generator>${generator}</meta:generator>` +
        `<dc:creator>${creator}</dc:creator><meta:initial-creator>${creator}</meta:initial-creator>` +
        `<meta:creation-date>2026-01-05T09:12:00</meta:creation-date>` +
        `<dc:date>2026-01-09T18:44:00</dc:date>` +
        `<meta:editing-cycles>23</meta:editing-cycles>` +
        `<meta:editing-duration>PT4H12M</meta:editing-duration>` +
        `<meta:user-defined meta:name="Project">Falcon</meta:user-defined>` +
        `</office:meta></office:document-meta>`,
    ),
    entry(
      'content.xml',
      `<?xml version="1.0"?><office:document-content><office:body><text:p>Body text.</text:p></office:body></office:document-content>`,
    ),
    entry('META-INF/manifest.xml', `<?xml version="1.0"?><manifest:manifest/>`),
  ]);
}

// --- PDF -----------------------------------------------------------------

export interface PdfOptions {
  readonly author?: string;
  readonly title?: string;
  readonly producer?: string;
  readonly body?: string;
  readonly withXmp?: boolean;
}

/** A structurally valid, classic-xref PDF with an Info dictionary. */
export function makePdf(options: PdfOptions = {}): Uint8Array {
  const {
    author = 'Dhirender Choudhary',
    title = 'Quarterly Plan',
    producer = 'SomeTool 1.0',
    body = 'Hello world',
    withXmp = true,
  } = options;

  const content = `BT /F1 12 Tf 20 100 Td (${body}) Tj ET`;
  const xmp = `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><dc:creator>${author}</dc:creator><xmp:CreateDate>2026-01-05</xmp:CreateDate></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R${withXmp ? ' /Metadata 5 0 R' : ''} >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  // Object 5 always exists so the numbering and the xref stay consistent; it
  // is only a metadata stream when the caller asked for one.
  objects.push(
    withXmp
      ? `5 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream\nendobj\n`
      : `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
  objects.push(
    `6 0 obj\n<< /Title (${title}) /Author (${author}) /Producer (${producer}) ` +
      `/CreationDate (D:20260105091200Z) /ModDate (D:20260109184400Z) >>\nendobj\n`,
  );

  const header = `%PDF-1.4\n`;
  let offset = header.length;
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }

  const rows = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const at of offsets) rows.push(`${String(at).padStart(10, '0')} 00000 n `);

  const trailer =
    `${rows.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`;

  return encodeText(header + objects.join('') + trailer);
}
