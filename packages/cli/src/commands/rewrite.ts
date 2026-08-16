/**
 * `unmark rewrite` — the second layer, for watermarks that are not made of bytes.
 *
 * The invisible-character pass removes carriers you can point at. A token
 * sampling watermark has none: it lives in which words the model chose, spread
 * across the whole passage. The only thing that disturbs it is saying the same
 * thing differently, which means a model, which means this command.
 *
 * It defaults to doing nothing on its own. `--backend print-prompt` writes the
 * prompt to stdout and stops, so you can paste it into whatever you already
 * trust and the text never leaves your machine. Pointing it at a live model is
 * opt-in, and pointing it at a *remote* model takes a second, louder opt-in.
 */

import { basename } from 'node:path';
import {
  assessRewrite,
  buildPrompt,
  cleanText,
  decodeText,
  encodeText,
  rewriteModes,
  selectCandidate,
  type RewriteMode,
} from '@unmarkk/core';
import { CliError, cleanedPath, readInput, readStdin, writeOutput } from '../io.js';
import { err, json, out, style } from '../render.js';
import { BACKENDS, checkEndpoint, runBackend, type BackendName } from '../rewrite-backends.js';

export interface RewriteArgs {
  readonly path: string;
  readonly output?: string;
  readonly mode: RewriteMode;
  readonly backend: BackendName;
  readonly baseUrl: string;
  readonly model: string;
  readonly json: boolean;
  readonly allowRemote: boolean;
  readonly temperature: number;
  readonly timeoutMs: number;
  /** How many candidates to generate; the most-diverged one wins. */
  readonly candidates: number;
  /** Language for the back-translation modes. */
  readonly language: string;
  /** Skip the invisible-character pass that normally brackets the rewrite. */
  readonly noCleanPasses: boolean;
}

export const REWRITE_DEFAULTS = {
  mode: 'paraphrase' as RewriteMode,
  backend: 'print-prompt' as BackendName,
  temperature: 0.8,
  timeoutMs: 300_000,
  candidates: 1,
  language: 'French',
} as const;

/** Exit code: 0 on success, 2 on bad usage. */
export async function runRewrite(args: RewriteArgs): Promise<number> {
  const fromStdin = args.path === '-';
  const data = fromStdin ? await readStdin() : await readInput(args.path);
  const label = fromStdin ? '<stdin>' : args.path;
  const original = decodeText(data);

  if (original.trim() === '') throw new CliError('nothing to rewrite: the input is empty');

  // Layer A first. Removing invisible carriers before the rewrite means the
  // model is not asked to preserve characters that should not be there.
  const beforePass = args.noCleanPasses
    ? { text: original, stats: null }
    : cleanText(original, { normalizeSpaces: true });
  const source = beforePass.text;

  const prompt = buildPrompt(args.mode, source, { language: args.language });

  if (args.backend === 'print-prompt') {
    if (args.json) {
      json({
        input: label,
        mode: args.mode,
        backend: args.backend,
        prompt,
        note: 'No model was contacted. Run this prompt wherever you like and feed the result back through `unmark clean`.',
      });
      return 0;
    }

    out(prompt);
    err('');
    err(style.dim('— no model was contacted; the text above never left this machine.'));
    err(
      style.dim(
        '  Run it through a model of your choosing, then clean the result with `unmark clean`.',
      ),
    );
    return 0;
  }

  const warning = checkEndpoint(args.baseUrl, args.allowRemote);
  if (warning !== null && !args.json) err(style.yellow(`warning: ${warning}`));

  const backendOptions = {
    backend: args.backend,
    baseUrl: args.baseUrl,
    model: args.model,
    timeoutMs: args.timeoutMs,
    allowRemote: args.allowRemote,
    temperature: args.temperature,
  };

  const count = Math.max(1, args.candidates);
  if (!args.json) {
    err(
      style.dim(
        `rewriting with ${args.model} via ${args.backend}${count > 1 ? ` (${count} candidates)` : ''}…`,
      ),
    );
  }

  const generated: string[] = [];
  for (let i = 0; i < count; i += 1) {
    generated.push((await runBackend(prompt, backendOptions)).trim());
  }

  const { best, all } = selectCandidate(source, generated);

  // Layer A again: a model can reintroduce invisible characters, and some of
  // them arrive as watermarks in their own right.
  const afterPass = args.noCleanPasses
    ? { text: best.text, stats: null }
    : cleanText(best.text, { normalizeSpaces: true });

  const assessment = assessRewrite(original, afterPass.text);
  const destination = args.output ?? (fromStdin ? '-' : cleanedPath(args.path, '.rewritten'));

  if (destination === '-') {
    process.stdout.write(afterPass.text.endsWith('\n') ? afterPass.text : `${afterPass.text}\n`);
  } else {
    await writeOutput(destination, encodeText(afterPass.text));
  }

  if (args.json) {
    json({
      input: label,
      output: destination,
      mode: args.mode,
      backend: args.backend,
      model: args.model,
      candidates: all.map((c) => ({
        divergence: Number(c.divergence.toFixed(4)),
        lengthRatio: Number(c.lengthRatio.toFixed(3)),
      })),
      unicodePassRemoved:
        (beforePass.stats?.removedCount ?? 0) + (afterPass.stats?.removedCount ?? 0),
      assessment: {
        ...assessment,
        divergence: Number(assessment.divergence.toFixed(4)),
        lengthRatio: Number(assessment.lengthRatio.toFixed(3)),
      },
    });
    return 0;
  }

  const riskColour =
    assessment.residualRisk === 'higher'
      ? style.yellow
      : assessment.residualRisk === 'lower'
        ? style.green
        : style.blue;

  out('');
  out(`${style.bold(label)} ${style.dim('->')} ${style.bold(destination)}`);
  out(
    `  ${(assessment.divergence * 100).toFixed(0)}% of word pairs changed · ` +
      `${assessment.wordCount} words · residual signal ${riskColour(assessment.residualRisk)}`,
  );
  if (all.length > 1) {
    out(style.dim(`  picked the most-diverged of ${all.length} candidates`));
  }
  const removed = (beforePass.stats?.removedCount ?? 0) + (afterPass.stats?.removedCount ?? 0);
  if (removed > 0) {
    out(style.dim(`  invisible-character passes removed ${removed} character(s)`));
  }
  out('');
  for (const note of assessment.notes) out(style.dim(`  ${note}`));
  out('');

  return 0;
}

/** `unmark rewrite --list` — show the modes and backends. */
export function listRewriteOptions(): number {
  out(style.bold('Modes'));
  for (const { mode, summary } of rewriteModes()) {
    out(`  ${style.cyan(mode.padEnd(20))} ${summary}`);
  }
  out('');
  out(style.bold('Backends'));
  for (const backend of BACKENDS) {
    const suffix =
      backend.defaultBaseUrl === undefined ? '' : style.dim(` (default ${backend.defaultBaseUrl})`);
    out(`  ${style.cyan(backend.name.padEnd(20))} ${backend.summary}${suffix}`);
  }
  out('');
  out(
    style.dim('  API keys are read from UNMARK_REWRITE_API_KEY only, never from the command line.'),
  );
  out(style.dim('  Non-loopback endpoints require --allow-remote.'));
  return 0;
}

/** Used by the argument parser to validate `--mode`. */
export function asRewriteMode(value: string | undefined): RewriteMode {
  const modes = rewriteModes().map((m) => m.mode);
  if (value === undefined) return REWRITE_DEFAULTS.mode;
  if ((modes as readonly string[]).includes(value)) return value as RewriteMode;
  throw new CliError(`--mode must be one of: ${modes.join(', ')}`);
}

/** Used by the argument parser to validate `--backend`. */
export function asBackendName(value: string | undefined): BackendName {
  if (value === undefined) return REWRITE_DEFAULTS.backend;
  const names = BACKENDS.map((b) => b.name);
  if ((names as readonly string[]).includes(value)) return value as BackendName;
  throw new CliError(`--backend must be one of: ${names.join(', ')}`);
}

/** Default output path stem for a rewritten file. */
export function rewrittenName(path: string): string {
  return basename(cleanedPath(path, '.rewritten'));
}
