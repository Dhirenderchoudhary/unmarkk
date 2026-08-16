#!/usr/bin/env node
/**
 * Set one version across every package.
 *
 * The three published packages release together and share a version, which
 * makes "which versions work with each other" a non-question. This keeps them
 * in step, including the `VERSION` constant the CLI and the HTTP API report —
 * a `--version` that disagrees with the package is a genuinely confusing bug
 * to chase.
 *
 *   node scripts/set-version.mjs 1.1.0
 *   node scripts/set-version.mjs patch
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/server/package.json',
  'packages/web/package.json',
];
const VERSION_SOURCE = 'packages/core/src/index.ts';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function bump(current, kind) {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function main() {
  const arg = process.argv[2];
  if (arg === undefined || arg === '-h' || arg === '--help') {
    console.log('usage: node scripts/set-version.mjs <version|major|minor|patch>');
    return arg === undefined ? 2 : 0;
  }

  const rootPath = join(ROOT, 'package.json');
  const current = JSON.parse(await readFile(rootPath, 'utf8')).version;

  const next = ['major', 'minor', 'patch'].includes(arg) ? bump(current, arg) : arg;
  if (!SEMVER.test(next)) {
    console.error(`error: "${next}" is not a valid semver version`);
    return 2;
  }

  console.log(`${current} -> ${next}`);
  console.log('');

  for (const relative of MANIFESTS) {
    const path = join(ROOT, relative);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.version = next;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`  ${relative}`);
  }

  // The engine reports its own version over the HTTP API and in `--version`.
  // Leaving it behind produces a binary that lies about what it is.
  const sourcePath = join(ROOT, VERSION_SOURCE);
  const source = await readFile(sourcePath, 'utf8');
  const updated = source.replace(
    /export const VERSION = '[^']*';/,
    `export const VERSION = '${next}';`,
  );
  if (updated === source) {
    console.error(`\nwarning: could not find the VERSION constant in ${VERSION_SOURCE}`);
  } else {
    await writeFile(sourcePath, updated, 'utf8');
    console.log(`  ${VERSION_SOURCE}`);
  }

  console.log('');
  console.log('Next:');
  console.log(`  Update CHANGELOG.md for ${next}`);
  console.log('  pnpm check');
  console.log(`  git commit -am "release ${next}" && git tag v${next}`);
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
