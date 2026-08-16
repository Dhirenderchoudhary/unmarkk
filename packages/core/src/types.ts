/**
 * Shared contract for every engine in the pipeline.
 *
 * Two design rules hold across this file:
 *
 * 1. Nothing here describes a network resource. The engine has no I/O surface
 *    at all — callers hand it bytes and get bytes back. That is what makes the
 *    privacy claim structural rather than a promise.
 * 2. Confidence is attached where a finding is *emitted*, never inferred later
 *    from its wording. A parser that just read a JUMBF box knows more about
 *    what it saw than any classifier reading the sentence afterwards.
 */

/** Which pipeline owns a given input. */
export type Kind = 'text' | 'image' | 'container';

/** Concrete formats the engine can parse. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ContainerFormat = 'svg' | 'pdf' | 'docx' | 'odt' | 'html' | 'markdown';
export type Format = ImageFormat | ContainerFormat | 'text' | 'unknown';

/**
 * How much weight a finding deserves.
 *
 * - `confirmed`  — a provenance structure was actually parsed (a C2PA/JUMBF
 *                  box, a `digitalSourceType` field, a real XMP packet).
 * - `probable`   — a vendor/AI marker sat inside a recognised metadata
 *                  structure, but no provenance claim was parsed out of it.
 * - `informational` — context only: a CMS generator tag, "an XMP packet
 *                  exists", "this format is only partially supported".
 * - `likely-false-positive` — a raw byte-scan hit, which collides with
 *                  compressed image and stream data all the time.
 */
export type Confidence = 'confirmed' | 'probable' | 'informational' | 'likely-false-positive';

/** Rank used for sorting and for "worst finding" summaries. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 3,
  probable: 2,
  informational: 1,
  'likely-false-positive': 0,
};

/** Something the inspector noticed. */
export interface Finding {
  /** Stable machine-readable id, e.g. `png.chunk.c2pa`. Safe to match on. */
  readonly code: string;
  /** Human-readable sentence. Wording may change between releases. */
  readonly message: string;
  readonly confidence: Confidence;
  /** Where in the input, when meaningful (byte offset, part name, key). */
  readonly at?: string;
}

/** Something the cleaner actually did. */
export interface Action {
  /** Stable machine-readable id, e.g. `jpeg.drop.app11`. */
  readonly code: string;
  readonly message: string;
  /** How many times it happened, when the action is repeatable. */
  readonly count?: number;
}

/** Classification of a single suspicious codepoint run in text. */
export type CharHitKind =
  | 'strip'
  | 'bidi'
  | 'tag-chars'
  | 'variation-selector'
  | 'zero-width'
  | 'private-use'
  | 'space-homoglyph'
  | 'latin-confusable'
  | 'other-format-char';

export interface CharHit {
  /** Numeric codepoint, e.g. 0x200b. */
  readonly codepoint: number;
  /** Rendered as `U+200B`. */
  readonly label: string;
  /** Unicode general category, e.g. `Cf`. */
  readonly category: string;
  readonly kind: CharHitKind;
  readonly confidence: Confidence;
  readonly count: number;
  /** First few code-unit offsets, capped. */
  readonly sampleOffsets: readonly number[];
}

export interface StylometryMarker {
  readonly phrase: string;
  readonly count: number;
  readonly weight: number;
  readonly samples: readonly string[];
}

export type StylometryLevel = 'CLEAN' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface StylometryReport {
  readonly wordCount: number;
  readonly sentenceCount: number;
  /** Coefficient of variation of sentence length. Low means machine-even. */
  readonly burstinessCv: number;
  /** Moving-average type-token ratio. */
  readonly lexicalDiversity: number;
  /** Weighted formulaic-phrase matches per 100 words. */
  readonly markerDensity: number;
  readonly markers: readonly StylometryMarker[];
  readonly score: number;
  readonly level: StylometryLevel;
  readonly status: 'ok' | 'insufficient-length';
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

interface ReportBase {
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

export interface TextReport extends ReportBase {
  readonly kind: 'text';
  readonly format: 'text';
  /** Length in UTF-16 code units, matching `sampleOffsets`. */
  readonly length: number;
  readonly suspiciousTotal: number;
  readonly hits: readonly CharHit[];
  /** Only present when stylometry was requested. */
  readonly stylometry?: StylometryReport;
}

export interface ImageReport extends ReportBase {
  readonly kind: 'image';
  readonly format: ImageFormat | 'unknown';
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  /** Non-provenance metadata worth flagging for privacy: GPS, serials, names. */
  readonly privacy: PrivacyFindings;
}

export interface ContainerReport extends ReportBase {
  readonly kind: 'container';
  readonly format: ContainerFormat | 'unknown';
  readonly hasC2pa: boolean;
  readonly hasAiMetadata: boolean;
  readonly privacy: PrivacyFindings;
  /** Format-specific extras (zip part counts, frontmatter keys, …). */
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The privacy half of the report: identifying metadata that has nothing to do
 * with AI provenance but everything to do with who you are and where you were.
 */
export interface PrivacyFindings {
  readonly hasLocation: boolean;
  readonly hasDeviceIdentity: boolean;
  readonly hasAuthorIdentity: boolean;
  readonly hasTimestamps: boolean;
}

export const NO_PRIVACY_FINDINGS: PrivacyFindings = Object.freeze({
  hasLocation: false,
  hasDeviceIdentity: false,
  hasAuthorIdentity: false,
  hasTimestamps: false,
});

export type InspectReport = TextReport | ImageReport | ContainerReport;

export interface TextCleanStats {
  readonly inputLength: number;
  readonly outputLength: number;
  readonly removed: Readonly<Record<string, number>>;
  readonly replaced: Readonly<Record<string, number>>;
  readonly removedCount: number;
  readonly replacedCount: number;
}

interface CleanResultBase {
  readonly output: Uint8Array;
  readonly actions: readonly Action[];
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export interface TextCleanResult extends CleanResultBase {
  readonly kind: 'text';
  readonly format: 'text';
  readonly stats: TextCleanStats;
}

export interface BinaryCleanResult extends CleanResultBase {
  readonly kind: 'image' | 'container';
  readonly format: Format;
  /** Re-inspection of the output. Empty findings is the goal. */
  readonly residual: {
    readonly hasC2pa: boolean;
    readonly hasAiMetadata: boolean;
    readonly findings: readonly Finding[];
  };
  /**
   * True when the cleaner could not fully rebuild the file and fell back to a
   * partial strip. The output is still safer than the input, but not provably
   * clean — surfaced so callers never claim more than was done.
   */
  readonly degraded: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type CleanResult = TextCleanResult | BinaryCleanResult;

/** Options accepted by the unified entry points. */
export interface InspectOptions {
  /** Filename hint. Only the extension is used, for format routing. */
  readonly filename?: string;
  /** Force a pipeline instead of sniffing. */
  readonly as?: Kind;
  /** Also flag Latin confusables (Cyrillic `а` for `a`). Noisy on real text. */
  readonly aggressive?: boolean;
  /** Run the stylometry scorer on text input. Off by default: it is a guess. */
  readonly stylometry?: boolean;
  /** Process bytes as text even when they sniff as a binary container. */
  readonly forceText?: boolean;
}

export interface CleanOptions extends InspectOptions {
  /** Apply Unicode NFKC normalisation to text. Changes visible characters. */
  readonly nfkc?: boolean;
  /** Rewrite Latin confusables to ASCII. Destructive on genuinely mixed text. */
  readonly aggressiveHomoglyphs?: boolean;
  /** Normalise exotic spaces to U+0020. Default true. */
  readonly normalizeSpaces?: boolean;
  /**
   * Strip emoji glue and script joiners too. Breaks 👨‍👩‍👧 and Persian می‌روم.
   * Only for inputs where any invisible character is unacceptable.
   */
  readonly stripEmojiGlue?: boolean;
  /**
   * Images: remove *all* metadata, not just provenance-looking segments.
   * Default true — that is the privacy-first choice.
   */
  readonly stripAllMetadata?: boolean;
  /** Containers: also run the Unicode pass over Markdown/HTML text bodies. */
  readonly cleanTextBodies?: boolean;
}
