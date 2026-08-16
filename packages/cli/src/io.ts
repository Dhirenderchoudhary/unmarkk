/**
 * File access for the CLI, with the safety properties the engine cannot
 * provide because the engine never touches a file system.
 *
 * Three things matter here:
 *
 *   - Writes are atomic. A cleaned file is written to a temporary name in the
 *     same directory and renamed into place, so an interrupted run can never
 *     leave a half-written document where the original used to be.
 *   - Writes never follow symlinks. A pre-placed symlink in a downloads or
 *     temp directory would otherwise redirect a clean straight onto whatever
 *     it points at.
 *   - Inputs are capped. Every engine works on whole files in memory, so an
 *     uncapped read is a way to exhaust host memory with one large file.
 */

import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Default input cap. Override with `UNMARK_MAX_INPUT_BYTES`. */
export const MAX_INPUT_BYTES = Number(process.env['UNMARK_MAX_INPUT_BYTES'] ?? 256 * 1024 * 1024);
/** Default stdin cap. Override with `UNMARK_MAX_STDIN_BYTES`. */
export const MAX_STDIN_BYTES = Number(process.env['UNMARK_MAX_STDIN_BYTES'] ?? 64 * 1024 * 1024);

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Read a file, refusing anything past the size cap. */
export async function readInput(path: string): Promise<Uint8Array> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new CliError(`cannot read ${path}: no such file`);
  }
  if (!info.isFile()) throw new CliError(`not a file: ${path}`);
  if (info.size > MAX_INPUT_BYTES) {
    throw new CliError(
      `refusing to read ${path}: ${info.size} bytes exceeds the ${MAX_INPUT_BYTES} byte cap (raise UNMARK_MAX_INPUT_BYTES to override)`,
    );
  }
  return new Uint8Array(await readFile(path));
}

/** Read all of stdin, refusing anything past the size cap. */
export async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw new CliError(`refusing stdin input larger than ${MAX_STDIN_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Write bytes atomically, refusing to write through a symlink.
 *
 * `rename` replaces a symlink rather than following it, so the explicit check
 * exists to produce a clear error instead of a surprising outcome.
 */
export async function writeOutput(path: string, data: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new CliError(`refusing to write through a symlink: ${path}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    // Not existing is the normal case.
  }

  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.write(data);
    // Flush before the rename, so a crash cannot leave an empty file in place
    // of the original on file systems that reorder the two.
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Copy a file to `<name>.bak` before it is overwritten in place. */
export async function backup(path: string): Promise<string> {
  const target = `${path}.bak`;
  await copyFile(path, target);
  return target;
}

/** `notes.md` -> `notes.cleaned.md`, keeping the extension where a viewer expects it. */
export function cleanedPath(path: string, suffix = '.cleaned'): string {
  const ext = extname(path);
  const base = ext === '' ? path : path.slice(0, -ext.length);
  return `${base}${suffix}${ext}`;
}
