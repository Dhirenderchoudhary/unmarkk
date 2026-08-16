/** Format routing for document containers. */

import type {
  Action,
  BinaryCleanResult,
  CleanOptions,
  ContainerFormat,
  ContainerReport,
  Finding,
  PrivacyFindings,
} from '../types.js';
import { NO_PRIVACY_FINDINGS } from '../types.js';
import { describePrivacy } from '../markers.js';
import { decodeText, encodeText } from '../util/text-codec.js';
import { listZipNames } from '../util/zip.js';
import { cleanText } from '../text/unicode.js';
import { cleanHtml, inspectHtml } from './html.js';
import { cleanMarkdown, inspectMarkdown } from './markdown.js';
import { cleanSvg, inspectSvg } from './svg.js';
import { cleanDocx, inspectDocx } from './ooxml.js';
import { cleanOdt, inspectOdt } from './odf.js';
import { cleanPdf, inspectPdf, isPdf } from './pdf.js';

export * from './markdown.js';
export * from './html.js';
export * from './svg.js';
export * from './ooxml.js';
export * from './odf.js';
export * from './pdf.js';
export * from './vocab.js';

const EXTENSION_FORMATS: ReadonlyMap<string, ContainerFormat> = new Map([
  ['.svg', 'svg'],
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.odt', 'odt'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdx', 'markdown'],
]);

function extensionOf(filename: string | undefined): string {
  if (filename === undefined) return '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/** Identify a container format from its filename and, failing that, its bytes. */
export async function detectContainerFormat(
  data: Uint8Array,
  filename?: string,
): Promise<ContainerFormat | 'unknown'> {
  const byExtension = EXTENSION_FORMATS.get(extensionOf(filename));
  if (byExtension !== undefined) return byExtension;

  if (isPdf(data)) return 'pdf';

  const head = decodeText(data.subarray(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    if (head.includes('<svg')) return 'svg';
  }
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';

  if (data[0] === 0x50 && data[1] === 0x4b) {
    const names = await listZipNames(data);
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('content.xml') && names.includes('meta.xml')) return 'odt';
  }

  return 'unknown';
}

function toPrivacy(partial: Partial<PrivacyFindings>): PrivacyFindings {
  return { ...NO_PRIVACY_FINDINGS, ...partial };
}

/** Inspect a document container for provenance and identifying metadata. */
export async function inspectContainer(
  data: Uint8Array,
  filename?: string,
): Promise<ContainerReport> {
  const format = await detectContainerFormat(data, filename);
  const notes: string[] = [];
  let findings: readonly Finding[] = [];
  let hasC2pa = false;
  let hasAiMetadata = false;
  let privacy: PrivacyFindings = NO_PRIVACY_FINDINGS;
  let details: Record<string, unknown> = {};

  switch (format) {
    case 'markdown': {
      const scan = inspectMarkdown(decodeText(data));
      findings = scan.findings;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = toPrivacy({ hasAuthorIdentity: scan.hasIdentity });
      details = { hasFrontmatter: scan.hasFrontmatter, keys: scan.keys };
      break;
    }
    case 'html': {
      const scan = inspectHtml(decodeText(data));
      findings = scan.findings;
      hasC2pa = scan.hasC2pa;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = toPrivacy({ hasAuthorIdentity: scan.hasIdentity });
      break;
    }
    case 'svg': {
      const scan = inspectSvg(decodeText(data));
      findings = scan.findings;
      hasC2pa = scan.hasC2pa;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = toPrivacy({ hasAuthorIdentity: scan.hasIdentity });
      break;
    }
    case 'docx': {
      const scan = await inspectDocx(data);
      findings = scan.findings;
      hasC2pa = scan.hasC2pa;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = scan.privacy;
      details = { parts: scan.partCount };
      notes.push(
        'Only document properties and customXml parts are scanned. Body text is left alone: a document that mentions a model is not a document written by one.',
      );
      break;
    }
    case 'odt': {
      const scan = await inspectOdt(data);
      findings = scan.findings;
      hasC2pa = scan.hasC2pa;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = scan.privacy;
      details = { parts: scan.partCount };
      break;
    }
    case 'pdf': {
      const scan = await inspectPdf(data);
      findings = scan.findings;
      hasC2pa = scan.hasC2pa;
      hasAiMetadata = scan.hasAiMetadata;
      privacy = scan.privacy;
      details = { encrypted: scan.encrypted };
      break;
    }
    default:
      notes.push('Unrecognised container format; nothing was inspected.');
      break;
  }

  const privacyLabels = describePrivacy(privacy);
  if (privacyLabels.length > 0) {
    notes.push(`Identifying metadata present: ${privacyLabels.join('; ')}.`);
  }

  return {
    kind: 'container',
    format,
    hasC2pa,
    hasAiMetadata: hasAiMetadata || hasC2pa,
    privacy,
    findings,
    notes,
    details,
  };
}

/** Clean a document container, then re-inspect the result. */
export async function cleanContainer(
  data: Uint8Array,
  options: CleanOptions = {},
): Promise<BinaryCleanResult> {
  const format = await detectContainerFormat(data, options.filename);
  const cleanBodies = options.cleanTextBodies ?? true;

  let output: Uint8Array;
  let actions: Action[] = [];
  let degraded = false;

  switch (format) {
    case 'markdown': {
      const result = cleanMarkdown(decodeText(data));
      const finished = applyTextPass(result.text, cleanBodies, options);
      output = encodeText(finished.text);
      actions = [...result.actions, ...finished.actions];
      break;
    }
    case 'html': {
      const result = cleanHtml(decodeText(data));
      const finished = applyTextPass(result.text, cleanBodies, options);
      output = encodeText(finished.text);
      actions = [...result.actions, ...finished.actions];
      break;
    }
    case 'svg': {
      const result = cleanSvg(decodeText(data));
      output = encodeText(result.text);
      actions = [...result.actions];
      break;
    }
    case 'docx': {
      const result = await cleanDocx(data);
      output = result.output;
      actions = [...result.actions];
      break;
    }
    case 'odt': {
      const result = await cleanOdt(data);
      output = result.output;
      actions = [...result.actions];
      break;
    }
    case 'pdf': {
      const result = await cleanPdf(data);
      output = result.output;
      actions = [...result.actions];
      degraded = result.degraded;
      break;
    }
    default:
      throw new Error(`unsupported container format: ${format}`);
  }

  const before = await inspectContainer(data, options.filename);
  const after = await inspectContainer(output, options.filename);

  if (describePrivacy(before.privacy).length > 0 && describePrivacy(after.privacy).length === 0) {
    actions.push({
      code: 'container.privacy.cleared',
      message: `removed identifying metadata: ${describePrivacy(before.privacy).join('; ')}`,
    });
  }

  return {
    kind: 'container',
    format,
    output,
    actions,
    bytesIn: data.length,
    bytesOut: output.length,
    residual: {
      hasC2pa: after.hasC2pa,
      hasAiMetadata: after.hasAiMetadata,
      findings: after.findings,
    },
    degraded,
    details: { privacyBefore: before.privacy, privacyAfter: after.privacy },
  };
}

/** Run the invisible-character pass over a text body, if requested. */
function applyTextPass(
  text: string,
  enabled: boolean,
  options: CleanOptions,
): { text: string; actions: Action[] } {
  if (!enabled) return { text, actions: [] };

  const result = cleanText(text, {
    nfkc: options.nfkc ?? false,
    aggressiveHomoglyphs: options.aggressiveHomoglyphs ?? false,
    normalizeSpaces: options.normalizeSpaces ?? true,
    stripEmojiGlue: options.stripEmojiGlue ?? false,
  });

  const changed = result.stats.removedCount + result.stats.replacedCount;
  if (changed === 0) return { text, actions: [] };

  return {
    text: result.text,
    actions: [
      {
        code: 'container.text.unicode',
        message: `invisible-character pass over the body: removed ${result.stats.removedCount}, replaced ${result.stats.replacedCount}`,
        count: changed,
      },
    ],
  };
}
