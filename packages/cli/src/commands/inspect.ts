/** `unmark inspect` — report what is in a file, change nothing. */

import { inspect, summarise, type InspectOptions, type Kind } from '@unmarkk/core';
import { basename } from 'node:path';
import { readInput, readStdin, CliError } from '../io.js';
import { json, renderReport } from '../render.js';

export interface InspectArgs {
  readonly paths: readonly string[];
  readonly json: boolean;
  readonly stylometry: boolean;
  readonly aggressive: boolean;
  readonly as?: Kind;
  readonly forceText: boolean;
}

/** Exit code: 0 when nothing was found, 1 when something was. */
export async function runInspect(args: InspectArgs): Promise<number> {
  if (args.paths.length === 0)
    throw new CliError('inspect needs at least one path, or - for stdin');

  const reports: unknown[] = [];
  let flagged = false;

  for (const path of args.paths) {
    const fromStdin = path === '-';
    const data = fromStdin ? await readStdin() : await readInput(path);
    const label = fromStdin ? '<stdin>' : path;

    const options: InspectOptions = {
      filename: fromStdin ? undefined : basename(path),
      aggressive: args.aggressive,
      stylometry: args.stylometry,
      forceText: args.forceText,
      ...(args.as === undefined ? {} : { as: args.as }),
    };

    const report = await inspect(data, options);
    const verdict = summarise(report);
    if (verdict.flagged) flagged = true;

    if (args.json) {
      reports.push({ path: label, verdict, report });
    } else {
      renderReport(label, report);
    }
  }

  if (args.json) {
    json(reports.length === 1 ? reports[0] : reports);
  }
  return flagged ? 1 : 0;
}
