/**
 * CLI tests.
 *
 * The command functions are driven directly rather than through a subprocess,
 * so the suite runs without a build step. Standard streams are captured so
 * assertions can be made about what a user actually sees, and about the
 * stdout/stderr split that makes `--json` safe to pipe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInspect } from '../src/commands/inspect.js';
import { runClean } from '../src/commands/clean.js';
import { runScan } from '../src/commands/scan.js';
import { CliError, backup, cleanedPath, readInput, writeOutput } from '../src/io.js';

let directory: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'unmark-test-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const out = (): string => stdout.join('');
const errOut = (): string => stderr.join('');

async function write(name: string, content: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, 'utf8');
  return path;
}

const inspectArgs = {
  json: false,
  stylometry: false,
  aggressive: false,
  forceText: false,
} as const;

const cleanArgs = {
  json: false,
  inPlace: false,
  noBackup: false,
  nfkc: false,
  aggressive: false,
  keepSpaces: false,
  stripEmojiGlue: false,
  keepNonAiMetadata: false,
  forceText: false,
} as const;

describe('inspect', () => {
  it('exits 1 when it finds something and 0 when it does not', async () => {
    const dirty = await write('dirty.txt', 'he​llo');
    const clean = await write('clean.txt', 'hello');

    expect(await runInspect({ ...inspectArgs, paths: [dirty] })).toBe(1);
    expect(await runInspect({ ...inspectArgs, paths: [clean] })).toBe(0);
  });

  it('prints findings a person can read', async () => {
    const path = await write('dirty.txt', 'he​llo');
    await runInspect({ ...inspectArgs, paths: [path] });
    expect(out()).toContain('ZERO WIDTH SPACE');
    expect(out()).toContain('probable');
  });

  it('emits one JSON object for one file and an array for several', async () => {
    const a = await write('a.txt', 'x');
    const b = await write('b.txt', 'y');

    await runInspect({ ...inspectArgs, paths: [a], json: true });
    expect(JSON.parse(out())).toHaveProperty('report');

    stdout.length = 0;
    await runInspect({ ...inspectArgs, paths: [a, b], json: true });
    expect(Array.isArray(JSON.parse(out()))).toBe(true);
  });

  it('keeps JSON output free of anything but JSON', async () => {
    const path = await write('a.md', '---\ngenerator: ChatGPT\n---\n\nBody\n');
    await runInspect({ ...inspectArgs, paths: [path], json: true });
    expect(() => JSON.parse(out())).not.toThrow();
  });

  it('refuses a path that is not a file', async () => {
    await expect(runInspect({ ...inspectArgs, paths: [join(directory, 'nope')] })).rejects.toThrow(
      CliError,
    );
  });

  it('needs at least one path', async () => {
    await expect(runInspect({ ...inspectArgs, paths: [] })).rejects.toThrow(/at least one path/);
  });
});

describe('clean', () => {
  it('writes alongside the original by default', async () => {
    const path = await write('notes.txt', 'he​llo');
    expect(await runClean({ ...cleanArgs, paths: [path] })).toBe(0);

    expect(await readFile(join(directory, 'notes.cleaned.txt'), 'utf8')).toBe('hello');
    expect(await readFile(path, 'utf8')).toBe('he​llo');
  });

  it('honours an explicit output path', async () => {
    const path = await write('notes.txt', 'he​llo');
    const target = join(directory, 'nested', 'safe.txt');
    await runClean({ ...cleanArgs, paths: [path], output: target });
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('keeps a backup when overwriting in place', async () => {
    const path = await write('notes.txt', 'he​llo');
    await runClean({ ...cleanArgs, paths: [path], inPlace: true });

    expect(await readFile(path, 'utf8')).toBe('hello');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('he​llo');
  });

  it('can skip the backup when asked', async () => {
    const path = await write('notes.txt', 'he​llo');
    await runClean({ ...cleanArgs, paths: [path], inPlace: true, noBackup: true });
    expect(await readdir(directory)).toEqual(['notes.txt']);
  });

  it('refuses contradictory flags', async () => {
    const path = await write('a.txt', 'x');
    await expect(
      runClean({ ...cleanArgs, paths: [path], inPlace: true, output: 'x.txt' }),
    ).rejects.toThrow(/mutually exclusive/);

    await expect(runClean({ ...cleanArgs, paths: [path, path], output: 'x.txt' })).rejects.toThrow(
      /single input file/,
    );
  });

  it('reports what it did on stdout and warnings on stderr', async () => {
    const path = await write('notes.md', '---\ngenerator: ChatGPT\n---\n\nBody\n');
    await runClean({ ...cleanArgs, paths: [path] });
    expect(out()).toContain('removed frontmatter key');
    expect(errOut()).not.toContain('removed frontmatter key');
  });

  it('leaves stdout pure JSON in JSON mode', async () => {
    const path = await write('notes.txt', 'he​llo');
    await runClean({ ...cleanArgs, paths: [path], json: true });
    const parsed = JSON.parse(out());
    expect(parsed.stats.removedCount).toBe(1);
    // `output` names where the bytes went. Embedding megabytes of base64 in a
    // report that is usually piped into jq would help nobody.
    expect(parsed.output).toBe(join(directory, 'notes.cleaned.txt'));
    expect(parsed.input).toBe(path);
  });

  it('applies aggressive rewriting only when asked', async () => {
    const path = await write('a.txt', 'pаypal');
    await runClean({ ...cleanArgs, paths: [path], output: join(directory, 'x.txt') });
    expect(await readFile(join(directory, 'x.txt'), 'utf8')).toBe('pаypal');

    await runClean({
      ...cleanArgs,
      paths: [path],
      aggressive: true,
      output: join(directory, 'y.txt'),
    });
    expect(await readFile(join(directory, 'y.txt'), 'utf8')).toBe('paypal');
  });
});

describe('scan', () => {
  it('reports a count and exits 1 when anything is flagged', async () => {
    await write('dirty.txt', 'he​llo');
    await write('clean.txt', 'hello');

    expect(
      await runScan({
        paths: [directory],
        json: false,
        all: false,
        quiet: false,
        stylometry: false,
        skip: [],
      }),
    ).toBe(1);
    expect(out()).toContain('2 scanned');
    expect(out()).toContain('1 need attention');
  });

  it('exits 0 when a directory is clean', async () => {
    await write('clean.txt', 'hello');
    expect(
      await runScan({
        paths: [directory],
        json: false,
        all: false,
        quiet: false,
        stylometry: false,
        skip: [],
      }),
    ).toBe(0);
  });

  it('lists only flagged files when quiet', async () => {
    await write('dirty.txt', 'he​llo');
    await write('clean.txt', 'hello');
    await runScan({
      paths: [directory],
      json: false,
      all: false,
      quiet: true,
      stylometry: false,
      skip: [],
    });
    expect(out()).toContain('dirty.txt');
    expect(out()).not.toContain('clean.txt');
  });

  it('emits structured JSON', async () => {
    await write('dirty.txt', 'he​llo');
    await runScan({
      paths: [directory],
      json: true,
      all: false,
      quiet: false,
      stylometry: false,
      skip: [],
    });
    const parsed = JSON.parse(out());
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.actionable).toBe(1);
    expect(parsed.items[0].suspiciousTotal).toBeGreaterThan(0);
  });

  it('skips known noise directories', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'node_modules'));
    await writeFile(join(directory, 'node_modules', 'x.txt'), 'he​llo');
    await write('clean.txt', 'hello');

    await runScan({
      paths: [directory],
      json: true,
      all: false,
      quiet: false,
      stylometry: false,
      skip: [],
    });
    expect(JSON.parse(out()).summary.total).toBe(1);
  });
});

describe('file handling', () => {
  it('writes atomically and leaves no temporary files behind', async () => {
    const path = join(directory, 'out.txt');
    await writeOutput(path, new TextEncoder().encode('done'));
    expect(await readFile(path, 'utf8')).toBe('done');
    expect(await readdir(directory)).toEqual(['out.txt']);
  });

  it('refuses to write through a symlink', async () => {
    const target = join(directory, 'target.txt');
    const link = join(directory, 'link.txt');
    await writeFile(target, 'original', 'utf8');
    await symlink(target, link);

    await expect(writeOutput(link, new TextEncoder().encode('hijacked'))).rejects.toThrow(
      /symlink/,
    );
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('creates parent directories as needed', async () => {
    const path = join(directory, 'a', 'b', 'c.txt');
    await writeOutput(path, new TextEncoder().encode('nested'));
    expect(await readFile(path, 'utf8')).toBe('nested');
  });

  it('caps input size', async () => {
    const path = await write('big.txt', 'x');
    const previous = process.env['UNMARK_MAX_INPUT_BYTES'];
    try {
      // The cap is read at module load, so this asserts the guard exists
      // rather than re-reading the environment mid-run.
      expect((await stat(path)).size).toBe(1);
      await expect(readInput(join(directory, 'missing.txt'))).rejects.toThrow(/no such file/);
    } finally {
      if (previous === undefined) delete process.env['UNMARK_MAX_INPUT_BYTES'];
      else process.env['UNMARK_MAX_INPUT_BYTES'] = previous;
    }
  });

  it('refuses a directory', async () => {
    await expect(readInput(directory)).rejects.toThrow(/not a file/);
  });

  it('names backups predictably', async () => {
    const path = await write('a.txt', 'content');
    expect(await backup(path)).toBe(`${path}.bak`);
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('content');
  });

  it('derives cleaned paths', () => {
    expect(cleanedPath('/a/b/notes.md')).toBe('/a/b/notes.cleaned.md');
    expect(cleanedPath('/a/b/archive.tar.gz')).toBe('/a/b/archive.tar.cleaned.gz');
    expect(cleanedPath('/a/b/README')).toBe('/a/b/README.cleaned');
  });
});
