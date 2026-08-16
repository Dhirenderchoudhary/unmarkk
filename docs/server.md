# HTTP API

A local helper for when something other than a terminal needs to strip metadata: an editor plugin, a scanner, a home server watching a folder.

```bash
npm install -g @unmarkk/server
unmark-server
# unmark 1.0.0 listening on http://127.0.0.1:8765
```

## Design

Built on `node:http` with no framework. Five paths and two verbs is not worth a supply chain, and every dependency in a privacy tool is another party you are asking users to trust.

- **Binds to loopback by default.** A metadata stripper reachable from the network is a service that receives other people's private documents.
- **Nothing touches disk.** Bodies live in memory for the duration of the request and are discarded when the response is sent.
- **Nothing sensitive is logged.** With `--log`, one line per request: method, path, status, duration. Never a filename — `photo-of-my-passport.jpg` is itself sensitive — and never any content.
- **No CORS unless you ask.** Without a configured origin, no CORS headers are sent at all, so a page on another site cannot make a browser POST documents here on its behalf.

## Options

```
--host <addr>       Interface to bind (default 127.0.0.1)
--port <n>          Port (default 8765)
--api-key <token>   Require "Authorization: Bearer <token>", compared in constant time
--allow-origin <o>  Permit browser requests from this origin (repeatable)
--max-body <bytes>  Largest accepted body (default 128 MiB)
--log               One line per request
```

Environment equivalents: `UNMARK_HOST`, `UNMARK_PORT`, `UNMARK_API_KEY`, `UNMARK_ALLOWED_ORIGINS` (comma-separated), `UNMARK_MAX_BODY_BYTES`, `UNMARK_LOG_REQUESTS=1`.

## Endpoints

### `GET /health`

```json
{ "ok": true, "version": "1.0.0" }
```

### `GET /capabilities`

Which formats this build handles, and the privacy properties it claims.

```json
{
  "ok": true,
  "engine": "pure TypeScript, no external binaries",
  "formats": { "pdf": { "inspect": true, "clean": true }, "…": {} },
  "privacy": {
    "networkEgress": false,
    "diskWrites": false,
    "contentLogging": false,
    "retention": "none — bodies are discarded when the response is sent"
  }
}
```

### `GET /openapi.json`

An OpenAPI 3.1 document, generated from the same table that defines the routes so it cannot drift from what is actually served. Readable without a token even when one is configured.

### `POST /inspect`

Two request shapes. JSON, for convenience:

```bash
curl -X POST localhost:8765/inspect \
  -H 'Content-Type: application/json' \
  -d '{"file":"'"$(base64 -i photo.jpg)"'","name":"photo.jpg"}'
```

Or a raw binary body, which avoids the 33% base64 overhead:

```bash
curl -X POST localhost:8765/inspect \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Unmark-Filename: photo.jpg' \
  --data-binary @photo.jpg
```

```json
{
  "ok": true,
  "kind": "image",
  "format": "jpeg",
  "flagged": true,
  "verdict": {
    "flagged": true,
    "highestConfidence": "confirmed",
    "summary": "location, device identity"
  },
  "report": { "findings": [], "privacy": {}, "notes": [] }
}
```

### `POST /clean`

Same request shapes, plus an optional `options` object.

```bash
curl -X POST localhost:8765/clean \
  -H 'Content-Type: application/json' \
  -d '{"file":"…","name":"notes.md","options":{"cleanTextBodies":true}}'
```

```json
{
  "ok": true,
  "kind": "container",
  "format": "markdown",
  "cleaned": "LS0tCnRpdGxlOiBOb3Rlcwo…",
  "report": { "actions": [], "residual": {}, "degraded": false }
}
```

Accepted options: `nfkc`, `aggressive`, `aggressiveHomoglyphs`, `normalizeSpaces`, `stripEmojiGlue`, `stripAllMetadata`, `cleanTextBodies`, `forceText`, `as`. An unrecognised option is a `400` rather than being silently ignored — a client that thinks it disabled something should find out.

## Errors

```json
{ "ok": false, "error": "'file' is not valid base64" }
```

| Status | When                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `400`  | Bad JSON, bad base64, missing `file`, unknown or wrongly typed option, input refused by the engine                      |
| `401`  | Missing or invalid bearer token                                                                                         |
| `404`  | Unknown path                                                                                                            |
| `413`  | Body past `--max-body`                                                                                                  |
| `415`  | Unsupported `Content-Type`                                                                                              |
| `500`  | Internal error — the message is always the literal string `internal error`, because a real one could quote file content |

When the engine refuses input, the response includes an `advice` array explaining what to do instead.

## Response headers

Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Content-Security-Policy` of `default-src 'none'; frame-ancestors 'none'`. Responses derive from documents the user did not intend to publish and should not be cached anywhere.

## Embedding it

```ts
import { createServer } from '@unmarkk/server';

const server = createServer({ port: 0, apiKey: process.env.TOKEN });
server.listen(0, '127.0.0.1');
```

`createServer` returns a plain `http.Server`, so it composes with whatever you already have.

## Before you expose it

The default is loopback and the tool warns when it is not. If you make it reachable, read [the threat model](threat-model.md#if-you-expose-the-server): set a token, put it behind TLS, and remember that everything arriving is somebody's private document.
