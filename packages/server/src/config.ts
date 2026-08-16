/** Server configuration, with privacy-preserving defaults. */

export interface ServerConfig {
  /**
   * Interface to bind. Loopback by default: the service is a local helper,
   * and a metadata stripper reachable from the network is a service that
   * receives other people's private documents.
   */
  readonly host: string;
  readonly port: number;
  /** When set, every request must present `Authorization: Bearer <token>`. */
  readonly apiKey: string | undefined;
  /** Largest request body accepted, in bytes. */
  readonly maxBodyBytes: number;
  /**
   * Allowed browser origins. Empty means no CORS headers at all, so a page on
   * another site cannot make a browser POST documents here on its behalf.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Log one line per request. Filenames are never logged in either mode —
   * `photo-of-my-passport.jpg` is itself sensitive.
   */
  readonly logRequests: boolean;
}

export const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const apiKey = overrides.apiKey ?? env['UNMARK_API_KEY'];

  return {
    host: overrides.host ?? env['UNMARK_HOST'] ?? '127.0.0.1',
    port: overrides.port ?? Number(env['UNMARK_PORT'] ?? 8765),
    apiKey: apiKey === undefined || apiKey === '' ? undefined : apiKey,
    maxBodyBytes:
      overrides.maxBodyBytes ?? Number(env['UNMARK_MAX_BODY_BYTES'] ?? DEFAULT_MAX_BODY_BYTES),
    allowedOrigins:
      overrides.allowedOrigins ??
      (env['UNMARK_ALLOWED_ORIGINS'] ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    logRequests: overrides.logRequests ?? env['UNMARK_LOG_REQUESTS'] === '1',
  };
}

/** True when the bind address is reachable from outside this machine. */
export function isPubliclyBound(host: string): boolean {
  return !['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
}
