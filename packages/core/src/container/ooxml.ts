/**
 * DOCX (Office Open XML) inspection and cleaning.
 *
 * A .docx is a ZIP. The document you can see lives in `word/`; everything that
 * describes *you* lives elsewhere:
 *
 *   docProps/core.xml    author, last-modified-by, created/modified timestamps,
 *                        revision number
 *   docProps/app.xml     the application that wrote it, your company name,
 *                        total editing time, template path
 *   docProps/custom.xml  arbitrary custom properties — a common provenance sink
 *   customXml/           arbitrary XML parts, another common provenance sink
 *
 * Note what is *not* scanned: `word/document.xml`. A document that discusses
 * Claude or mentions OpenAI in its body text is a document about those things,
 * not a document produced by them, and treating body prose as metadata would
 * produce a false positive on every article ever written about AI.
 *
 * When a part is removed, the references to it go too — `[Content_Types].xml`
 * overrides and `_rels` relationship entries. A DOCX with a dangling override
 * opens with a repair prompt in Word, which would make the clean worse than
 * useless.
 */

import type { Action, Finding, PrivacyFindings } from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';
import { AI_NAME_PATTERN, AI_VENDOR_PATTERN } from './vocab.js';
import { decodeText, encodeText } from '../util/text-codec.js';
import { readZip, writeZip, type ZipEntry } from '../util/zip.js';

/** Parts that describe the document rather than containing it. */
function isMetadataPart(name: string): boolean {
  return name.startsWith('docProps/') || name.startsWith('customXml/');
}

/** Elements in core.xml that name a person. */
const IDENTITY_ELEMENTS = ['dc:creator', 'cp:lastModifiedBy', 'dc:contributor', 'dc:publisher'];
/** Elements that pin the document to a moment. */
const TIMESTAMP_ELEMENTS = ['dcterms:created', 'dcterms:modified', 'cp:lastPrinted'];
/** Elements in app.xml that name a tool, an employer or a working pattern. */
const APP_ELEMENTS = [
  'Application',
  'AppVersion',
  'Company',
  'Manager',
  'Template',
  'TotalTime',
  'LastAuthor',
];

export interface OoxmlScan {
  readonly findings: readonly Finding[];
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly privacy: PrivacyFindings;
  readonly partCount: number;
}

/** Text content of the first `<tag>…</tag>`, or undefined. */
function elementText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${escapeTag(tag)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(tag)}\\s*>`, 'i').exec(
    xml,
  );
  return m?.[1];
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace an element's content with nothing, keeping the element itself. */
function blankElement(xml: string, tag: string): { xml: string; changed: boolean } {
  const pattern = new RegExp(
    `(<${escapeTag(tag)}\\b[^>]*>)([\\s\\S]*?)(</${escapeTag(tag)}\\s*>)`,
    'gi',
  );
  let changed = false;
  const out = xml.replace(pattern, (whole, open: string, inner: string, close: string) => {
    if (inner === '') return whole;
    changed = true;
    return `${open}${close}`;
  });
  return { xml: out, changed };
}

export async function inspectDocx(data: Uint8Array): Promise<OoxmlScan> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(data);
  } catch (error) {
    return {
      findings: [
        {
          code: 'docx.invalid',
          message: `not a readable DOCX: ${(error as Error).message}`,
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

  const customXmlParts = entries.filter((e) => e.name.startsWith('customXml/'));
  if (customXmlParts.length > 0) {
    findings.push({
      code: 'docx.customxml',
      message: `${customXmlParts.length} customXml part${customXmlParts.length === 1 ? '' : 's'} — arbitrary XML travelling with the document`,
      confidence: 'informational',
    });
  }

  for (const entry of entries) {
    if (!isMetadataPart(entry.name)) continue;
    const xml = decodeText(entry.data);

    if (/c2pa|contentcredential|jumbf/i.test(xml)) {
      hasC2pa = true;
      hasAiMetadata = true;
      findings.push({
        code: 'docx.part.c2pa',
        message: `${entry.name} references a C2PA manifest`,
        confidence: 'confirmed',
        at: entry.name,
      });
    }
    if (AI_VENDOR_PATTERN.test(xml) || AI_NAME_PATTERN.test(xml)) {
      hasAiMetadata = true;
      findings.push({
        code: 'docx.part.ai',
        message: `${entry.name} records AI provenance`,
        confidence: AI_VENDOR_PATTERN.test(xml) ? 'confirmed' : 'probable',
        at: entry.name,
      });
    }

    for (const tag of IDENTITY_ELEMENTS) {
      const value = elementText(xml, tag);
      if (value !== undefined && value.trim() !== '') {
        hasAuthorIdentity = true;
        findings.push({
          code: 'docx.identity',
          message: `${entry.name} <${tag}> names "${value.trim()}"`,
          confidence: 'confirmed',
          at: entry.name,
        });
      }
    }
    for (const tag of TIMESTAMP_ELEMENTS) {
      const value = elementText(xml, tag);
      if (value !== undefined && value.trim() !== '') {
        hasTimestamps = true;
      }
    }
    for (const tag of ['Application', 'Company', 'Manager', 'Template']) {
      const value = elementText(xml, tag);
      if (value !== undefined && value.trim() !== '') {
        hasDeviceIdentity = hasDeviceIdentity || tag === 'Application';
        if (tag === 'Company' || tag === 'Manager') hasAuthorIdentity = true;
        findings.push({
          code: 'docx.app-metadata',
          message: `${entry.name} <${tag}> is "${value.trim()}"`,
          confidence: 'confirmed',
          at: entry.name,
        });
      }
    }
  }

  if (hasTimestamps) {
    findings.push({
      code: 'docx.timestamps',
      message: 'document properties record creation and modification times',
      confidence: 'confirmed',
    });
  }

  return {
    findings,
    hasC2pa,
    hasAiMetadata,
    privacy: { hasLocation: false, hasDeviceIdentity, hasAuthorIdentity, hasTimestamps },
    partCount: entries.length,
  };
}

export interface OoxmlCleanResult {
  readonly output: Uint8Array;
  readonly actions: readonly Action[];
}

/** Strip identifying and provenance metadata, keeping the document intact. */
export async function cleanDocx(data: Uint8Array): Promise<OoxmlCleanResult> {
  const entries = await readZip(data);
  const actions: Action[] = [];
  const droppedParts = new Set<string>();
  const kept: ZipEntry[] = [];

  for (const entry of entries) {
    // customXml is arbitrary XML that no ordinary document needs and that
    // provenance tooling routinely writes into. It goes wholesale.
    if (entry.name.startsWith('customXml/')) {
      droppedParts.add(entry.name);
      continue;
    }

    if (entry.name === 'docProps/custom.xml') {
      droppedParts.add(entry.name);
      continue;
    }

    if (entry.name === 'docProps/core.xml' || entry.name === 'docProps/app.xml') {
      let xml = decodeText(entry.data);
      const blanked: string[] = [];

      for (const tag of [...IDENTITY_ELEMENTS, ...TIMESTAMP_ELEMENTS, ...APP_ELEMENTS]) {
        const result = blankElement(xml, tag);
        if (result.changed) {
          xml = result.xml;
          blanked.push(tag);
        }
      }
      // cp:revision counts how many times the file was saved, which is a
      // surprisingly good fingerprint of a working session.
      const revision = blankElement(xml, 'cp:revision');
      if (revision.changed) {
        xml = revision.xml;
        blanked.push('cp:revision');
      }

      if (blanked.length > 0) {
        actions.push({
          code: 'docx.blank.properties',
          message: `cleared ${entry.name} fields: ${blanked.join(', ')}`,
          count: blanked.length,
        });
      }
      kept.push({ ...entry, data: encodeText(xml) });
      continue;
    }

    kept.push(entry);
  }

  if (droppedParts.size > 0) {
    actions.push({
      code: 'docx.drop.parts',
      message: `removed ${droppedParts.size} metadata part${droppedParts.size === 1 ? '' : 's'}: ${[...droppedParts].join(', ')}`,
      count: droppedParts.size,
    });
  }

  // Every reference to a removed part must go too, or Word offers to "repair"
  // the file on open — which is a worse outcome than leaving the metadata in.
  const repaired = kept.map((entry) => {
    if (entry.name === '[Content_Types].xml') {
      const xml = decodeText(entry.data);
      const cleaned = dropOverrides(xml, droppedParts);
      if (cleaned !== xml) {
        actions.push({
          code: 'docx.fix.content-types',
          message: 'removed [Content_Types].xml overrides for the parts that were dropped',
        });
        return { ...entry, data: encodeText(cleaned) };
      }
      return entry;
    }
    if (entry.name.endsWith('.rels')) {
      const xml = decodeText(entry.data);
      const cleaned = dropRelationships(xml, droppedParts);
      if (cleaned !== xml) {
        actions.push({
          code: 'docx.fix.rels',
          message: `removed dangling relationships in ${entry.name}`,
        });
        return { ...entry, data: encodeText(cleaned) };
      }
      return entry;
    }
    return entry;
  });

  if (actions.length === 0) {
    actions.push({ code: 'docx.clean.noop', message: 'no metadata parts or properties to remove' });
  }

  return { output: await writeZip(repaired), actions };
}

/** Remove `<Override PartName="/dropped/part"/>` entries. */
function dropOverrides(xml: string, dropped: ReadonlySet<string>): string {
  return xml.replace(/<Override\b[^>]*PartName="\/([^"]*)"[^>]*\/>/gi, (whole, part: string) =>
    dropped.has(part) || part.startsWith('customXml/') ? '' : whole,
  );
}

/** Remove `<Relationship Target="…"/>` entries pointing at removed parts. */
function dropRelationships(xml: string, dropped: ReadonlySet<string>): string {
  return xml.replace(/<Relationship\b[^>]*\/>/gi, (whole) => {
    const target = /Target="([^"]*)"/i.exec(whole)?.[1];
    if (target === undefined) return whole;
    const normalised = target.replace(/^\/+/, '').replace(/^\.\.\//, '');
    if (normalised.startsWith('customXml/')) return '';
    for (const part of dropped) {
      if (part === normalised || part.endsWith(`/${normalised}`)) return '';
    }
    return whole;
  });
}
