/**
 * Terminal output.
 *
 * Reports go to stdout so they can be piped; progress and warnings go to
 * stderr so they do not corrupt a `--json` pipeline. Colour is disabled
 * whenever output is redirected or `NO_COLOR` is set.
 */

import type { Action, CleanResult, Confidence, Finding, InspectReport } from '@unmarkk/core';
import { describePrivacy, summarise } from '@unmarkk/core';

const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY === true;

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

const CONFIDENCE_STYLE: Record<Confidence, (s: string) => string> = {
  confirmed: style.red,
  probable: style.yellow,
  informational: style.blue,
  'likely-false-positive': style.dim,
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: 'confirmed',
  probable: 'probable',
  informational: 'info',
  'likely-false-positive': 'unreliable',
};

/**
 * Pad to a visible width, ignoring ANSI escapes.
 *
 * `String.padEnd` counts the escape sequences as characters, so a coloured
 * label comes out short by however many bytes the colour cost.
 */
export function padVisible(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\u001b\[[0-9;]*m/g, '').length;
  return text + ' '.repeat(Math.max(0, width - visible));
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

export function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function renderFinding(finding: Finding): string {
  const tag = CONFIDENCE_STYLE[finding.confidence](`[${CONFIDENCE_LABEL[finding.confidence]}]`);
  const where = finding.at === undefined ? '' : style.dim(` (${finding.at})`);
  return `  ${tag} ${finding.message}${where}`;
}

/** Print a human-readable inspection report. */
export function renderReport(label: string, report: InspectReport): void {
  const verdict = summarise(report);
  const heading = verdict.flagged ? style.yellow('found') : style.green('clean');

  out(`${style.bold(label)}  ${style.dim(`${report.kind}/${report.format}`)}  ${heading}`);
  out(`  ${verdict.summary}`);

  if (report.kind !== 'text') {
    const privacy = describePrivacy(report.privacy);
    if (privacy.length > 0) {
      out(`  ${style.magenta('identifying metadata:')} ${privacy.join(', ')}`);
    }
  }

  if (report.findings.length > 0) {
    out();
    for (const finding of report.findings) out(renderFinding(finding));
  }

  if (report.kind === 'text' && report.stylometry !== undefined) {
    const s = report.stylometry;
    out();
    out(`  ${style.bold('stylometry')}  ${s.level}  score ${s.score.toFixed(3)}`);
    if (s.status === 'insufficient-length') {
      out(`  ${style.dim(`sample too short (${s.wordCount} words) for a meaningful score`)}`);
    } else {
      out(
        style.dim(
          `  ${s.wordCount} words, ${s.sentenceCount} sentences, burstiness ${s.burstinessCv.toFixed(3)}, diversity ${s.lexicalDiversity.toFixed(3)}, marker density ${s.markerDensity.toFixed(2)}/100w`,
        ),
      );
    }
  }

  if (report.notes.length > 0) {
    out();
    for (const note of report.notes) out(style.dim(`  note: ${note}`));
  }
  out();
}

/** Print what a clean actually did. */
export function renderClean(label: string, destination: string, result: CleanResult): void {
  const delta = result.bytesIn - result.bytesOut;
  const sizeNote =
    delta > 0
      ? style.green(`-${delta} bytes`)
      : delta < 0
        ? style.yellow(`+${-delta} bytes`)
        : style.dim('same size');

  out(`${style.bold(label)} ${style.dim('->')} ${style.bold(destination)}  ${sizeNote}`);
  for (const action of result.actions) out(`  ${style.cyan('*')} ${action.message}`);

  if (result.kind !== 'text') {
    if (result.degraded) {
      err(
        style.yellow(
          '  warning: the file could not be fully rebuilt, so the clean is best effort — see the actions above',
        ),
      );
    }
    if (result.residual.hasC2pa || result.residual.hasAiMetadata) {
      err(style.yellow('  warning: provenance signals remain in the output:'));
      for (const finding of result.residual.findings) err(renderFinding(finding));
    }
  }
  out();
}

/** Actions rendered without a heading, for the JSON-free clean summary. */
export function renderActions(actions: readonly Action[]): void {
  for (const action of actions) out(`  ${style.cyan('*')} ${action.message}`);
}
