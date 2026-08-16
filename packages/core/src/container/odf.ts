/**
 * ODT (OpenDocument Text) inspection and cleaning.
 *
 * Like DOCX this is a ZIP, but the metadata is concentrated in one place:
 * `meta.xml`, whose `<office:meta>` element holds the creator, the initial
 * creator, creation and modification dates, the generating application, the
 * number of times the file has been saved and the total time spent editing it.
 *
 * Editing-cycles and editing-duration deserve a specific mention: together they
 * describe your working session, which is rarely something anyone intends to
 * publish alongside a document.
 *
 * Repacking preserves entry order and compression method, which ODT requires —
 * `mimetype` must be the first entry and must be stored uncompressed, or the
 * result is not a valid OpenDocument file.
 */

import type { Action, Finding, PrivacyFindings } from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';
import { AI_NAME_PATTERN, AI_VENDOR_PATTERN } from './vocab.js';
import { decodeText, encodeText } from '../util/text-codec.js';
import { readZip, writeZip, type ZipEntry } from '../util/zip.js';

const OFFICE_META = /(<office:meta\b[^>]*>)([\s\S]*?)(<\/office:meta\s*>)/i;
const SELF_CLOSING_META = /<office:meta\b[^>]*\/>/i;

/** Elements inside `<office:meta>` and what each one gives away. */
const META_ELEMENTS: ReadonlyArray<{
  readonly tag: string;
  readonly what: string;
  readonly category: 'author' | 'timestamp' | 'device' | 'provenance';
}> = [
  { tag: 'dc:creator', what: 'the last person to save the file', category: 'author' },
  { tag: 'meta:initial-creator', what: 'the person who created the file', category: 'author' },
  { tag: 'dc:date', what: 'the last modification time', category: 'timestamp' },
  { tag: 'meta:creation-date', what: 'the creation time', category: 'timestamp' },
  { tag: 'meta:print-date', what: 'when the file was last printed', category: 'timestamp' },
  { tag: 'meta:printed-by', what: 'who last printed the file', category: 'author' },
  { tag: 'meta:generator', what: 'the application that wrote the file', category: 'device' },
  {
    tag: 'meta:editing-cycles',
    what: 'how many times the file has been saved',
    category: 'device',
  },
  { tag: 'meta:editing-duration', what: 'total time spent editing', category: 'device' },
];

function elementText(xml: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}\\s*>`, 'i').exec(xml)?.[1];
}

export interface OdfScan {
  readonly findings: readonly Finding[];
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly privacy: PrivacyFindings;
  readonly partCount: number;
}

export async function inspectOdt(data: Uint8Array): Promise<OdfScan> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(data);
  } catch (error) {
    return {
      findings: [
        {
          code: 'odt.invalid',
          message: `not a readable ODT: ${(error as Error).message}`,
          confidence: 'informational',
        },
      ],
      hasC2pa: false,
      hasAiMetadata: false,
      privacy: NO_PRIVACY_FINDINGS,
      partCount: 0,
    };
  }

  const findings: Finding[] = [];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let hasAuthorIdentity = false;
  let hasTimestamps = false;
  let hasDeviceIdentity = false;

  const meta = entries.find((e) => e.name === 'meta.xml');
  if (meta !== undefined) {
    const xml = decodeText(meta.data);

    for (const { tag, what, category } of META_ELEMENTS) {
      const value = elementText(xml, tag);
      if (value === undefined || value.trim() === '') continue;

      if (category === 'author') hasAuthorIdentity = true;
      if (category === 'timestamp') hasTimestamps = true;
      if (category === 'device') hasDeviceIdentity = true;

      findings.push({
        code: `odt.meta.${tag.replace(':', '.')}`,
        message: `<${tag}> records ${what}: "${value.trim()}"`,
        confidence: 'confirmed',
        at: 'meta.xml',
      });

      if (tag === 'meta:generator' && AI_VENDOR_PATTERN.test(value)) {
        hasAiMetadata = true;
      }
    }

    const userDefined = [...xml.matchAll(/<meta:user-defined\b[^>]*meta:name="([^"]*)"/gi)];
    for (const m of userDefined) {
      findings.push({
        code: 'odt.meta.user-defined',
        message: `custom property "${m[1]}" travels with the document`,
        confidence: 'informational',
        at: 'meta.xml',
      });
      if (AI_NAME_PATTERN.test(m[1] ?? '')) hasAiMetadata = true;
    }

    if (/c2pa|contentcredential|jumbf/i.test(xml)) {
      hasC2pa = true;
      hasAiMetadata = true;
      findings.push({
        code: 'odt.meta.c2pa',
        message: 'meta.xml references a C2PA manifest',
        confidence: 'confirmed',
        at: 'meta.xml',
      });
    }
  }

  return {
    findings,
    hasC2pa,
    hasAiMetadata,
    privacy: { hasLocation: false, hasDeviceIdentity, hasAuthorIdentity, hasTimestamps },
    partCount: entries.length,
  };
}

export interface OdfCleanResult {
  readonly output: Uint8Array;
  readonly actions: readonly Action[];
}

/** Empty the `<office:meta>` element and drop provenance-bearing extra parts. */
export async function cleanOdt(data: Uint8Array): Promise<OdfCleanResult> {
  const entries = await readZip(data);
  const actions: Action[] = [];

  const cleaned = entries.map((entry): ZipEntry => {
    if (entry.name !== 'meta.xml') return entry;

    const xml = decodeText(entry.data);
    if (SELF_CLOSING_META.test(xml)) {
      actions.push({ code: 'odt.meta.empty', message: 'meta.xml was already empty' });
      return entry;
    }

    const match = OFFICE_META.exec(xml);
    if (match === null) {
      actions.push({
        code: 'odt.meta.unrecognised',
        message: 'meta.xml has no <office:meta> element; left unchanged',
      });
      return entry;
    }

    const removed = [...(match[2] ?? '').matchAll(/<(\/?)([\w:-]+)/g)]
      .filter((m) => m[1] === '')
      .map((m) => m[2]!);
    const unique = [...new Set(removed)];

    // Emptying the element rather than deleting it keeps meta.xml valid
    // against the OpenDocument schema, which requires office:meta to exist.
    const out = xml.replace(OFFICE_META, `${match[1]}${match[3]}`);

    actions.push({
      code: 'odt.meta.cleared',
      message:
        unique.length > 0
          ? `emptied <office:meta>, removing ${unique.join(', ')}`
          : 'emptied <office:meta>',
      count: unique.length,
    });
    return { ...entry, data: encodeText(out) };
  });

  if (actions.length === 0) {
    actions.push({ code: 'odt.clean.noop', message: 'no meta.xml to clean' });
  }

  return { output: await writeZip(cleaned), actions };
}
