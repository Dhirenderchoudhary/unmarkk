/**
 * Model backends for the Layer B rewrite.
 *
 * The default backend prints the prompt and stops. That is not a placeholder —
 * it is the right default for a tool whose whole premise is that your content
 * stays on your machine. You paste the prompt into whatever model you already
 * trust, and nothing here ever sees the text.
 *
 * The two live backends talk to a model over HTTP, and both are **loopback-only
 * unless you explicitly say otherwise**. Sending a private document to a remote
 * inference endpoint is exactly the thing this project exists to help people
 * avoid doing by accident, so it takes a deliberate flag and prints a warning.
 *
 * Two smaller rules, both learned the hard way by other tools:
 *
 *   - **API keys come from the environment, never argv.** Command lines show up
 *     in `ps`, in shell history, and in CI logs.
 *   - **Redirects are refused outright.** Node's client re-sends headers on a
 *     3xx, which would forward an `Authorization` header to whatever host the
 *     redirect names — straight past the loopback check.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { CliError } from './io.js';

export type BackendName = 'print-prompt' | 'ollama' | 'openai-compatible';

export const BACKENDS: readonly {
  readonly name: BackendName;
  readonly summary: string;
  readonly defaultBaseUrl?: string;
  readonly defaultModel?: string;
}[] = [
  {
    name: 'print-prompt',
    summary: 'Print the prompt and stop. No model is contacted; your text stays here.',
  },
  {
    name: 'ollama',
    summary: 'A local Ollama server.',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'llama3.2',
  },
  {
    name: 'openai-compatible',
    summary: 'Any server exposing /v1/chat/completions (llama.cpp, vLLM, LM Studio, …).',
    defaultBaseUrl: 'http://127.0.0.1:8080',
    defaultModel: 'local-model',
  },
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export interface BackendOptions {
  readonly backend: BackendName;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Permit a non-loopback endpoint. Content leaves the machine. */
  readonly allowRemote: boolean;
  /** Sampling temperature. Higher moves the wording further. */
  readonly temperature: number;
}

/**
 * Refuse a non-loopback endpoint unless the caller opted in.
 *
 * Returns a warning to show the user when they did opt in — they should be
 * told, every time, that the document is about to leave the machine.
 */
export function checkEndpoint(baseUrl: string, allowRemote: boolean): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CliError(`not a valid rewrite endpoint URL: ${baseUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`rewrite endpoint must be http or https, got ${url.protocol}`);
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return null;

  if (!allowRemote) {
    throw new CliError(
      `refusing to send your text to ${url.hostname}, which is not this machine.\n` +
        '  Pass --allow-remote (or set UNMARK_REWRITE_ALLOW_REMOTE=1) if that is what you want.',
    );
  }
  return `your text is being sent to ${url.hostname} — it is leaving this machine`;
}

interface HttpJsonOptions {
  readonly timeoutMs: number;
  readonly apiKey?: string | undefined;
}

/** POST JSON and parse the response. Refuses redirects. */
async function postJson(
  url: string,
  payload: unknown,
  options: HttpJsonOptions,
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    Accept: 'application/json',
  };
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  return new Promise((resolve, reject) => {
    const req = send(target, { method: 'POST', headers, timeout: options.timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;

      // Any 3xx is refused rather than followed: following it would re-send
      // the Authorization header to a host that was never validated.
      if (status >= 300 && status < 400) {
        res.resume();
        reject(
          new CliError(
            `rewrite endpoint returned a redirect (HTTP ${status}); refusing to follow it`,
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new CliError(`rewrite endpoint returned HTTP ${status}: ${text.slice(0, 400)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as Record<string, unknown>);
        } catch {
          reject(new CliError(`rewrite endpoint returned a non-JSON body: ${text.slice(0, 200)}`));
        }
      });
      res.on('error', (error) => reject(new CliError(error.message)));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new CliError(`rewrite endpoint timed out after ${options.timeoutMs}ms`));
    });
    req.on('error', (error) => {
      const message =
        (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          ? `nothing is listening at ${url}. Is your local model server running?`
          : error.message;
      reject(new CliError(message));
    });
    req.write(body);
    req.end();
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/** Send one prompt to the configured backend and return the model's text. */
export async function runBackend(prompt: string, options: BackendOptions): Promise<string> {
  // Read from the environment only. A key on the command line ends up in `ps`,
  // in shell history, and in CI logs.
  const apiKey = process.env['UNMARK_REWRITE_API_KEY'];

  if (options.backend === 'ollama') {
    const response = await postJson(
      new URL('/api/chat', options.baseUrl).href,
      {
        model: options.model,
        stream: false,
        options: { temperature: options.temperature },
        messages: [{ role: 'user', content: prompt }],
      },
      { timeoutMs: options.timeoutMs, apiKey },
    );

    const message = response['message'] as { content?: unknown } | undefined;
    const text = firstString(message?.content, response['response']);
    if (text === undefined) {
      throw new CliError('Ollama returned no message content');
    }
    return text;
  }

  if (options.backend === 'openai-compatible') {
    const response = await postJson(
      new URL('/v1/chat/completions', options.baseUrl).href,
      {
        model: options.model,
        temperature: options.temperature,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeoutMs: options.timeoutMs, apiKey },
    );

    const choices = response['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new CliError('the endpoint returned no completion choices');
    }
    const choice = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const text = firstString(choice.message?.content, choice.text);
    if (text === undefined) {
      throw new CliError('the endpoint returned an empty completion');
    }
    return text;
  }

  throw new CliError(`backend ${options.backend} does not contact a model`);
}
