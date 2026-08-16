/**
 * @unmarkk/server — a local-first HTTP API for the unmark engine.
 *
 * Use it when something other than a terminal needs to strip metadata: an
 * editor plugin, a scanner, a home server processing a watch folder. It binds
 * to loopback by default and keeps nothing.
 */

export { createServer, listen, resolveConfig } from './server.js';
export type { ServerConfig } from './config.js';
export { DEFAULT_MAX_BODY_BYTES, isPubliclyBound } from './config.js';
export { openApiDocument } from './openapi.js';
