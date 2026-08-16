/**
 * Deciding what a pile of bytes is.
 *
 * Two separate questions, easy to confuse:
 *
 *   `sniffBinary` — "would treating this as text destroy it?" Pointing a text
 *   cleaner at a .docx would decode the compressed bytes, report whatever
 *   codepoints fell out of them (noise that tracks the compression, not the
 *   content), and then write the mangled result back over the file. The answer
 *   here is deliberately conservative, because text in encodings other than
 *   UTF-8 must keep working: undecodable bytes alone are never proof.
 *
 *   `classify` — "which pipeline owns this?" Extension first, magic bytes
 *   second, text as the fallback.
 */

import type { Kind } from './types.js';
import { startsWith } from './util/bytes.js';
import { listZipNames } from './util/zip.js';
import { detectImageFormat } from './image/index.js';

/** How much of the input to sniff. */
export const SNIFF_BYTES = 8192;

interface Magic {
  readonly bytes: readonly number[];
  readonly label: string;
}

const MAGIC_NUMBERS: readonly Magic[] = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'a ZIP container (DOCX, ODT, XLSX, PPTX, EPUB, JAR)' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], label: 'an empty ZIP container' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], label: 'a spanned ZIP container' },
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], label: 'a PDF' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: 'a PNG image' },
  { bytes: [0xff, 0xd8, 0xff], label: 'a JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], label: 'a GIF image' },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], label: 'a GIF image' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], label: 'a TIFF image' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], label: 'a TIFF image' },
  { bytes: [0x52, 0x49, 0x46, 0x46], label: 'a RIFF container (WebP, WAV, AVI)' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], label: 'an Ogg media file' },
  { bytes: [0x1f, 0x8b], label: 'a gzip archive' },
  { bytes: [0x42, 0x5a, 0x68], label: 'a bzip2 archive' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: 'an xz archive' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: 'a 7-Zip archive' },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], label: 'a RAR archive' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'an ELF binary' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'a Java class or Mach-O fat binary' },
  {
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    label: 'a legacy Office document (.doc, .xls, .ppt)',
  },
  {
    bytes: [
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33,
      0x00,
    ],
    label: 'a SQLite database',
  },
  { bytes: [0x38, 0x42, 0x50, 0x53], label: 'a Photoshop document' },
  { bytes: [0x77, 0x4f, 0x46, 0x46], label: 'a WOFF font' },
  { bytes: [0x77, 0x4f, 0x46, 0x32], label: 'a WOFF2 font' },
  { bytes: [0x4f, 0x54, 0x54, 0x4f], label: 'an OpenType font' },
];

/** Control bytes that appear in ordinary text: tab, LF, VT, FF, CR, ESC. */
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);
/**
 * Real text runs at roughly zero percent control bytes. Compressed and
 * executable data runs far above this, so the threshold does not need to be
 * finely tuned to separate them.
 */
const CONTROL_RATIO_LIMIT = 0.05;

/** Describe why the bytes are not plausibly text, or `null` when they are. */
export function sniffBinary(data: Uint8Array): string | null {
  if (data.length === 0) return null;

  for (const magic of MAGIC_NUMBERS) {
    if (startsWith(data, magic.bytes)) return magic.label;
  }

  const head = data.subarray(0, SNIFF_BYTES);
  let controls = 0;
  for (let i = 0; i < head.length; i += 1) {
    const b = head[i]!;
    if (b === 0x00) return 'binary data (contains NUL bytes)';
    if (b < 0x20 && !ALLOWED_CONTROLS.has(b)) controls += 1;
  }
  if (controls / head.length > CONTROL_RATIO_LIMIT) {
    return 'binary data (dense in control bytes)';
  }
  return null;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const CONTAINER_EXTENSIONS = new Set([
  '.svg',
  '.pdf',
  '.docx',
  '.odt',
  '.html',
  '.htm',
  '.md',
  '.markdown',
  '.mdx',
]);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.text',
  '.css',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.rb',
  '.sh',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.csv',
  '.tsv',
  '.srt',
  '.vtt',
]);

function extensionOf(filename: string | undefined): string {
  if (filename === undefined) return '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Decide which pipeline owns these bytes.
 *
 * The extension wins when it names a format we know, because a `.md` file that
 * happens to start with `<html>` is still Markdown to its author. Otherwise the
 * magic bytes decide. Unrecognised bytes fall back to text — callers that must
 * not mangle unknown binaries check `sniffBinary` first.
 */
export async function classify(data: Uint8Array, filename?: string): Promise<Kind> {
  const ext = extensionOf(filename);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CONTAINER_EXTENSIONS.has(ext)) return 'container';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  if (detectImageFormat(data) !== 'unknown') return 'image';

  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'container';
  if (startsWith(data, [0x50, 0x4b])) {
    const names = await listZipNames(data);
    if (names.includes('word/document.xml')) return 'container';
    if (names.includes('content.xml') && names.includes('meta.xml')) return 'container';
  }

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(data.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  if (head.includes('<svg')) return 'container';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'container';

  return 'text';
}
