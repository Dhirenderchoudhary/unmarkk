# Library API

`@unmarkk/core` is the engine. Bytes in, bytes out, in Node or a browser. No dependencies and no I/O.

```bash
npm install @unmarkk/core
```

## Entry points

### `inspect(data, options?): Promise<InspectReport>`

Report what a file carries. Changes nothing.

```ts
import { inspect } from '@unmarkk/core';

const report = await inspect(bytes, { filename: 'photo.jpg' });

report.kind; // 'text' | 'image' | 'container'
report.format; // 'jpeg' | 'pdf' | 'docx' | …
report.findings; // Finding[]
report.notes; // string[] — caveats and scope limits
```

Image and container reports also carry:

```ts
report.hasC2pa; // boolean
report.hasAiMetadata; // boolean
report.privacy; // PrivacyFindings
```

Text reports carry:

```ts
report.length; // in UTF-16 code units
report.suspiciousTotal; // how many invisible characters
report.hits; // CharHit[] — grouped by codepoint
report.stylometry; // only when options.stylometry is true
```

### `clean(data, options?): Promise<CleanResult>`

Return a cleaned copy plus a record of what was done.

```ts
const result = await clean(bytes, { filename: 'photo.jpg' });

result.output; // Uint8Array
result.actions; // Action[] — what was actually removed
result.bytesIn;
result.bytesOut;
```

Image and container results also carry:

```ts
result.residual; // re-inspection of the output; empty findings is the goal
result.degraded; // true when the rebuild was partial — never claim more than this
```

Text results carry `result.stats` with per-codepoint removal counts.

### `summarise(report, threshold?): Verdict`

Reduce a report to a one-line verdict, for exit codes and terse output.

```ts
const { flagged, highestConfidence, summary } = summarise(report);
// flagged: true
// highestConfidence: 'confirmed'
// summary: 'C2PA manifest, location, device identity, timestamps'
```

## Options

```ts
interface InspectOptions {
  filename?: string; // only the extension is used, for routing
  as?: Kind; // force a pipeline instead of sniffing
  aggressive?: boolean; // also flag Latin lookalikes
  stylometry?: boolean; // score text for machine-authorship style
  forceText?: boolean; // process as text even if the bytes look binary
}

interface CleanOptions extends InspectOptions {
  nfkc?: boolean; // NFKC normalisation; alters visible characters
  aggressiveHomoglyphs?: boolean; // rewrite lookalikes to ASCII; destructive
  normalizeSpaces?: boolean; // fold exotic spaces to U+0020 (default true)
  stripEmojiGlue?: boolean; // also strip emoji/script joiners; breaks 👨‍👩‍👧
  stripAllMetadata?: boolean; // images: remove everything, not just provenance
  // (default true — the privacy-first choice)
  cleanTextBodies?: boolean; // containers: also run the Unicode pass on bodies
}
```

## Findings

```ts
interface Finding {
  code: string; // stable machine id, e.g. 'jpeg.app1.exif'
  message: string; // human sentence; wording may change between releases
  confidence: Confidence;
  at?: string; // byte offset, part name, or key
}

type Confidence = 'confirmed' | 'probable' | 'informational' | 'likely-false-positive';
```

Match on `code`, display `message`.

| Confidence              | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `confirmed`             | A structure was parsed — a JUMBF box, an Exif directory, a named property. |
| `probable`              | A marker sat inside a recognised structure, but no claim was parsed.       |
| `informational`         | Context: a CMS generator tag, an XMP packet existing, a stylometry score.  |
| `likely-false-positive` | A raw byte-scan hit; these collide with compressed data routinely.         |

`CONFIDENCE_RANK` is exported for sorting.

## Privacy findings

The half of the report that is about you rather than about a model:

```ts
interface PrivacyFindings {
  hasLocation: boolean; // GPS
  hasDeviceIdentity: boolean; // make, model, serial, generating application
  hasAuthorIdentity: boolean; // creator, artist, copyright, company
  hasTimestamps: boolean; // capture and edit times
}

import { describePrivacy, hasAnyPrivacyRisk } from '@unmarkk/core';

describePrivacy(report.privacy);
// ['location (GPS coordinates)', 'device identity (make, model or serial number)']
```

## Errors

```ts
import { UnmarkInputError } from '@unmarkk/core';

try {
  await clean(docxBytes, { as: 'text' });
} catch (error) {
  if (error instanceof UnmarkInputError) {
    console.error(error.message); // "refusing to treat … as text: it looks like a ZIP container"
    console.error(error.advice); // string[] — what to do instead
  }
}
```

Ordinary `Error` is thrown for unsupported formats, malformed containers that cannot be safely rewritten, and encrypted PDFs.

## Lower-level exports

The format engines are exported directly when you want one specific thing:

```ts
import {
  inspectText,
  cleanText, // the invisible-character pass
  scoreStylometry, // the heuristic scorer
  inspectImage,
  cleanImage, // raster dispatch
  parsePng,
  stripPng, // PNG
  parseJpeg,
  stripJpeg, // JPEG
  parseWebp,
  stripWebp, // WebP
  scanExif, // TIFF/EXIF directory walker
  inspectContainer,
  cleanContainer, // document dispatch
  parsePdf,
  inspectPdf,
  cleanPdf, // PDF
  inspectDocx,
  cleanDocx,
  inspectOdt,
  cleanOdt,
  inspectSvg,
  cleanSvg,
  inspectHtml,
  cleanHtml,
  inspectMarkdown,
  cleanMarkdown,
  classify,
  sniffBinary, // routing and binary detection
  readZip,
  writeZip, // isomorphic ZIP
  decodeText,
  encodeText, // lossless UTF-8 codec
  crc32,
} from '@unmarkk/core';
```

## Browser use

The package is isomorphic. In a bundler-based app, run it in a Worker so a large PDF does not block the main thread:

```ts
// worker.ts
import { clean } from '@unmarkk/core';

self.addEventListener('message', async (event) => {
  const result = await clean(new Uint8Array(event.data.bytes));
  const buffer = result.output.buffer;
  self.postMessage({ output: buffer }, [buffer]); // transfer, do not copy
});
```

`packages/web` is a complete working example.

## A note on `decodeText`

If you are converting between bytes and strings yourself, use the exported codec rather than `TextDecoder`. `TextDecoder` replaces undecodable bytes with U+FFFD, so a round trip through it corrupts every non-UTF-8 file. `decodeText`/`encodeText` are byte-exact for any input.

```ts
import { decodeText, encodeText } from '@unmarkk/core';

encodeText(decodeText(anyBytes)); // === anyBytes, always
```
