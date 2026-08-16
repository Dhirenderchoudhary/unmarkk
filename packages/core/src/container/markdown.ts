/**
 * YAML frontmatter inspection and cleaning for Markdown.
 *
 * Only top-level keys are considered. This is a deliberate limit: parsing YAML
 * properly would mean either a dependency or a half-correct parser, and a
 * half-correct parser that rewrites your file is worse than one that admits it
 * only handles the simple shape. Nested blocks under a dropped key go with it;
 * nested blocks under a kept key are passed through untouched.
 */

import type { Action, Finding } from '../types.js';
import { AI_METADATA_KEYS, AI_NAME_PATTERN, IDENTITY_KEYS } from './vocab.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_KEY = /^([A-Za-z0-9_.-]+)[ \t]*:/;

export interface MarkdownScan {
  readonly hasFrontmatter: boolean;
  readonly keys: readonly string[];
  readonly findings: readonly Finding[];
  readonly hasAiMetadata: boolean;
  readonly hasIdentity: boolean;
}

/** True when a line starts a nested block or list item rather than a key. */
function isContinuation(line: string): boolean {
  const first = line[0];
  return first === ' ' || first === '\t' || first === '-';
}

export function inspectMarkdown(text: string): MarkdownScan {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return {
      hasFrontmatter: false,
      keys: [],
      findings: [],
      hasAiMetadata: false,
      hasIdentity: false,
    };
  }

  const findings: Finding[] = [];
  const keys: string[] = [];
  let hasAiMetadata = false;
  let hasIdentity = false;

  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#') || isContinuation(line)) continue;
    const keyMatch = TOP_LEVEL_KEY.exec(line);
    if (keyMatch === null) continue;

    const key = keyMatch[1]!;
    const value = line.slice(line.indexOf(':') + 1).trim();
    keys.push(key);

    if (AI_METADATA_KEYS.has(key.toLowerCase()) || AI_NAME_PATTERN.test(key)) {
      hasAiMetadata = true;
      findings.push({
        code: 'markdown.frontmatter.generator',
        message: `frontmatter key "${key}" records how the document was produced`,
        confidence: 'confirmed',
        at: key,
      });
    } else if (AI_NAME_PATTERN.test(value)) {
      hasAiMetadata = true;
      findings.push({
        code: 'markdown.frontmatter.value',
        message: `frontmatter value under "${key}" names a generator`,
        confidence: 'probable',
        at: key,
      });
    }

    if (IDENTITY_KEYS.has(key.toLowerCase())) {
      hasIdentity = true;
      findings.push({
        code: 'markdown.frontmatter.identity',
        message: `frontmatter key "${key}" identifies a person, place or time`,
        confidence: 'informational',
        at: key,
      });
    }
  }

  return { hasFrontmatter: true, keys, findings, hasAiMetadata, hasIdentity };
}

export interface MarkdownCleanResult {
  readonly text: string;
  readonly actions: readonly Action[];
}

/**
 * Drop provenance keys from frontmatter.
 *
 * Identity keys (author, date) are reported by `inspectMarkdown` but kept:
 * in a blog post they are the point of the file, not a leak. Removing them is
 * an editorial decision the caller should make explicitly.
 */
export function cleanMarkdown(text: string): MarkdownCleanResult {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return {
      text,
      actions: [{ code: 'markdown.frontmatter.absent', message: 'no YAML frontmatter' }],
    };
  }

  const actions: Action[] = [];
  const body = text.slice(match[0].length);
  const kept: string[] = [];
  let dropping = false;

  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Blank lines and comments belong to whichever block we are inside.
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (!dropping) kept.push(line);
      continue;
    }
    if (isContinuation(line)) {
      if (!dropping) kept.push(line);
      continue;
    }

    const keyMatch = TOP_LEVEL_KEY.exec(line);
    if (keyMatch === null) {
      dropping = false;
      kept.push(line);
      continue;
    }

    const key = keyMatch[1]!;
    const value = line.slice(line.indexOf(':') + 1).trim();

    if (AI_METADATA_KEYS.has(key.toLowerCase()) || AI_NAME_PATTERN.test(key)) {
      actions.push({ code: 'markdown.drop.key', message: `removed frontmatter key "${key}"` });
      dropping = true;
      continue;
    }
    if (AI_NAME_PATTERN.test(value)) {
      actions.push({
        code: 'markdown.drop.key',
        message: `removed frontmatter key "${key}" (its value named a generator)`,
      });
      dropping = true;
      continue;
    }

    dropping = false;
    kept.push(line);
  }

  const block = kept.join('\n').replace(/^\n+|\n+$/g, '');
  if (block === '') {
    actions.push({
      code: 'markdown.drop.block',
      message: 'removed the now-empty frontmatter block',
    });
    return { text: body.replace(/^\n+/, ''), actions };
  }
  if (actions.length === 0) {
    actions.push({ code: 'markdown.clean.noop', message: 'no provenance keys in frontmatter' });
  }
  return { text: `---\n${block}\n---\n${body}`, actions };
}
