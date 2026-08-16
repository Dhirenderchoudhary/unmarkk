/**
 * Optional external backends.
 *
 * Four capabilities cannot be done in TypeScript, and pretending otherwise
 * would be the dishonest option:
 *
 *   - **Pixel-domain watermark removal** needs a diffusion model. Removing a
 *     mark embedded in the image data means regenerating the image, which needs
 *     several gigabytes of weights and a GPU to be tolerable.
 *   - **Token-sampling watermark detection** needs the same language model the
 *     text was generated with, plus the scheme's key.
 *   - **SynthID-class image scoring** needs a trained detector.
 *
 * So they stay external. Each is a Python project you install yourself, point
 * an environment variable at, and this module invokes as a subprocess — which
 * is exactly the arrangement the project has always had; it is just written
 * down properly here.
 *
 * Nothing is bundled, nothing is downloaded, and nothing is enabled by default.
 * `unmark backends` tells you what is actually present rather than what is
 * theoretically supported, because a capability list that lies is worse than no
 * capability list.
 *
 * A warning worth repeating where the code is: regenerating an image to remove
 * a watermark **changes the image**. It is not a metadata edit. Fine detail
 * moves, and for photographs of people that can matter.
 */

import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type BackendId = 'ctrlregen' | 'diffusion' | 'markllm' | 'synthid';

export interface BackendSpec {
  readonly id: BackendId;
  readonly title: string;
  readonly what: string;
  /** Environment variable naming the checkout directory. */
  readonly envVar: string;
  /** A path inside the checkout that proves it is the right project. */
  readonly marker: string;
  /** Upstream project, for the setup instructions. */
  readonly upstream: string;
  readonly caveat: string;
}

export const BACKEND_SPECS: readonly BackendSpec[] = [
  {
    id: 'ctrlregen',
    title: 'CtrlRegen',
    what: 'Removes pixel-domain image watermarks by controllable regeneration.',
    envVar: 'UNMARK_CTRLREGEN_DIR',
    marker: 'requirements.txt',
    upstream: 'https://github.com/hlzhang109/CtrlRegen',
    caveat: 'Regenerates the image. Fine detail changes; this is not a lossless metadata edit.',
  },
  {
    id: 'diffusion',
    title: 'MarkDiffusion',
    what: 'Diffusion purification of image watermarks, plus a verification harness.',
    envVar: 'UNMARK_MARKDIFFUSION_DIR',
    marker: 'markdiffusion',
    upstream: 'https://github.com/THU-BPM/MarkDiffusion',
    caveat:
      'Regenerates the image, and detection is only valid against the same scheme config used to embed.',
  },
  {
    id: 'markllm',
    title: 'MarkLLM',
    what: 'Detects token-sampling text watermarks (KGW, SynthID-Text) for a known scheme.',
    envVar: 'UNMARK_MARKLLM_DIR',
    marker: 'watermark',
    upstream: 'https://github.com/THU-BPM/MarkLLM',
    caveat:
      'Detection is only meaningful against the exact scheme config and key used at generation. It is a research harness, not a vendor detector.',
  },
  {
    id: 'synthid',
    title: 'SynthID scorer',
    what: 'Scores an image for a SynthID-class pixel watermark.',
    envVar: 'UNMARK_SYNTHID_DIR',
    marker: 'requirements.txt',
    upstream: 'a local reverse-engineered scorer checkout',
    caveat:
      'Not an official Google detector. A score from it says nothing definitive in either direction.',
  },
];

const BY_ID = new Map(BACKEND_SPECS.map((spec) => [spec.id, spec]));

export interface BackendStatus {
  readonly spec: BackendSpec;
  readonly configured: boolean;
  readonly available: boolean;
  readonly directory?: string;
  /** Interpreter that will be used, when one was found. */
  readonly python?: string;
  readonly problem?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the checkout's own virtualenv.
 *
 * These projects pin heavy, mutually incompatible dependency sets. Running
 * them with whatever `python3` happens to be first on PATH is how you get an
 * import error three minutes into loading a model.
 */
async function findPython(directory: string): Promise<string | undefined> {
  const candidates =
    process.platform === 'win32'
      ? [
          join(directory, '.venv', 'Scripts', 'python.exe'),
          join(directory, 'venv', 'Scripts', 'python.exe'),
        ]
      : [join(directory, '.venv', 'bin', 'python'), join(directory, 'venv', 'bin', 'python')];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** Report what is actually installed and usable. */
export async function backendStatus(id: BackendId): Promise<BackendStatus> {
  const spec = BY_ID.get(id);
  if (spec === undefined) throw new Error(`unknown backend: ${id}`);

  const directory = process.env[spec.envVar];
  if (directory === undefined || directory === '') {
    return { spec, configured: false, available: false };
  }

  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      return { spec, configured: true, available: false, directory, problem: 'not a directory' };
    }
  } catch {
    return { spec, configured: true, available: false, directory, problem: 'directory not found' };
  }

  if (!(await exists(join(directory, spec.marker)))) {
    return {
      spec,
      configured: true,
      available: false,
      directory,
      problem: `does not look like a ${spec.title} checkout (no ${spec.marker})`,
    };
  }

  const python = await findPython(directory);
  if (python === undefined) {
    return {
      spec,
      configured: true,
      available: false,
      directory,
      problem: 'no virtualenv found — create one inside the checkout and install its requirements',
    };
  }

  return { spec, configured: true, available: true, directory, python };
}

/** Status of every backend. */
export async function allBackendStatus(): Promise<BackendStatus[]> {
  return Promise.all(BACKEND_SPECS.map((spec) => backendStatus(spec.id)));
}

export interface RunBackendResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface RunBackendOptions {
  readonly timeoutMs?: number;
  /** Written to the child's stdin. */
  readonly input?: string;
}

/**
 * Invoke a backend's entry script.
 *
 * The child gets a scrubbed environment: it does not need this process's
 * secrets, and these are third-party research projects being handed private
 * files. It also gets a hard timeout, because model loading can hang forever
 * on a bad checkpoint.
 */
export async function runBackendScript(
  status: BackendStatus,
  script: string,
  args: readonly string[],
  options: RunBackendOptions = {},
): Promise<RunBackendResult> {
  if (!status.available || status.python === undefined || status.directory === undefined) {
    throw new Error(
      `${status.spec.title} is not available: ${status.problem ?? `set ${status.spec.envVar}`}`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 3_600_000;

  return new Promise((resolve, reject) => {
    const child = spawn(status.python!, [script, ...args], {
      cwd: status.directory,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        // Keep the model off the network unless the user set it up otherwise.
        HF_HUB_OFFLINE: process.env['HF_HUB_OFFLINE'] ?? '1',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${status.spec.title} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/** Setup instructions for a backend, shown when it is missing. */
export function setupInstructions(spec: BackendSpec): string[] {
  return [
    `${spec.title} — ${spec.what}`,
    '',
    `  1. Clone it:      git clone ${spec.upstream}`,
    '  2. Make a venv:   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
    `  3. Point at it:   export ${spec.envVar}=/path/to/checkout`,
    '',
    `  Caveat: ${spec.caveat}`,
  ];
}
