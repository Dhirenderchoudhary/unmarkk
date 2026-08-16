/**
 * `unmark backends` — what optional heavy backends are installed.
 *
 * Everything unmark does by itself is deterministic parsing. These four are
 * different: they need model weights, they change the file rather than editing
 * its metadata, and none of them ships with the tool.
 *
 * The command reports what is actually usable right now, not what the project
 * theoretically supports. A capability list that overstates itself leads people
 * to promise things they cannot deliver.
 */

import { allBackendStatus, setupInstructions } from '../backends.js';
import { json, out, padVisible, style } from '../render.js';

export interface BackendsArgs {
  readonly json: boolean;
  /** Print installation instructions for whatever is missing. */
  readonly setup: boolean;
}

export async function runBackends(args: BackendsArgs): Promise<number> {
  const statuses = await allBackendStatus();

  if (args.json) {
    json(
      statuses.map((status) => ({
        id: status.spec.id,
        title: status.spec.title,
        what: status.spec.what,
        envVar: status.spec.envVar,
        configured: status.configured,
        available: status.available,
        directory: status.directory ?? null,
        problem: status.problem ?? null,
        caveat: status.spec.caveat,
      })),
    );
    return 0;
  }

  out(style.bold('Optional backends'));
  out(
    style.dim(
      '  None of these ship with unmark. Each is a separate project you install and point an\n' +
        '  environment variable at. Everything unmark does without them is deterministic parsing.',
    ),
  );
  out('');

  for (const status of statuses) {
    const badge = status.available
      ? style.green('ready')
      : status.configured
        ? style.yellow('broken')
        : style.dim('not set up');

    const indent = ' '.repeat(13);
    out(`  ${padVisible(badge, 11)} ${style.bold(status.spec.title)}`);
    out(`${indent}${style.dim(status.spec.what)}`);

    if (status.available) {
      out(`${indent}${style.dim(`${status.directory}`)}`);
    } else if (status.configured) {
      out(`${indent}${style.yellow(status.problem ?? 'unavailable')}`);
    } else {
      out(`${indent}${style.dim(`set ${status.spec.envVar} to enable`)}`);
    }
    out('');
  }

  const missing = statuses.filter((s) => !s.available);
  if (args.setup && missing.length > 0) {
    out(style.bold('Setting them up'));
    out('');
    for (const status of missing) {
      for (const line of setupInstructions(status.spec)) out(`  ${line}`);
      out('');
    }
  } else if (missing.length > 0) {
    out(style.dim('  Run `unmark backends --setup` for installation instructions.'));
    out('');
  }

  out(
    style.dim(
      '  Note: the pixel backends regenerate the image rather than editing metadata.\n' +
        '  The result is a different image. For most privacy work, `unmark clean` is what you want.',
    ),
  );

  return 0;
}
