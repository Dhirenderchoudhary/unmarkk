# @unmarkk/server

A local HTTP API for the [unmark](../../README.md) engine, for when something other than a terminal needs to strip metadata.

```bash
npx @unmarkk/server
# unmark listening on http://127.0.0.1:8765
```

Open that URL and you get the browser app: drag a file in, read what it
carries, download a cleaned copy. Nothing is uploaded — the page is delivered
over loopback and then does all its work in the tab, under a
`connect-src 'none'` policy that stops it calling anywhere, including back
here.

```bash
curl -X POST localhost:8765/inspect \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Unmark-Filename: photo.jpg' \
  --data-binary @photo.jpg
```

Built on `node:http` with no framework. Five paths and two verbs is not worth a supply chain.

- Binds to `127.0.0.1` by default, and warns loudly when it does not.
- Request bodies live in memory for the duration of the request and are never written to disk.
- Logs method, path, status and duration — never a filename, never any content.
- Sends no CORS headers unless you explicitly allow an origin.

## Endpoints

|                     |                                  |
| ------------------- | -------------------------------- |
| `GET /health`       | Liveness and version             |
| `GET /capabilities` | Which formats this build handles |
| `GET /openapi.json` | Generated OpenAPI 3.1 document   |
| `POST /inspect`     | Report what a file carries       |
| `POST /clean`       | Return a cleaned copy            |

Full details in [docs/server.md](../../docs/server.md).

## Embedding

```ts
import { createServer } from '@unmarkk/server';

const server = createServer({ port: 8765, apiKey: process.env.TOKEN });
server.listen(8765, '127.0.0.1');
```

Returns a plain `http.Server`.

## Before you expose it

Everything sent here is a document somebody did not intend to publish. If you make it reachable from a network, set `--api-key`, put it behind TLS, and read [the threat model](../../docs/threat-model.md#if-you-expose-the-server).

## License

MIT © Dhirender Choudhary
