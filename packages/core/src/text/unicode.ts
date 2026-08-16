/**
 * The invisible-character pass.
 *
 * This is the layer that catches watermarks made of characters you cannot see:
 * zero-width spaces between words, variation selectors stacked after letters,
 * bidi overrides, private-use codepoints, Unicode tag characters. Each of those
 * survives copy/paste, so they travel with text into whatever you paste it into.
 *
 * The hard part is *not* stripping the invisible characters that carry meaning.
 * A zero-width joiner is contraband floating between two Latin letters and load
 * bearing between two emoji (👨‍👩‍👧 is six codepoints, two of them invisible).
 * The same is true for ZWNJ in Persian, tag characters inside flag sequences,
 * Mongolian free variation selectors, Khmer inherent vowels and Hangul fillers.
 * So every decision here is made in context: what was the previous surviving
 * character, and does this invisible belong to it?
 */

import type {
  CharHit,
  CharHitKind,
  Confidence,
  Finding,
  TextCleanStats,
  TextReport,
} from '../types.js';
import {
  BIDI_CODEPOINTS,
  EMOJI_GLUE,
  HANGUL_FILLERS,
  KHMER_INHERENT_VOWELS,
  LATIN_CONFUSABLES,
  MONGOLIAN_FVS,
  ORTHOGRAPHIC_FORMAT_CHARS,
  SCRIPT_GLUE,
  SCRIPT_JOINERS,
  SPACE_HOMOGLYPHS,
  STRIP_CODEPOINTS,
  ZERO_WIDTH_CODEPOINTS,
} from './tables.js';

const RE_FORMAT_CHAR = /\p{Cf}/u;
const RE_LETTER_OR_MARK = /[\p{L}\p{M}]/u;

const TAG_RANGE_START = 0xe0001;
const TAG_RANGE_END = 0xe007f;
/** Tag chars that spell out subdivision flags, e.g. 🏴󠁧󠁢󠁳󠁣󠁴󠁿. */
const FLAG_TAG_START = 0xe0020;
const FLAG_TAG_END = 0xe007f;
const VS_SUPPLEMENT_START = 0xe0100;
const VS_SUPPLEMENT_END = 0xe01ef;

const MAX_SAMPLE_OFFSETS = 10;

function isPrivateUse(cp: number): boolean {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  );
}

function isStripCodepoint(cp: number): boolean {
  if (STRIP_CODEPOINTS.has(cp)) return true;
  if (cp >= VS_SUPPLEMENT_START && cp <= VS_SUPPLEMENT_END) return true;
  if (cp >= TAG_RANGE_START && cp <= TAG_RANGE_END) return true;
  return isPrivateUse(cp);
}

function stripKind(cp: number): CharHitKind {
  if (cp >= TAG_RANGE_START && cp <= TAG_RANGE_END) return 'tag-chars';
  if (
    (cp >= VS_SUPPLEMENT_START && cp <= VS_SUPPLEMENT_END) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x180b && cp <= 0x180d)
  ) {
    return 'variation-selector';
  }
  if (BIDI_CODEPOINTS.has(cp)) return 'bidi';
  if (ZERO_WIDTH_CODEPOINTS.has(cp)) return 'zero-width';
  if (isPrivateUse(cp)) return 'private-use';
  return 'strip';
}

/** Can this codepoint start or continue an emoji sequence? */
function isEmojiBase(cp: number): boolean {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return true; // misc symbols, dingbats, arrows
  if (cp >= 0x2b00 && cp <= 0x2bff) return true; // misc symbols and arrows
  if (cp === 0x00a9 || cp === 0x00ae || cp === 0x2122) return true; // © ® ™
  if (cp === 0x3030 || cp === 0x303d || cp === 0x3297 || cp === 0x3299) return true;
  // Keycap bases: # * 0-9
  return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39);
}

function isLetterOrMark(cp: number): boolean {
  return cp > 0x7f && RE_LETTER_OR_MARK.test(String.fromCodePoint(cp));
}

function isMongolianLetter(cp: number): boolean {
  return cp >= 0x1800 && cp <= 0x18af && /\p{L}/u.test(String.fromCodePoint(cp));
}

function isKhmerLetter(cp: number): boolean {
  return cp >= 0x1780 && cp <= 0x17ff && /\p{L}/u.test(String.fromCodePoint(cp));
}

function isHangulJamo(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xd7b0 && cp <= 0xd7c6)
  );
}

/**
 * Invisible characters that bind to a base rather than floating free.
 *
 * These never advance "the previous kept character", so a ZWJ chain such as
 * ❤️‍🔥 stays anchored to the emoji that started it instead of each joiner
 * becoming the base for the next one.
 */
function isGlue(cp: number): boolean {
  return (
    EMOJI_GLUE.has(cp) ||
    SCRIPT_JOINERS.has(cp) ||
    (cp >= FLAG_TAG_START && cp <= FLAG_TAG_END) ||
    SCRIPT_GLUE.has(cp)
  );
}

type Decision =
  | { action: 'keep'; out: string }
  | { action: 'strip'; kind: CharHitKind }
  | { action: 'replace'; out: string; kind: CharHitKind };

interface DecideOptions {
  normalizeSpaces: boolean;
  treatConfusables: boolean;
  stripEmojiGlue: boolean;
}

/**
 * Classify one codepoint. Shared by inspect and clean so the two can never
 * disagree about what counts as suspicious.
 */
function decide(cp: number, prevKept: number | null, opts: DecideOptions): Decision {
  const ch = String.fromCodePoint(cp);

  if (!opts.stripEmojiGlue) {
    if (EMOJI_GLUE.has(cp) && prevKept !== null && isEmojiBase(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (SCRIPT_JOINERS.has(cp) && prevKept !== null && isLetterOrMark(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (cp >= FLAG_TAG_START && cp <= FLAG_TAG_END && prevKept !== null && isEmojiBase(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (MONGOLIAN_FVS.has(cp) && prevKept !== null && isMongolianLetter(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (KHMER_INHERENT_VOWELS.has(cp) && prevKept !== null && isKhmerLetter(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (HANGUL_FILLERS.has(cp) && prevKept !== null && isHangulJamo(prevKept)) {
      return { action: 'keep', out: ch };
    }
    if (ORTHOGRAPHIC_FORMAT_CHARS.has(cp)) {
      return { action: 'keep', out: ch };
    }
  }

  if (isStripCodepoint(cp)) {
    return { action: 'strip', kind: stripKind(cp) };
  }
  if (opts.normalizeSpaces && SPACE_HOMOGLYPHS.has(cp)) {
    return { action: 'replace', out: ' ', kind: 'space-homoglyph' };
  }
  if (opts.treatConfusables && LATIN_CONFUSABLES.has(cp)) {
    return { action: 'replace', out: LATIN_CONFUSABLES.get(cp)!, kind: 'latin-confusable' };
  }
  // Catch-all for format characters not in any table: new Unicode versions add
  // them, and an unknown invisible is exactly what a novel carrier looks like.
  if (RE_FORMAT_CHAR.test(ch) && !SPACE_HOMOGLYPHS.has(cp)) {
    return { action: 'strip', kind: 'other-format-char' };
  }
  return { action: 'keep', out: ch };
}

function hexLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Best available name for a codepoint, synthesised for the open ranges. */
export function codepointName(cp: number): string {
  const known = STRIP_CODEPOINTS.get(cp) ?? SPACE_HOMOGLYPHS.get(cp);
  if (known !== undefined) return known;
  if (cp >= VS_SUPPLEMENT_START && cp <= VS_SUPPLEMENT_END) {
    return `VARIATION SELECTOR-${cp - VS_SUPPLEMENT_START + 17}`;
  }
  if (cp >= TAG_RANGE_START && cp <= TAG_RANGE_END) {
    const base = cp - 0xe0000;
    const printable = base >= 0x20 && base < 0x7f ? ` ${String.fromCharCode(base)}` : '';
    return `TAG${printable}`;
  }
  if (isPrivateUse(cp)) return 'PRIVATE USE CHARACTER';
  if (LATIN_CONFUSABLES.has(cp)) return 'LATIN LOOKALIKE';
  return 'FORMAT CHARACTER';
}

function generalCategory(cp: number): string {
  const ch = String.fromCodePoint(cp);
  if (RE_FORMAT_CHAR.test(ch)) return 'Cf';
  if (/\p{Co}/u.test(ch)) return 'Co';
  if (/\p{Zs}/u.test(ch)) return 'Zs';
  if (/\p{Mn}/u.test(ch)) return 'Mn';
  if (/\p{Lu}/u.test(ch)) return 'Lu';
  if (/\p{Ll}/u.test(ch)) return 'Ll';
  if (/\p{Cc}/u.test(ch)) return 'Cc';
  return 'Cn';
}

/**
 * Space homoglyphs and confusables are weak evidence: real documents contain
 * non-breaking spaces for legitimate typographic reasons, and mixed-script text
 * is normal in most of the world. Everything else on this layer is an invisible
 * character with no rendering purpose, which is a deliberate act.
 */
function hitConfidence(kind: CharHitKind): Confidence {
  return kind === 'space-homoglyph' || kind === 'latin-confusable' ? 'informational' : 'probable';
}

export interface InspectTextOptions {
  /** Also flag Latin confusables. Noisy on any multilingual document. */
  readonly aggressive?: boolean;
  /** Treat emoji glue and script joiners as contraband too. */
  readonly stripEmojiGlue?: boolean;
}

const BASE_NOTES: readonly string[] = [
  'This pass covers invisible and format Unicode only — carriers that survive copy/paste.',
  'Statistical token-sampling watermarks leave no character-level trace and are not visible here.',
  'Load-bearing invisibles are preserved by default: emoji glue, script joiners inside complex scripts, flag tag characters, same-script fillers and orthographic Arabic/Syriac format marks.',
];

/** Scan text for invisible-character carriers without modifying it. */
export function inspectText(text: string, options: InspectTextOptions = {}): TextReport {
  const opts: DecideOptions = {
    normalizeSpaces: true,
    treatConfusables: options.aggressive ?? false,
    stripEmojiGlue: options.stripEmojiGlue ?? false,
  };

  const buckets = new Map<string, { cp: number; kind: CharHitKind; offsets: number[] }>();
  let prevKept: number | null = null;
  let total = 0;

  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const d = decide(cp, prevKept, opts);

    if (d.action === 'keep') {
      if (!isGlue(cp)) prevKept = cp;
      i += width;
      continue;
    }

    const key = `${cp}:${d.kind}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { cp, kind: d.kind, offsets: [] };
      buckets.set(key, bucket);
    }
    bucket.offsets.push(i);
    total += 1;

    if (d.action === 'replace') prevKept = d.out.codePointAt(0)!;
    // A stripped character leaves prevKept alone: the base before it is still
    // the base for whatever comes next.
    i += width;
  }

  const hits: CharHit[] = [...buckets.values()]
    .sort((a, b) => b.offsets.length - a.offsets.length || a.cp - b.cp)
    .map((b) => ({
      codepoint: b.cp,
      label: hexLabel(b.cp),
      category: generalCategory(b.cp),
      kind: b.kind,
      confidence: hitConfidence(b.kind),
      count: b.offsets.length,
      sampleOffsets: b.offsets.slice(0, MAX_SAMPLE_OFFSETS),
    }));

  const findings: Finding[] = hits.map((h) => ({
    code: `text.unicode.${h.kind}`,
    message: `${h.label} ${codepointName(h.codepoint)} (${h.category}) x${h.count}`,
    confidence: h.confidence,
    at: h.sampleOffsets.length > 0 ? `offset ${h.sampleOffsets[0]}` : undefined,
  }));

  const notes = [...BASE_NOTES];
  if (hits.length === 0) {
    notes.push('No invisible-character carriers found.');
  }

  return {
    kind: 'text',
    format: 'text',
    length: text.length,
    suspiciousTotal: total,
    hits,
    findings,
    notes,
  };
}

export interface CleanTextOptions extends InspectTextOptions {
  /** Apply NFKC normalisation after stripping. Changes visible characters. */
  readonly nfkc?: boolean;
  /** Rewrite confusables to ASCII. Implied when `aggressive` is set. */
  readonly aggressiveHomoglyphs?: boolean;
  /** Fold exotic spaces to U+0020. Default true. */
  readonly normalizeSpaces?: boolean;
}

export interface CleanTextOutcome {
  readonly text: string;
  readonly stats: TextCleanStats;
}

/** Remove invisible-character carriers, returning the cleaned text and stats. */
export function cleanText(text: string, options: CleanTextOptions = {}): CleanTextOutcome {
  const opts: DecideOptions = {
    normalizeSpaces: options.normalizeSpaces ?? true,
    treatConfusables: options.aggressiveHomoglyphs ?? options.aggressive ?? false,
    stripEmojiGlue: options.stripEmojiGlue ?? false,
  };

  const removed: Record<string, number> = {};
  const replaced: Record<string, number> = {};
  const parts: string[] = [];
  let prevKept: number | null = null;

  const tally = (into: Record<string, number>, cp: number): void => {
    const key = `${hexLabel(cp)} ${codepointName(cp)}`;
    into[key] = (into[key] ?? 0) + 1;
  };

  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const d = decide(cp, prevKept, opts);

    if (d.action === 'keep') {
      parts.push(d.out);
      if (!isGlue(cp)) prevKept = cp;
    } else if (d.action === 'replace') {
      parts.push(d.out);
      tally(replaced, cp);
      prevKept = d.out.codePointAt(0)!;
    } else {
      tally(removed, cp);
    }
    i += width;
  }

  let result = parts.join('');
  const removedCount = sum(removed);
  const replacedCount = sum(replaced);

  if (options.nfkc === true) {
    const before = result;
    result = result.normalize('NFKC');
    if (result !== before) {
      replaced['NFKC normalisation'] = Math.abs(before.length - result.length) || 1;
    }
  }

  return {
    text: result,
    stats: {
      inputLength: text.length,
      outputLength: result.length,
      removed,
      replaced,
      removedCount,
      replacedCount,
    },
  };
}

function sum(counts: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}
