#!/usr/bin/env node
/** `unmark-server` — start the local HTTP API. */

import { parseArgs } from 'node:util';
import { VERSION } from '@unmarkk/core';
import { listen } from './server.js';

const HELP = `unmark-server — local HTTP API for the unmark engine

USAGE
  unmark-server [options]

OPTIONS
  --host <addr>       Interface to bind (default 127.0.0.1)
  --port <n>          Port to listen on (default 8765)
  --api-key <token>   Require "Authorization: Bearer <token>" on every request
  --allow-origin <o>  Permit browser requests from this origin (repeatable)
  --max-body <bytes>  Largest accepted request body (default 128 MiB)
  --log               Log one line per request (never filenames or content)
  -h, --help          Show this help
  -V, --version       Print the version

ENVIRONMENT
  UNMARK_HOST, UNMARK_PORT, UNMARK_API_KEY, UNMARK_ALLOWED_ORIGINS,
  UNMARK_MAX_BODY_BYTES, UNMARK_LOG_REQUESTS

The default bind is loopback. Anything sent to this service is a document
someone did not intend to publish; do not expose it without a token and TLS.
`;

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    port: { type: 'string' },
    'api-key': { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    'max-body': { type: 'string' },
    log: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'V', default: false },
  },
});

if (values.help === true) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version === true) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const server = await listen({
  logRequests: values.log === true,
  ...(values.host === undefined ? {} : { host: values.host }),
  ...(values.port === undefined ? {} : { port: Number(values.port) }),
  ...(values['api-key'] === undefined ? {} : { apiKey: values['api-key'] }),
  ...(values['allow-origin'] === undefined ? {} : { allowedOrigins: values['allow-origin'] }),
  ...(values['max-body'] === undefined ? {} : { maxBodyBytes: Number(values['max-body']) }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stderr.write('\nshutting down\n');
    server.close(() => process.exit(0));
  });
}
