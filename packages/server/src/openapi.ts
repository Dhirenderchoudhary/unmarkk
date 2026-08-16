/**
 * The OpenAPI document, generated from one table.
 *
 * Generated rather than hand-written so it cannot drift from what the handler
 * actually serves — a spec that lies is worse than no spec.
 */

import { VERSION } from '@unmarkk/core';
import type { ServerConfig } from './config.js';

const errorSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', enum: [false] },
    error: { type: 'string' },
  },
} as const;

const fileRequest = {
  type: 'object',
  required: ['file'],
  properties: {
    file: {
      type: 'string',
      description: 'Base64-encoded file bytes.',
      example: 'SGVsbG8gd29ybGQ=',
    },
    name: {
      type: 'string',
      description: 'Original filename. Only the extension is used, for format routing.',
      example: 'photo.jpg',
    },
  },
} as const;

function errorResponses(authenticated: boolean): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '400': { description: 'Bad request', content: { 'application/json': { schema: errorSchema } } },
    '413': {
      description: 'Request body too large',
      content: { 'application/json': { schema: errorSchema } },
    },
    '415': {
      description: 'Unsupported media type',
      content: { 'application/json': { schema: errorSchema } },
    },
    '500': {
      description: 'Internal error',
      content: { 'application/json': { schema: errorSchema } },
    },
  };
  if (authenticated) {
    responses['401'] = {
      description: 'Missing or invalid bearer token',
      content: { 'application/json': { schema: errorSchema } },
    };
  }
  return responses;
}

/** Build the OpenAPI 3.1 document for a running configuration. */
export function openApiDocument(config: ServerConfig): Record<string, unknown> {
  const authenticated = config.apiKey !== undefined;
  const errors = errorResponses(authenticated);

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: 'unmark',
      version: VERSION,
      summary: 'Privacy-first watermark and metadata removal.',
      description: [
        'Inspect and clean files without them leaving the machine running this service.',
        '',
        'Request bodies are held in memory for the duration of the request and never written',
        'to disk. Nothing is retained after a response is sent, and no request content or',
        'filename is written to the log.',
        '',
        'Files may be sent either as base64 inside a JSON envelope, or as a raw binary body',
        'with `Content-Type: application/octet-stream` and an optional `X-Unmark-Filename`',
        'header. Raw bodies avoid the 33% base64 overhead.',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: `http://${config.host}:${config.port}`, description: 'This instance' }],
    paths: {
      '/health': {
        get: {
          summary: 'Liveness and version',
          responses: {
            '200': {
              description: 'The service is up',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      version: { type: 'string' },
                    },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
      '/capabilities': {
        get: {
          summary: 'Which formats this build can inspect and clean',
          responses: {
            '200': {
              description: 'Capability report',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            ...errors,
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          responses: {
            '200': {
              description: 'An OpenAPI 3.1 document',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/inspect': {
        post: {
          summary: 'Report what a file carries, changing nothing',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: fileRequest },
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '200': {
              description: 'Inspection report',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      kind: { type: 'string', enum: ['text', 'image', 'container'] },
                      flagged: { type: 'boolean' },
                      verdict: { type: 'object' },
                      report: { type: 'object' },
                    },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
      '/clean': {
        post: {
          summary: 'Return a cleaned copy of the file and a record of what was removed',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    fileRequest,
                    {
                      type: 'object',
                      properties: {
                        options: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            nfkc: { type: 'boolean' },
                            aggressiveHomoglyphs: { type: 'boolean' },
                            normalizeSpaces: { type: 'boolean' },
                            stripEmojiGlue: { type: 'boolean' },
                            stripAllMetadata: { type: 'boolean' },
                            cleanTextBodies: { type: 'boolean' },
                            forceText: { type: 'boolean' },
                            as: { type: 'string', enum: ['text', 'image', 'container'] },
                          },
                        },
                      },
                    },
                  ],
                },
              },
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '200': {
              description: 'Cleaned bytes and a report',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      kind: { type: 'string' },
                      cleaned: { type: 'string', description: 'Base64-encoded cleaned bytes' },
                      report: { type: 'object' },
                    },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
    },
  };

  if (authenticated) {
    document['components'] = {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    };
    document['security'] = [{ bearerAuth: [] }];
  }

  return document;
}
