#!/usr/bin/env node
/**
 * Change the npm scope across the whole repository.
 *
 * An npm scope is an organisation or a username you own, so a scoped name only
 * works if you control the org. This rewrites every package name, every
 * cross-package dependency, and every mention in the docs and workflows, so
 * switching scope is one command instead of an afternoon of find-and-replace
 * with three things missed.
 *
 * The current scope is read from `packages/core/package.json` rather than
 * hardcoded, so the script stays correct after it has been used once.
 *
 *   node scripts/rename-scope.mjs @dhirender      # -> @unmarkk/core
 *   node scripts/rename-scope.mjs unmark-         # -> unmark-core (unscoped)
 *   node scripts/rename-scope.mjs @acme --dry-run
 *
 * The CLI binary stays `unmark` either way — that is set by the `bin` field
 * and has nothing to do with the package name.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['core', 'cli', 'server', 'web'];

/** Whatever prefix the packages currently use, e.g. `@unmarkk` or `unmark-`. */
async function currentPrefix() {
  const name = JSON.parse(await readFile(join(ROOT, 'packages/core/package.json'), 'utf8')).name;
  return name.startsWith('@') ? name.split('/')[0] : name.slice(0, -'core'.length);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.html',
]);

function usage() {
  console.log(`rename-scope — change the npm scope across the repository

USAGE
  node scripts/rename-scope.mjs <new-prefix> [--dry-run]

EXAMPLES
  node scripts/rename-scope.mjs @dhirender   ->  @unmarkk/core, @unmarkk/cli
  node scripts/rename-scope.mjs unmark-      ->  unmark-core, unmark-cli
  node scripts/rename-scope.mjs @acme --dry-run

NOTES
  A leading @ means a scope; anything else is treated as a plain name prefix.
  The 'unmark' CLI binary name is unaffected.
`);
}

/** `@unmarkk/core` -> whatever the new prefix implies. */
function rename(prefix, pkg) {
  return prefix.startsWith('@') ? `${prefix}/${pkg}` : `${prefix}${pkg}`;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) yield full;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const prefix = positionals[0];
  if (values.help === true || prefix === undefined) {
    usage();
    return prefix === undefined ? 2 : 0;
  }

  const current = await currentPrefix();
  if (prefix === current) {
    console.log(`Already using ${current}. Nothing to do.`);
    return 0;
  }

  // Longest first, so a full `@scope/core` is replaced before any shorter
  // string that happens to be a prefix of it.
  const replacements = PACKAGES.map((pkg) => [rename(current, pkg), rename(prefix, pkg)]).sort(
    (a, b) => b[0].length - a[0].length,
  );

  console.log('Renaming:');
  for (const [from, to] of replacements) console.log(`  ${from}  ->  ${to}`);
  console.log('');

  let changed = 0;
  for await (const file of walk(ROOT)) {
    const original = await readFile(file, 'utf8');
    let updated = original;
    for (const [from, to] of replacements) updated = updated.split(from).join(to);
    if (updated === original) continue;

    changed += 1;
    console.log(`  ${file.slice(ROOT.length + 1)}`);
    if (values['dry-run'] !== true) await writeFile(file, updated, 'utf8');
  }

  console.log('');
  if (values['dry-run'] === true) {
    console.log(`${changed} file(s) would change. Re-run without --dry-run to apply.`);
    return 0;
  }

  console.log(`${changed} file(s) updated.`);
  console.log('');
  console.log('Next:');
  console.log('  pnpm install     # relink the workspace under the new names');
  console.log('  pnpm check       # confirm nothing broke');
  console.log('  git diff         # read it before committing');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
