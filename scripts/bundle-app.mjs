#!/usr/bin/env node
/**
 * Copy the built browser app into the server package.
 *
 * `unmark-server` serves the app from `/`, so the static files have to travel
 * inside the published tarball. They are built by `@unmarkk/web` and copied
 * here rather than duplicated, so there is one source for the app.
 *
 * The app is optional: if it has not been built, the server still runs and
 * serves the API, and the index page explains what is available. That keeps a
 * partial checkout working instead of failing at startup.
 */

import { cp, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'packages/web/dist');
const TARGET = join(ROOT, 'packages/server/dist/app');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function totalBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? await totalBytes(full) : (await stat(full)).size;
  }
  return total;
}

if (!(await exists(join(SOURCE, 'index.html')))) {
  console.log('  app not built — server will serve the API only');
  console.log('  run: pnpm --filter @unmarkk/web build');
  process.exit(0);
}

await rm(TARGET, { recursive: true, force: true });
await cp(SOURCE, TARGET, { recursive: true });

const bytes = await totalBytes(TARGET);
console.log(`  bundled the browser app (${(bytes / 1024).toFixed(0)} KB)`);
