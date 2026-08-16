/**
 * Stylometric scoring — a heuristic, and labelled as one everywhere it surfaces.
 *
 * There is no reliable way to prove text was machine-written. What this does is
 * measure three things that machine-written text tends to do: keep sentence
 * lengths unnaturally even (low burstiness), lean on a small set of formulaic
 * transitions, and cluster in a narrow band of lexical diversity. A high score
 * means "this reads like model output", never "this is model output" — the
 * report says so, and the score is dampened hard on short samples where the
 * statistics simply do not hold.
 *
 * Nothing here removes anything. It exists so you can tell whether the
 * character-level pass found everything there was to find, or whether the only
 * remaining signal is one no amount of byte editing will touch.
 */

import type { Finding, StylometryLevel, StylometryMarker, StylometryReport } from '../types.js';

export const DEFAULT_THRESHOLD = 0.65;
const MIN_SAMPLE_WORDS = 30;
const FULL_WEIGHT_WORDS = 100;
const MATTR_WINDOW = 50;

interface PhrasePattern {
  readonly pattern: RegExp;
  readonly label: string;
  readonly weight: number;
}

/**
 * Formulaic phrases overrepresented in model output across vendors.
 *
 * Weights are editorial, not learned: "as an AI" is near-conclusive, whereas
 * "furthermore," is something people write all the time. Treat the list as a
 * smell test that happens to be cheap, not as a classifier.
 */
const PHRASE_PATTERNS: readonly PhrasePattern[] = [
  { pattern: /\bdelve(?:s|d)?\s+into\b/gi, label: 'delve into', weight: 1.2 },
  { pattern: /\ba\s+testament\s+to\b/gi, label: 'a testament to', weight: 1.1 },
  { pattern: /\brich\s+tapestry(?:\s+of)?\b/gi, label: 'rich tapestry', weight: 1.3 },
  {
    pattern: /\bplays?\s+a\s+(?:pivotal|crucial|vital|key)\s+role\b/gi,
    label: 'plays a pivotal role',
    weight: 1.0,
  },
  {
    pattern:
      /\bin\s+(?:today'?s|the)\s+(?:(?:fast-paced|ever-evolving|digital|rapidly\s+changing)\s+)*(?:world|landscape|era|environment)\b/gi,
    label: "in today's fast-paced world",
    weight: 1.4,
  },
  {
    pattern:
      /\bit\s+is\s+(?:important|essential|crucial|worth\s+noting)\s+to\s+(?:note|remember|consider|highlight)\b/gi,
    label: 'it is important to note',
    weight: 0.9,
  },
  {
    pattern: /\bnot\s+only\b[\w\s,]+\bbut\s+(?:also\s+)?(?:serves\s+to|acts\s+as|highlights)\b/gi,
    label: 'not only … but also serves to',
    weight: 0.8,
  },
  {
    pattern: /\bserve(?:s|d)?\s+as\s+a\s+(?:beacon|reminder|catalyst|cornerstone)\b/gi,
    label: 'serves as a beacon/catalyst',
    weight: 1.1,
  },
  {
    pattern: /\bunderscore(?:s|d)?\s+the\s+(?:importance|need|significance)\b/gi,
    label: 'underscores the importance',
    weight: 0.9,
  },
  {
    pattern: /\bfoster(?:s|ing|ed)?\s+a\s+(?:sense|culture|deeper\s+understanding)\b/gi,
    label: 'fosters a sense/culture',
    weight: 0.9,
  },
  {
    pattern: /\bseamlessly\s+(?:integrates?|integrated|blends?|combine[sd]?)\b/gi,
    label: 'seamlessly integrates',
    weight: 1.0,
  },
  {
    pattern: /\bnavigat(?:e|ing|es|ed)\s+the\s+(?:complexities|intricacies|nuances)\b/gi,
    label: 'navigating the complexities',
    weight: 1.0,
  },
  {
    pattern: /\bmultifaceted\s+(?:nature|approach|landscape)\b/gi,
    label: 'multifaceted nature',
    weight: 1.0,
  },
  {
    pattern: /\bharness(?:ing|ed|es)?\s+the\s+power\s+of\b/gi,
    label: 'harnessing the power of',
    weight: 1.0,
  },
  { pattern: /\ba\s+myriad\s+of\b/gi, label: 'a myriad of', weight: 0.8 },
  { pattern: /\bparadigm\s+shift\b/gi, label: 'paradigm shift', weight: 0.9 },
  {
    pattern: /\bholistic\s+(?:approach|view|perspective)\b/gi,
    label: 'holistic approach',
    weight: 0.9,
  },
  { pattern: /\bin\s+conclusion\b[,\s]/gi, label: 'in conclusion', weight: 0.8 },
  { pattern: /\bto\s+summarize\b[,\s]/gi, label: 'to summarize', weight: 0.8 },
  { pattern: /\bultimately\b[,\s]/gi, label: 'ultimately,', weight: 0.6 },
  { pattern: /\bfurthermore\b[,\s]/gi, label: 'furthermore,', weight: 0.6 },
  { pattern: /\bmoreover\b[,\s]/gi, label: 'moreover,', weight: 0.6 },
  { pattern: /\bas\s+an\s+ai\b/gi, label: 'as an AI', weight: 1.5 },
  { pattern: /\bi\s+hope\s+this\s+helps\b/gi, label: 'I hope this helps', weight: 1.2 },
];

const RE_WORDS = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

/** Tokenise into lowercase word forms. */
export function extractWords(text: string): string[] {
  return [...text.matchAll(RE_WORDS)].map((m) => m[0].toLowerCase());
}

/**
 * Split into sentences, skipping fenced code blocks.
 *
 * Code has wildly different length statistics than prose and would otherwise
 * dominate the burstiness measure on any technical document.
 */
export function extractSentences(text: string): string[] {
  const lines: string[] = [];
  let inCodeBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || trimmed === '') continue;
    lines.push(trimmed);
  }
  const joined = lines.join('\n');
  if (joined.trim() === '') return [];
  return joined
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Coefficient of variation of sentence word-length. Low means machine-even. */
export function burstiness(sentences: readonly string[]): number {
  const lengths = sentences.map((s) => extractWords(s).length).filter((n) => n > 0);
  if (lengths.length < 2) return 0;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (mean <= 0) return 0;
  const variance = lengths.reduce((a, x) => a + (x - mean) ** 2, 0) / (lengths.length - 1);
  return Math.sqrt(variance) / mean;
}

/**
 * Moving-average type-token ratio.
 *
 * Plain TTR falls as a document grows, so long human essays would score as
 * "low diversity" purely for being long. A sliding window removes the length
 * dependency, which is the whole reason to prefer it here.
 */
export function mattr(words: readonly string[], windowSize = MATTR_WINDOW): number {
  const n = words.length;
  if (n === 0) return 0;
  if (n <= windowSize) return new Set(words).size / n;

  const counts = new Map<string, number>();
  for (let i = 0; i < windowSize; i += 1) {
    const w = words[i]!;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let total = counts.size / windowSize;
  const windows = n - windowSize + 1;

  for (let i = 1; i < windows; i += 1) {
    const leaving = words[i - 1]!;
    const entering = words[i + windowSize - 1]!;
    const left = counts.get(leaving)! - 1;
    if (left === 0) counts.delete(leaving);
    else counts.set(leaving, left);
    counts.set(entering, (counts.get(entering) ?? 0) + 1);
    total += counts.size / windowSize;
  }
  return total / windows;
}

/** Find and tally formulaic phrases. */
export function scanPhrases(text: string): StylometryMarker[] {
  const markers: StylometryMarker[] = [];
  for (const { pattern, label, weight } of PHRASE_PATTERNS) {
    const found = [...text.matchAll(pattern)].map((m) => m[0]);
    if (found.length > 0) {
      markers.push({ phrase: label, count: found.length, weight, samples: found.slice(0, 3) });
    }
  }
  return markers;
}

function burstinessSubscore(cv: number): number {
  if (cv < 0.25) return 0.95;
  if (cv < 0.35) return 0.8;
  if (cv < 0.45) return 0.5;
  if (cv < 0.55) return 0.25;
  return 0.05;
}

function densitySubscore(density: number): number {
  if (density >= 2.0) return 1.0;
  if (density >= 1.0) return 0.75;
  if (density >= 0.5) return 0.45;
  return density > 0 ? 0.2 : 0.0;
}

function levelOf(score: number): StylometryLevel {
  if (score >= 0.75) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score >= 0.25) return 'LOW';
  return 'CLEAN';
}

/** Score text for machine-authorship style signals. */
export function scoreStylometry(text: string): StylometryReport {
  const words = extractWords(text);
  const wordCount = words.length;
  const sentences = extractSentences(text);
  const markers = scanPhrases(text);

  const findings: Finding[] = [];
  const notes: string[] = [
    'Stylometry is a heuristic. It measures how text reads, not how it was produced.',
  ];

  if (wordCount < MIN_SAMPLE_WORDS) {
    for (const m of markers) {
      findings.push({
        code: 'text.stylometry.phrase',
        message: `formulaic phrase "${m.phrase}" x${m.count}`,
        confidence: 'informational',
      });
    }
    notes.push(
      `Sample is ${wordCount} words; below ${MIN_SAMPLE_WORDS} the statistics are meaningless, so no score is reported.`,
    );
    return {
      wordCount,
      sentenceCount: sentences.length,
      burstinessCv: 0,
      lexicalDiversity: mattr(words),
      markerDensity: 0,
      markers,
      score: 0,
      level: 'CLEAN',
      status: 'insufficient-length',
      findings,
      notes,
    };
  }

  const cv = burstiness(sentences);
  const diversity = mattr(words);
  const weighted = markers.reduce((a, m) => a + m.count * m.weight, 0);
  const density = weighted / (wordCount / 100);

  // Models cluster tightly around 0.68–0.76 MATTR at a 50-word window. Being
  // inside that band is mild evidence; being outside it is mild counter-evidence.
  const diversitySubscore = diversity >= 0.68 && diversity <= 0.76 ? 0.4 : 0.1;
  const composite =
    burstinessSubscore(cv) * 0.45 + densitySubscore(density) * 0.45 + diversitySubscore * 0.1;

  let dampener = 1;
  if (wordCount < FULL_WEIGHT_WORDS) {
    dampener =
      0.4 + 0.6 * ((wordCount - MIN_SAMPLE_WORDS) / (FULL_WEIGHT_WORDS - MIN_SAMPLE_WORDS));
    notes.push(
      `Sample is ${wordCount} words, inside the ${MIN_SAMPLE_WORDS}–${FULL_WEIGHT_WORDS} calibration range; score dampened by ${dampener.toFixed(2)}.`,
    );
  }

  const score = Math.min(1, Math.max(0, composite * dampener));

  for (const m of markers) {
    findings.push({
      code: 'text.stylometry.phrase',
      message: `formulaic phrase "${m.phrase}" x${m.count}`,
      confidence: 'informational',
    });
  }
  if (cv < 0.35 && sentences.length >= 3) {
    findings.push({
      code: 'text.stylometry.burstiness',
      message: `sentence lengths are unusually even (CV ${cv.toFixed(2)} < 0.35)`,
      confidence: 'informational',
    });
  }
  if (density >= 1.0) {
    findings.push({
      code: 'text.stylometry.density',
      message: `formulaic phrase density ${density.toFixed(2)} per 100 words`,
      confidence: 'informational',
    });
  }

  return {
    wordCount,
    sentenceCount: sentences.length,
    burstinessCv: round(cv),
    lexicalDiversity: round(diversity),
    markerDensity: round(density),
    markers,
    score: round(score),
    level: levelOf(score),
    status: 'ok',
    findings,
    notes,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
