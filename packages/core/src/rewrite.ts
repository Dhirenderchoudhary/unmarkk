/**
 * Rewrite support for statistical text watermarks.
 *
 * Some text watermarks are not made of characters. Token-sampling schemes bias
 * *which words a model picks* during generation, so the signal is spread across
 * word choice over a whole passage. There is no byte to delete. The only thing
 * that disturbs it is saying the same thing in different words.
 *
 * This module holds the pure parts of that: the prompts, a measure of how far a
 * candidate rewrite actually moved, and an honest read on what is left. It does
 * not call a model — it cannot, because nothing in this package can open a
 * socket. The CLI supplies a backend, and the default backend prints the prompt
 * and stops, so the common case involves no model at all.
 *
 * Nothing here can promise a result. A rewrite reduces a statistical signal by
 * an amount nobody can measure without the original key, and any tool claiming
 * otherwise is guessing. `assessRewrite` is deliberately written to say so.
 */

/** The rewrite strategies, in rough order of how much they change the text. */
export type RewriteMode =
  | 'paraphrase'
  | 'humanize'
  | 'code'
  | 'backtranslate-out'
  | 'backtranslate-back'
  | 'outline'
  | 'expand';

interface PromptTemplate {
  readonly mode: RewriteMode;
  readonly summary: string;
  readonly template: string;
}

const TEMPLATES: readonly PromptTemplate[] = [
  {
    mode: 'paraphrase',
    summary: 'Change wording and syntax while keeping every claim.',
    template: [
      'Rewrite the text below so it uses substantially different wording at the level of',
      'individual words. Reorder clauses, swap connectors and transitions, and vary where',
      'sentences begin and end. Replace content words and function words wherever meaning',
      'allows.',
      '',
      'Keep every fact, number, name, citation and technical identifier exactly as given.',
      'Do not add a claim that is not there. Do not drop one that is.',
      '',
      'Output only the rewritten text.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
  {
    mode: 'humanize',
    summary: 'Rewrite so it reads as if written from scratch by a person.',
    template: [
      'Rewrite the text below so it reads as though a person wrote it from scratch.',
      'Vary sentence length and rhythm. Replace formulaic transitions and filler with',
      'direct, concrete phrasing. Prefer plain words to elevated ones.',
      '',
      'Keep every fact, number, name, citation and technical identifier exactly as given.',
      'Do not add or remove claims to make the prose flow better.',
      '',
      'Output only the rewritten text.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
  {
    mode: 'code',
    summary: 'Rewrite comments and local names; leave behaviour untouched.',
    template: [
      'Rewrite only the natural-language parts of the code below: comments, docstrings and',
      'string literals that are not used as keys, paths or protocol values. Rename local',
      'variables, parameters and private helpers to different but equally clear names.',
      '',
      'Do not change program behaviour. Do not rename anything exported or public, and do',
      'not alter any value that affects output.',
      '',
      'Output only the rewritten code.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
  {
    mode: 'backtranslate-out',
    summary: 'First half of a round trip through another language.',
    template:
      'Translate the text below into {LANGUAGE}. Output only the translation.\n\n---\n{TEXT}',
  },
  {
    mode: 'backtranslate-back',
    summary: 'Second half of the round trip.',
    template: [
      'Translate the text below into {LANGUAGE}. Keep the meaning exactly; use natural',
      'phrasing rather than a literal rendering. Output only the translation.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
  {
    mode: 'outline',
    summary: 'Reduce to claims only, discarding all phrasing.',
    template: [
      'Extract every claim and structural element from the text below as a bullet outline.',
      'Use fragments, not sentences. Do not omit anything. Output only the outline.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
  {
    mode: 'expand',
    summary: 'Write fresh prose from an outline.',
    template: [
      'Write a complete document from the outline below, in natural and varied prose.',
      'Avoid formulaic transitions. Cover every bullet; do not add material that is not',
      'in the outline.',
      '',
      'Output only the document.',
      '',
      '---',
      '{TEXT}',
    ].join('\n'),
  },
];

const BY_MODE = new Map(TEMPLATES.map((t) => [t.mode, t]));

/** Every available mode, with a one-line description. */
export function rewriteModes(): readonly { mode: RewriteMode; summary: string }[] {
  return TEMPLATES.map(({ mode, summary }) => ({ mode, summary }));
}

export interface BuildPromptOptions {
  /** Target language, for the back-translation modes. */
  readonly language?: string;
}

/** Fill a prompt template with the text to rewrite. */
export function buildPrompt(
  mode: RewriteMode,
  text: string,
  options: BuildPromptOptions = {},
): string {
  const template = BY_MODE.get(mode);
  if (template === undefined) throw new Error(`unknown rewrite mode: ${mode}`);
  return template.template
    .replace('{LANGUAGE}', options.language ?? 'French')
    .replace('{TEXT}', text);
}

function tokens(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
}

function bigrams(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * How far a rewrite moved, as bigram Jaccard distance: 0 identical, 1 nothing
 * in common.
 *
 * Word pairs rather than single words, because a rewrite that swaps synonyms
 * but keeps the sentence shape has barely moved — and sentence shape is a large
 * part of what a sampling watermark rides on.
 */
export function lexicalDivergence(original: string, candidate: string): number {
  const a = tokens(original);
  const b = tokens(candidate);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 0;

  let shared = 0;
  for (const gram of ba) if (bb.has(gram)) shared += 1;
  const union = ba.size + bb.size - shared;
  return union === 0 ? 0 : 1 - shared / union;
}

export interface CandidateScore {
  readonly text: string;
  readonly divergence: number;
  /** Divergence after the length penalty, used for ranking. */
  readonly score: number;
  readonly lengthRatio: number;
}

/**
 * Pick the candidate that moved furthest without mangling the text.
 *
 * Raw divergence rewards a rewrite that threw half the document away, so
 * candidates that drift far in length are penalised: they usually mean the
 * model summarised or padded rather than rephrased.
 */
export function selectCandidate(
  original: string,
  candidates: readonly string[],
): { best: CandidateScore; all: readonly CandidateScore[] } {
  if (candidates.length === 0) throw new Error('no candidates to choose from');

  const scored: CandidateScore[] = candidates.map((text) => {
    const divergence = lexicalDivergence(original, text);
    const lengthRatio = original.length === 0 ? 1 : text.length / original.length;
    const penalty = lengthRatio > 2 || lengthRatio < 0.5 ? 0.15 : 0;
    return { text, divergence, lengthRatio, score: divergence - penalty };
  });

  let best = scored[0]!;
  for (const candidate of scored) if (candidate.score > best.score) best = candidate;
  return { best, all: scored };
}

export type ResidualRisk = 'lower' | 'moderate' | 'higher' | 'unknown';

export interface RewriteAssessment {
  readonly divergence: number;
  readonly lengthRatio: number;
  readonly wordCount: number;
  readonly residualRisk: ResidualRisk;
  /** Sentences safe to show a user. Deliberately hedged. */
  readonly notes: readonly string[];
}

/**
 * Describe what a rewrite achieved, without overclaiming.
 *
 * The honest position: a rewrite disturbs a token-sampling watermark by an
 * amount that cannot be measured without the scheme's key. Longer, more
 * distinctive prose carries more signal to begin with and therefore retains
 * more of it after a single pass. Short or highly constrained text — a
 * paragraph of numbers, a list of names — barely carried a signal in the first
 * place.
 */
export function assessRewrite(original: string, rewritten: string): RewriteAssessment {
  const divergence = lexicalDivergence(original, rewritten);
  const wordCount = tokens(rewritten).length;
  const lengthRatio = original.length === 0 ? 1 : rewritten.length / original.length;

  const notes: string[] = [
    'A rewrite changes word choice, which is what a token-sampling watermark is carried in. How much signal remains cannot be measured without the scheme key.',
  ];

  let residualRisk: ResidualRisk;
  if (divergence < 0.2) {
    residualRisk = 'higher';
    notes.push(
      `Only ${(divergence * 100).toFixed(0)}% of word pairs changed. The text is close to the original; run another pass or a stronger mode.`,
    );
  } else if (wordCount > 400) {
    residualRisk = 'higher';
    notes.push(
      'Long passages carry more signal than a single pass typically disturbs. Consider a second pass with a different mode.',
    );
  } else if (wordCount < 60) {
    residualRisk = 'lower';
    notes.push('Short samples carry little statistical signal either way.');
  } else {
    residualRisk = 'moderate';
  }

  if (lengthRatio > 1.6 || lengthRatio < 0.6) {
    notes.push(
      `Length changed by ${((lengthRatio - 1) * 100).toFixed(0)}%. Check that nothing was summarised away or padded in.`,
    );
  }

  notes.push(
    'This is not a detection result. Nothing here can tell you whether a vendor detector would still fire.',
  );

  return { divergence, lengthRatio, wordCount, residualRisk, notes };
}
