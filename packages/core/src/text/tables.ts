/**
 * Codepoint tables for the invisible-character pass.
 *
 * Names are carried here rather than looked up, because JavaScript has no
 * Unicode name database and shipping one would cost megabytes for the ~130
 * codepoints this file actually deals with. Everything outside these tables
 * falls into a range (variation selectors, tag characters, private use) whose
 * name is synthesised in `describe()`.
 */

/** Invisible format/control codepoints used as steganographic carriers. */
export const STRIP_CODEPOINTS: ReadonlyMap<number, string> = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x115f, 'HANGUL CHOSEONG FILLER'],
  [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x17b4, 'KHMER VOWEL INHERENT AQ'],
  [0x17b5, 'KHMER VOWEL INHERENT AA'],
  [0x180b, 'MONGOLIAN FREE VARIATION SELECTOR ONE'],
  [0x180c, 'MONGOLIAN FREE VARIATION SELECTOR TWO'],
  [0x180d, 'MONGOLIAN FREE VARIATION SELECTOR THREE'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x206a, 'INHIBIT SYMMETRIC SWAPPING'],
  [0x206b, 'ACTIVATE SYMMETRIC SWAPPING'],
  [0x206c, 'INHIBIT ARABIC FORM SHAPING'],
  [0x206d, 'ACTIVATE ARABIC FORM SHAPING'],
  [0x206e, 'NATIONAL DIGIT SHAPES'],
  [0x206f, 'NOMINAL DIGIT SHAPES'],
  [0xfe00, 'VARIATION SELECTOR-1'],
  [0xfe01, 'VARIATION SELECTOR-2'],
  [0xfe02, 'VARIATION SELECTOR-3'],
  [0xfe03, 'VARIATION SELECTOR-4'],
  [0xfe04, 'VARIATION SELECTOR-5'],
  [0xfe05, 'VARIATION SELECTOR-6'],
  [0xfe06, 'VARIATION SELECTOR-7'],
  [0xfe07, 'VARIATION SELECTOR-8'],
  [0xfe08, 'VARIATION SELECTOR-9'],
  [0xfe09, 'VARIATION SELECTOR-10'],
  [0xfe0a, 'VARIATION SELECTOR-11'],
  [0xfe0b, 'VARIATION SELECTOR-12'],
  [0xfe0c, 'VARIATION SELECTOR-13'],
  [0xfe0d, 'VARIATION SELECTOR-14'],
  [0xfe0e, 'VARIATION SELECTOR-15'],
  [0xfe0f, 'VARIATION SELECTOR-16'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
  [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'],
  [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
  [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
]);

/** Spaces that render like U+0020 and can encode a bit pattern. */
export const SPACE_HOMOGLYPHS: ReadonlyMap<number, string> = new Map([
  [0x00a0, 'NO-BREAK SPACE'],
  [0x1680, 'OGHAM SPACE MARK'],
  [0x2000, 'EN QUAD'],
  [0x2001, 'EM QUAD'],
  [0x2002, 'EN SPACE'],
  [0x2003, 'EM SPACE'],
  [0x2004, 'THREE-PER-EM SPACE'],
  [0x2005, 'FOUR-PER-EM SPACE'],
  [0x2006, 'SIX-PER-EM SPACE'],
  [0x2007, 'FIGURE SPACE'],
  [0x2008, 'PUNCTUATION SPACE'],
  [0x2009, 'THIN SPACE'],
  [0x200a, 'HAIR SPACE'],
  [0x202f, 'NARROW NO-BREAK SPACE'],
  [0x205f, 'MEDIUM MATHEMATICAL SPACE'],
  [0x3000, 'IDEOGRAPHIC SPACE'],
]);

/**
 * Latin lookalikes, only used in aggressive mode.
 *
 * Rewriting these is genuinely destructive on multilingual text — Cyrillic
 * "Опера" becomes "Onepa" — so it is never on by default.
 */
export const LATIN_CONFUSABLES: ReadonlyMap<number, string> = new Map([
  // Cyrillic capitals
  [0x0410, 'A'],
  [0x0412, 'B'],
  [0x0415, 'E'],
  [0x041a, 'K'],
  [0x041c, 'M'],
  [0x041d, 'H'],
  [0x041e, 'O'],
  [0x0420, 'P'],
  [0x0421, 'C'],
  [0x0422, 'T'],
  [0x0425, 'X'],
  // Cyrillic lowercase
  [0x0430, 'a'],
  [0x0435, 'e'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0441, 'c'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x0456, 'i'],
  // Fullwidth forms
  ...buildFullwidth(),
]);

function buildFullwidth(): Array<[number, string]> {
  const rows: Array<[number, string]> = [];
  for (let i = 0; i < 26; i += 1) {
    rows.push([0xff21 + i, String.fromCharCode(0x41 + i)]);
    rows.push([0xff41 + i, String.fromCharCode(0x61 + i)]);
  }
  return rows;
}

/** Bidirectional formatting controls — the RTL-override spoofing family. */
export const BIDI_CODEPOINTS: ReadonlySet<number> = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** Zero-width family: the classic edit-based carriers. */
export const ZERO_WIDTH_CODEPOINTS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e,
]);

/** ZWJ and the two emoji presentation selectors. */
export const EMOJI_GLUE: ReadonlySet<number> = new Set([0x200d, 0xfe0e, 0xfe0f]);

/** ZWNJ/ZWJ, which are real orthography inside Persian, Hindi and others. */
export const SCRIPT_JOINERS: ReadonlySet<number> = new Set([0x200c, 0x200d]);

export const MONGOLIAN_FVS: ReadonlySet<number> = new Set([0x180b, 0x180c, 0x180d]);
export const KHMER_INHERENT_VOWELS: ReadonlySet<number> = new Set([0x17b4, 0x17b5]);
export const HANGUL_FILLERS: ReadonlySet<number> = new Set([0x115f, 0x1160]);

/** Same-script fillers and selectors that are meaningful after their own base. */
export const SCRIPT_GLUE: ReadonlySet<number> = new Set([
  ...MONGOLIAN_FVS,
  ...KHMER_INHERENT_VOWELS,
  ...HANGUL_FILLERS,
]);

/**
 * Format characters that are ordinary Arabic/Syriac orthography.
 *
 * These are `Cf` and therefore caught by the catch-all rule, but stripping
 * them corrupts correctly spelled text, so they are always kept.
 */
export const ORTHOGRAPHIC_FORMAT_CHARS: ReadonlySet<number> = new Set([
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x08e2, 0x110bd, 0x110cd,
]);
