# @unmarkk/core

The engine behind [unmark](../../README.md). Bytes in, bytes out.

```bash
npm install @unmarkk/core
```

**Zero dependencies. No I/O capability.** No `fs`, no `fetch`, no `process` — nothing in this package can read a file or open a socket, which is what makes the project's privacy claim structural rather than a promise. The same code runs in Node and in a browser tab.

```ts
import { inspect, clean, summarise } from '@unmarkk/core';

const report = await inspect(bytes, { filename: 'photo.jpg' });
console.log(summarise(report).summary);
// "C2PA manifest, location, device identity, timestamps"

const { output, actions } = await clean(bytes, { filename: 'photo.jpg' });
```

## What it handles

|           | Formats                                                       |
| --------- | ------------------------------------------------------------- |
| Images    | PNG, JPEG, WebP — including a real EXIF/TIFF directory walker |
| Documents | PDF, DOCX, ODT, SVG, HTML, Markdown                           |
| Text      | Invisible and format Unicode, in any encoding                 |

Identifying metadata (GPS, device serials, author names, timestamps) is reported separately from AI provenance, because they are different problems that happen to live in the same bytes.

## Documentation

- [API reference](../../docs/api.md)
- [Format-by-format detail](../../docs/formats.md) — what is removed and what is deliberately kept
- [Architecture](../../docs/architecture.md)

## License

MIT © Dhirender Choudhary
