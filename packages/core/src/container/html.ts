/**
 * HTML metadata inspection and cleaning.
 *
 * Regex over HTML is normally a mistake. It is defensible here because the
 * targets are `<meta>` tags, `<script type="application/ld+json">` blocks and
 * `data-ai-*` attributes — all of which are flat, attribute-only constructs
 * that never nest. Nothing in this file tries to understand document
 * structure, and anything it does not recognise is passed through byte for
 * byte, so an unparseable page comes out exactly as it went in.
 */

import type { Action, Finding } from '../types.js';
import { AI_NAME_PATTERN, AI_VENDOR_PATTERN } from './vocab.js';

const META_TAG = /<meta\b[^>]*>/gi;
const META_ATTR = /(name|property|content|generator|http-equiv)\s*=\s*["']([^"']*)["']/gi;
const JSON_LD =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi;
const DATA_AI_ATTR = /\sdata-ai[\w-]*\s*=\s*["'][^"']*["']/gi;
const PROVENANCE_JSONLD = /digitalSourceType|trainedAlgorithmicMedia|SoftwareAgent|c2pa/i;

/** Meta names that identify the author or their location. */
const IDENTITY_META = /^(author|creator|copyright|geo\.|icbm|dc\.creator|article:author)/i;

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(META_ATTR)) {
    out.set(m[1]!.toLowerCase(), m[2]!);
  }
  return out;
}

/**
 * A `generator` tag naming a CMS is not AI provenance.
 *
 * Stripping `<meta name="generator" content="Hugo 0.120">` from someone's site
 * is vandalism, not privacy. Only generator tags naming a model vendor are
 * treated as provenance.
 */
function isCmsGenerator(tag: string): boolean {
  const a = attrs(tag);
  const nameOrProp = (a.get('name') ?? a.get('property') ?? a.get('generator') ?? '').toLowerCase();
  if (nameOrProp !== 'generator') return false;
  return !AI_VENDOR_PATTERN.test(a.get('content') ?? '') && !AI_VENDOR_PATTERN.test(tag);
}

function isAiMeta(tag: string): boolean {
  if (isCmsGenerator(tag)) return false;
  return AI_NAME_PATTERN.test(tag) || AI_VENDOR_PATTERN.test(tag);
}

export interface HtmlScan {
  readonly findings: readonly Finding[];
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly hasIdentity: boolean;
}

export function inspectHtml(text: string): HtmlScan {
  const findings: Finding[] = [];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let hasIdentity = false;

  for (const [tag] of text.matchAll(META_TAG)) {
    if (/c2pa|content.?credential/i.test(tag)) hasC2pa = true;

    if (isCmsGenerator(tag)) {
      findings.push({
        code: 'html.meta.cms-generator',
        message: `generator tag names a CMS, not a model: ${truncate(tag)}`,
        confidence: 'informational',
      });
      continue;
    }

    if (isAiMeta(tag)) {
      hasAiMetadata = true;
      findings.push({
        code: 'html.meta.ai',
        message: `meta tag records AI provenance: ${truncate(tag)}`,
        confidence: AI_VENDOR_PATTERN.test(tag) ? 'confirmed' : 'probable',
      });
      continue;
    }

    const name = attrs(tag).get('name') ?? attrs(tag).get('property') ?? '';
    if (IDENTITY_META.test(name)) {
      hasIdentity = true;
      findings.push({
        code: 'html.meta.identity',
        message: `meta tag "${name}" identifies the author or location`,
        confidence: 'confirmed',
      });
    }
  }

  for (const [block] of text.matchAll(JSON_LD)) {
    if (AI_NAME_PATTERN.test(block) || PROVENANCE_JSONLD.test(block)) {
      hasAiMetadata = true;
      if (/c2pa|contentcredential/i.test(block)) hasC2pa = true;
      findings.push({
        code: 'html.jsonld.provenance',
        message: 'JSON-LD block contains a provenance claim',
        confidence: 'confirmed',
      });
    }
  }

  for (const [attr] of text.matchAll(DATA_AI_ATTR)) {
    hasAiMetadata = true;
    findings.push({
      code: 'html.attr.data-ai',
      message: `element carries ${truncate(attr.trim(), 80)}`,
      confidence: 'probable',
    });
  }

  return { findings, hasC2pa, hasAiMetadata, hasIdentity };
}

export interface HtmlCleanResult {
  readonly text: string;
  readonly actions: readonly Action[];
}

/** Remove AI provenance metadata, leaving CMS and editorial metadata alone. */
export function cleanHtml(text: string): HtmlCleanResult {
  const actions: Action[] = [];
  let droppedMeta = 0;
  let droppedJsonLd = 0;

  let out = text.replace(META_TAG, (tag) => {
    if (!isAiMeta(tag)) return tag;
    droppedMeta += 1;
    return '';
  });

  out = out.replace(JSON_LD, (block) => {
    if (!AI_NAME_PATTERN.test(block) && !PROVENANCE_JSONLD.test(block)) return block;
    droppedJsonLd += 1;
    return '';
  });

  let droppedAttrs = 0;
  out = out.replace(DATA_AI_ATTR, () => {
    droppedAttrs += 1;
    return '';
  });

  if (droppedMeta > 0) {
    actions.push({
      code: 'html.drop.meta',
      message: `removed ${droppedMeta} provenance meta tag${droppedMeta === 1 ? '' : 's'}`,
      count: droppedMeta,
    });
  }
  if (droppedJsonLd > 0) {
    actions.push({
      code: 'html.drop.jsonld',
      message: `removed ${droppedJsonLd} JSON-LD provenance block${droppedJsonLd === 1 ? '' : 's'}`,
      count: droppedJsonLd,
    });
  }
  if (droppedAttrs > 0) {
    actions.push({
      code: 'html.drop.data-ai',
      message: `removed ${droppedAttrs} data-ai-* attribute${droppedAttrs === 1 ? '' : 's'}`,
      count: droppedAttrs,
    });
  }
  if (actions.length === 0) {
    actions.push({ code: 'html.clean.noop', message: 'no AI provenance metadata found' });
  }
  return { text: out, actions };
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
