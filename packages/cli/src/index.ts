/**
 * unmark — a privacy-first watermark and metadata remover.
 *
 * Everything happens on this machine. The engine has no network code in it, so
 * there is nothing to opt out of. Two commands can reach the network and both
 * say so loudly: `audit-site`, which fetches the public URLs you name, and
 * `rewrite`, which can talk to a model server you choose (loopback only unless
 * you insist otherwise).
 *
 * Exit codes are meant to be useful in a pipeline:
 *   0  nothing found / the operation succeeded
 *   1  metadata found, or signals survived a clean
 *   2  bad input or bad usage
 */

import { parseArgs } from 'node:util';
import { UnmarkInputError, VERSION } from '@unmarkk/core';
import type { Kind } from '@unmarkk/core';
import { CliError } from './io.js';
import { err, out, style } from './render.js';
import { runInspect } from './commands/inspect.js';
import { runClean } from './commands/clean.js';
import { runScan } from './commands/scan.js';
import { AUDIT_SITE_DEFAULTS, runAuditSite } from './commands/audit-site.js';
import {
  REWRITE_DEFAULTS,
  asBackendName,
  asRewriteMode,
  listRewriteOptions,
  runRewrite,
} from './commands/rewrite.js';
import { runBackends } from './commands/backends.js';

const HELP = `${style.bold('unmark')} — privacy-first watermark and metadata remover

${style.bold('USAGE')}
  unmark <command> [options] <path...>

${style.bold('COMMANDS')}
  inspect <path...>     Report what a file carries. Changes nothing.
  clean   <path...>     Write a copy with the metadata removed.
  scan    <dir...>      Audit a directory tree and rank what needs attention.
  audit-site <url>      Audit a live site from its sitemap. Makes network requests.
  rewrite <path>        Layer B: rephrase prose to disturb a sampling watermark.
  backends              Show which optional heavy backends are installed.

${style.bold('COMMON OPTIONS')}
  --json                Machine-readable output on stdout.
  --as <kind>           Force a pipeline: text, image or container.
  --force-text          Process bytes as text even if they look binary.
  -h, --help            Show this help.
  -V, --version         Print the version.

${style.bold('INSPECT')}
  --stylometry          Also score the text for machine-authorship style.
  --aggressive          Also flag Latin lookalikes. Noisy on multilingual text.

${style.bold('CLEAN')}
  -o, --output <path>   Write here instead of <name>.cleaned.<ext>.
  --in-place            Overwrite the original (a .bak copy is kept).
  --no-backup           With --in-place, skip the .bak copy.
  --nfkc                Apply Unicode NFKC normalisation. Alters characters.
  --aggressive          Rewrite Latin lookalikes to ASCII. Destructive.
  --keep-spaces         Leave exotic spaces alone.
  --strip-emoji-glue    Also strip emoji joiners. Breaks family emoji.
  --keep-non-ai-metadata
                        Images: only drop provenance-looking segments, keeping
                        ordinary EXIF. Off by default — removing everything is
                        the privacy-first choice.

${style.bold('SCAN')}
  --all                 Try every file, not just known formats.
  --quiet               Only list files that need attention.
  --stylometry          Also score prose for machine-authorship style.
  --skip <names>        Extra comma-separated directory names to skip.

${style.bold('AUDIT-SITE')}
  --limit <n>           Maximum URLs to fetch (default ${AUDIT_SITE_DEFAULTS.limit}).
  --concurrency <n>     Parallel requests (default ${AUDIT_SITE_DEFAULTS.concurrency}).
  --timeout <ms>        Per-request timeout (default ${AUDIT_SITE_DEFAULTS.timeoutMs}).
  --max-bytes <n>       Per-response cap (default ${AUDIT_SITE_DEFAULTS.maxBytes}).
  --allow-private       Permit private/loopback addresses (your own intranet).
  --quiet, --stylometry, --json

${style.bold('REWRITE')}
  --list                Show the available modes and backends.
  --mode <name>         paraphrase (default), humanize, code, outline, expand,
                        backtranslate-out, backtranslate-back.
  --backend <name>      print-prompt (default), ollama, openai-compatible.
  --base-url <url>      Model endpoint. Loopback only unless --allow-remote.
  --model <name>        Model to ask for.
  --candidates <n>      Generate n rewrites and keep the most diverged.
  --temperature <n>     Sampling temperature (default ${REWRITE_DEFAULTS.temperature}).
  --language <name>     Target language for the back-translation modes.
  --allow-remote        Permit a non-loopback endpoint. Your text leaves here.
  -o, --output <path>   Write here instead of <name>.rewritten.<ext>.

${style.bold('EXAMPLES')}
  unmark inspect photo.jpg
  unmark clean photo.jpg -o safe.jpg
  unmark clean notes.md --in-place
  unmark scan ~/Pictures --quiet
  unmark audit-site https://example.com/sitemap.xml --quiet
  unmark rewrite draft.md                    # prints a prompt, contacts nothing
  unmark rewrite draft.md --backend ollama --model llama3.2
  cat draft.txt | unmark clean - > clean.txt

Files never leave this machine unless you use audit-site or a rewrite backend.
There is no telemetry.
`;

function asKind(value: string | undefined): Kind | undefined {
  if (value === undefined) return undefined;
  if (value === 'text' || value === 'image' || value === 'container') return value;
  throw new CliError(`--as must be text, image or container (got "${value}")`);
}

function asNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${label} must be a positive number (got "${value}")`);
  }
  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    out(HELP);
    return 0;
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    out(VERSION);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      as: { type: 'string' },
      'force-text': { type: 'boolean', default: false },
      stylometry: { type: 'boolean', default: false },
      aggressive: { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
      'in-place': { type: 'boolean', default: false },
      'no-backup': { type: 'boolean', default: false },
      nfkc: { type: 'boolean', default: false },
      'keep-spaces': { type: 'boolean', default: false },
      'strip-emoji-glue': { type: 'boolean', default: false },
      'keep-non-ai-metadata': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      skip: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      'max-bytes': { type: 'string' },
      'allow-private': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      mode: { type: 'string' },
      backend: { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      candidates: { type: 'string' },
      temperature: { type: 'string' },
      language: { type: 'string' },
      'allow-remote': { type: 'boolean', default: false },
      'no-clean-passes': { type: 'boolean', default: false },
      setup: { type: 'boolean', default: false },
    },
  });

  if (values.help === true) {
    out(HELP);
    return 0;
  }

  const kind = asKind(values.as);

  switch (command) {
    case 'inspect':
      return runInspect({
        paths: positionals,
        json: values.json === true,
        stylometry: values.stylometry === true,
        aggressive: values.aggressive === true,
        forceText: values['force-text'] === true,
        ...(kind === undefined ? {} : { as: kind }),
      });

    case 'clean':
      return runClean({
        paths: positionals,
        json: values.json === true,
        inPlace: values['in-place'] === true,
        noBackup: values['no-backup'] === true,
        nfkc: values.nfkc === true,
        aggressive: values.aggressive === true,
        keepSpaces: values['keep-spaces'] === true,
        stripEmojiGlue: values['strip-emoji-glue'] === true,
        keepNonAiMetadata: values['keep-non-ai-metadata'] === true,
        forceText: values['force-text'] === true,
        ...(values.output === undefined ? {} : { output: values.output }),
        ...(kind === undefined ? {} : { as: kind }),
      });

    case 'scan':
      return runScan({
        paths: positionals,
        json: values.json === true,
        all: values.all === true,
        quiet: values.quiet === true,
        stylometry: values.stylometry === true,
        skip: (values.skip ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      });

    case 'audit-site': {
      const target = positionals[0];
      if (target === undefined) throw new CliError('audit-site needs a sitemap or page URL');
      return runAuditSite({
        target,
        json: values.json === true,
        quiet: values.quiet === true,
        stylometry: values.stylometry === true,
        allowPrivate: values['allow-private'] === true,
        limit: asNumber(values.limit, AUDIT_SITE_DEFAULTS.limit, '--limit'),
        concurrency: asNumber(values.concurrency, AUDIT_SITE_DEFAULTS.concurrency, '--concurrency'),
        timeoutMs: asNumber(values.timeout, AUDIT_SITE_DEFAULTS.timeoutMs, '--timeout'),
        maxBytes: asNumber(values['max-bytes'], AUDIT_SITE_DEFAULTS.maxBytes, '--max-bytes'),
      });
    }

    case 'rewrite': {
      if (values.list === true) return listRewriteOptions();
      const path = positionals[0];
      if (path === undefined) throw new CliError('rewrite needs a path, or - for stdin');

      const backend = asBackendName(values.backend);
      const defaultBaseUrl =
        backend === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8080';
      const defaultModel = backend === 'ollama' ? 'llama3.2' : 'local-model';

      return runRewrite({
        path,
        mode: asRewriteMode(values.mode),
        backend,
        baseUrl: values['base-url'] ?? process.env['UNMARK_REWRITE_BASE_URL'] ?? defaultBaseUrl,
        model: values.model ?? process.env['UNMARK_REWRITE_MODEL'] ?? defaultModel,
        json: values.json === true,
        allowRemote:
          values['allow-remote'] === true || process.env['UNMARK_REWRITE_ALLOW_REMOTE'] === '1',
        temperature: asNumber(values.temperature, REWRITE_DEFAULTS.temperature, '--temperature'),
        timeoutMs: asNumber(values.timeout, REWRITE_DEFAULTS.timeoutMs, '--timeout'),
        candidates: asNumber(values.candidates, REWRITE_DEFAULTS.candidates, '--candidates'),
        language: values.language ?? REWRITE_DEFAULTS.language,
        noCleanPasses: values['no-clean-passes'] === true,
        ...(values.output === undefined ? {} : { output: values.output }),
      });
    }

    case 'backends':
      return runBackends({ json: values.json === true, setup: values.setup === true });

    default:
      throw new CliError(`unknown command "${command}". Run \`unmark --help\`.`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      err(style.red(`error: ${error.message}`));
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof UnmarkInputError) {
      err(style.red(`error: ${error.message}`));
      for (const line of error.advice) err(style.dim(`  ${line}`));
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    err(style.red(`error: ${message}`));
    if (process.env['UNMARK_DEBUG'] !== undefined && error instanceof Error) {
      err(style.dim(error.stack ?? ''));
    }
    process.exitCode = 2;
  });
