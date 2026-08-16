/**
 * SVG metadata inspection and cleaning.
 *
 * SVG is XML, and every editor that touches it leaves something behind:
 * Inkscape writes `sodipodi:docname` (your file path) and `inkscape:version`,
 * Illustrator embeds an XMP packet with your name and the save time, and
 * `<metadata>` blocks hold RDF that can include anything.
 *
 * Only wrapper elements and editor attributes are removed. Drawing content —
 * paths, shapes, defs, styles — is never touched, so the rendered image is
 * identical before and after.
 */

import type { Action, Finding } from '../types.js';
import { AI_NAME_PATTERN, AI_VENDOR_PATTERN } from './vocab.js';

const METADATA_BLOCK = /<metadata\b[^>]*>[\s\S]*?<\/metadata\s*>/gi;
const XMP_PACKET = /<x:xmpmeta\b[^>]*>[\s\S]*?<\/x:xmpmeta\s*>/gi;
const XPACKET = /<\?xpacket\b[\s\S]*?\?>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
/** Editor bookkeeping attributes. `sodipodi:docname` leaks a local file path. */
const EDITOR_ATTRS =
  /\s(?:inkscape:version|sodipodi:docname|inkscape:export-filename|illustrator:\w+|generator)\s*=\s*"[^"]*"/gi;

export interface SvgScan {
  readonly findings: readonly Finding[];
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly hasIdentity: boolean;
}

export function inspectSvg(text: string): SvgScan {
  const findings: Finding[] = [];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let hasIdentity = false;

  const metadataBlocks = [...text.matchAll(METADATA_BLOCK)];
  if (metadataBlocks.length > 0) {
    findings.push({
      code: 'svg.metadata.block',
      message: `${metadataBlocks.length} <metadata> block${metadataBlocks.length === 1 ? '' : 's'} present`,
      confidence: 'confirmed',
    });
    for (const [block] of metadataBlocks) {
      if (AI_NAME_PATTERN.test(block) || AI_VENDOR_PATTERN.test(block)) hasAiMetadata = true;
      if (/dc:creator|dc:rights|cc:license/i.test(block)) hasIdentity = true;
    }
  }

  if (XMP_PACKET.test(text) || /<\?xpacket/i.test(text)) {
    hasIdentity = true;
    findings.push({
      code: 'svg.xmp',
      message: 'XMP packet present — typically carries creator name and save timestamps',
      confidence: 'confirmed',
    });
  }
  // Reset lastIndex: these regexes are global and .test() advances them.
  XMP_PACKET.lastIndex = 0;

  if (/c2pa|jumbf/i.test(text)) {
    hasC2pa = true;
    hasAiMetadata = true;
    findings.push({
      code: 'svg.c2pa',
      message: 'C2PA/JUMBF reference found in the document',
      confidence: 'probable',
    });
  }

  const editorAttrs = [...text.matchAll(EDITOR_ATTRS)];
  if (editorAttrs.length > 0) {
    hasIdentity = true;
    findings.push({
      code: 'svg.editor.attrs',
      message: `${editorAttrs.length} editor attribute${editorAttrs.length === 1 ? '' : 's'} such as sodipodi:docname, which leaks a local file path`,
      confidence: 'confirmed',
    });
  }

  if (AI_VENDOR_PATTERN.test(text)) {
    hasAiMetadata = true;
    findings.push({
      code: 'svg.vendor.name',
      message: 'a model vendor name appears in the document',
      confidence: 'probable',
    });
  }

  return { findings, hasC2pa, hasAiMetadata, hasIdentity };
}

export interface SvgCleanResult {
  readonly text: string;
  readonly actions: readonly Action[];
}

export function cleanSvg(text: string): SvgCleanResult {
  const actions: Action[] = [];
  let out = text;

  const count = (pattern: RegExp): number => {
    pattern.lastIndex = 0;
    return [...out.matchAll(pattern)].length;
  };

  const metadataCount = count(METADATA_BLOCK);
  if (metadataCount > 0) {
    out = out.replace(METADATA_BLOCK, '');
    actions.push({
      code: 'svg.drop.metadata',
      message: `removed ${metadataCount} <metadata> block${metadataCount === 1 ? '' : 's'}`,
      count: metadataCount,
    });
  }

  const xmpCount = count(XMP_PACKET);
  if (xmpCount > 0) {
    out = out.replace(XMP_PACKET, '');
    actions.push({
      code: 'svg.drop.xmp',
      message: `removed ${xmpCount} XMP packet${xmpCount === 1 ? '' : 's'}`,
      count: xmpCount,
    });
  }

  const xpacketCount = count(XPACKET);
  if (xpacketCount > 0) {
    out = out.replace(XPACKET, '');
    actions.push({
      code: 'svg.drop.xpacket',
      message: `removed ${xpacketCount} xpacket wrapper${xpacketCount === 1 ? '' : 's'}`,
      count: xpacketCount,
    });
  }

  let droppedComments = 0;
  out = out.replace(COMMENT, (comment) => {
    if (!AI_NAME_PATTERN.test(comment) && !AI_VENDOR_PATTERN.test(comment)) return comment;
    droppedComments += 1;
    return '';
  });
  if (droppedComments > 0) {
    actions.push({
      code: 'svg.drop.comment',
      message: `removed ${droppedComments} comment${droppedComments === 1 ? '' : 's'} naming a generator`,
      count: droppedComments,
    });
  }

  const attrCount = count(EDITOR_ATTRS);
  if (attrCount > 0) {
    out = out.replace(EDITOR_ATTRS, '');
    actions.push({
      code: 'svg.drop.editor-attrs',
      message: `removed ${attrCount} editor attribute${attrCount === 1 ? '' : 's'} (file paths, versions)`,
      count: attrCount,
    });
  }

  if (actions.length === 0) {
    actions.push({ code: 'svg.clean.noop', message: 'no metadata found' });
  }
  return { text: out, actions };
}
