/** `unmark clean` — write a copy with the metadata removed. */

import { clean, type CleanOptions, type Kind } from '@unmarkk/core';
import { basename } from 'node:path';
import { backup, cleanedPath, readInput, readStdin, writeOutput, CliError } from '../io.js';
import { err, json, renderClean, style } from '../render.js';

export interface CleanArgs {
  readonly paths: readonly string[];
  readonly output?: string;
  readonly inPlace: boolean;
  readonly json: boolean;
  readonly nfkc: boolean;
  readonly aggressive: boolean;
  readonly keepNonAiMetadata: boolean;
  readonly stripEmojiGlue: boolean;
  readonly keepSpaces: boolean;
  readonly as?: Kind;
  readonly forceText: boolean;
  readonly noBackup: boolean;
}

/** Exit code: 0 on success, 1 when provenance signals survive the clean. */
export async function runClean(args: CleanArgs): Promise<number> {
  if (args.paths.length === 0) throw new CliError('clean needs at least one path, or - for stdin');
  if (args.output !== undefined && args.paths.length > 1) {
    throw new CliError('--output takes a single input file; use --in-place for several');
  }
  if (args.output !== undefined && args.inPlace) {
    throw new CliError('--output and --in-place are mutually exclusive');
  }

  const results: unknown[] = [];
  let residual = false;

  for (const path of args.paths) {
    const fromStdin = path === '-';
    if (fromStdin && args.inPlace) throw new CliError('--in-place cannot be used with stdin');

    const data = fromStdin ? await readStdin() : await readInput(path);
    const label = fromStdin ? '<stdin>' : path;

    const options: CleanOptions = {
      filename: fromStdin ? undefined : basename(path),
      nfkc: args.nfkc,
      aggressive: args.aggressive,
      aggressiveHomoglyphs: args.aggressive,
      normalizeSpaces: !args.keepSpaces,
      stripEmojiGlue: args.stripEmojiGlue,
      stripAllMetadata: !args.keepNonAiMetadata,
      forceText: args.forceText,
      ...(args.as === undefined ? {} : { as: args.as }),
    };

    const result = await clean(data, options);
    if (result.kind !== 'text' && (result.residual.hasC2pa || result.residual.hasAiMetadata)) {
      residual = true;
    }

    // Write the original aside before anything replaces it, so an interrupted
    // in-place run still leaves a recoverable copy.
    let destination: string;
    if (fromStdin && !args.inPlace && args.output === undefined) {
      process.stdout.write(result.output);
      destination = '<stdout>';
    } else if (args.inPlace) {
      if (!args.noBackup) {
        const saved = await backup(path);
        if (!args.json) err(style.dim(`  original saved as ${saved}`));
      }
      await writeOutput(path, result.output);
      destination = path;
    } else {
      destination = args.output ?? cleanedPath(path);
      await writeOutput(destination, result.output);
    }

    if (args.json) {
      const { output, ...rest } = result;
      results.push({ input: label, output: destination, ...rest });
    } else if (destination !== '<stdout>') {
      renderClean(label, destination, result);
    }
  }

  if (args.json) {
    json(results.length === 1 ? results[0] : results);
  }
  return residual ? 1 : 0;
}
