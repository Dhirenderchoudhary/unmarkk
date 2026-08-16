# Getting Started

Install, run your first scan, and understand the output in five minutes.

## Installation

Choose whichever surface fits your workflow:

```bash
# Command line — inspect and clean files from the terminal
npm install -g @unmarkk/cli

# Library — use the engine in your own code
npm install @unmarkk/core

# Local HTTP API — for scripts, CI, or tools that speak HTTP
npm install -g @unmarkk/server
```

All three require **Node 20.11 or newer**. No system tools (no `exiftool`,
no `qpdf`, no ImageMagick).

The **browser app** needs no install at all — run `pnpm --filter @unmarkk/web dev` from the repo, or deploy the static build. See [web.md](web.md).

## First Inspection

Point `unmark` at any file to see what it carries:

```bash
unmark inspect photo.jpg
```

The output tells you, in plain language, what the file gives away:

```
photo.jpg  image/jpeg  found
  This file records GPS coordinates of where this was taken, camera make,
  model or serial number, and when it was created or last edited.

  [confirmed] Exif block with 5 identifying tags: Artist, DateTime, GPSInfo, Make, Model
  [confirmed] JUMBF C2PA manifest found (1284 bytes, 1 assertion)
  [probable]  XMP packet with generator tag "Adobe Photoshop"
```

Every finding has a **confidence level**:

| Level                   | Meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `confirmed`             | A structure was parsed. An Exif directory, a JUMBF box.       |
| `probable`              | A marker inside a recognised structure, but not fully parsed. |
| `informational`         | Context. A generator tag, an XMP packet.                      |
| `likely-false-positive` | A byte-scan hit that collides with compressed data routinely. |

## Cleaning a File

```bash
unmark clean photo.jpg
```

This writes `photo.cleaned.jpg` alongside the original. The original is never
modified unless you ask:

```bash
# Overwrite in place, keeping a .bak backup
unmark clean photo.jpg --in-place

# Overwrite in place with no backup
unmark clean photo.jpg --in-place --no-backup

# Write to a specific path
unmark clean photo.jpg --output safe-photo.jpg
```

## Scanning a Directory

```bash
unmark scan ~/Pictures
```

This walks the directory, inspects every supported file, and prints a sorted
report — worst first, so you see the files that need the most attention at the
top:

```
! trip/IMG_4382.jpg · jpeg  C2PA manifest, location, device, timestamps
! trip/IMG_4383.jpg · jpeg  location, device, timestamps
. trip/notes.md · markdown
. trip/itinerary.pdf · pdf

4 scanned · 2 need attention
  by format: jpeg 2, markdown 1, pdf 1
  findings: confirmed 4, probable 1
  2 with location, 2 with device identity, 2 with timestamps
```

Use `--quiet` to show only the flagged files, and `--json` for
machine-readable output.

## Using as a Library

```ts
import { inspect, clean, summarise } from '@unmarkk/core';

// Inspect — what does this file carry?
const bytes = new Uint8Array(await file.arrayBuffer());
const report = await inspect(bytes, { filename: 'photo.jpg' });

console.log(summarise(report).summary);
// "C2PA manifest, location, device identity, timestamps"

// Clean — give me the file without it
const { output, actions } = await clean(bytes, { filename: 'photo.jpg' });
// `output` is a Uint8Array with the cleaned file
// `actions` describes what was removed
```

The engine is isomorphic — same code in Node and the browser. See
[api.md](api.md) for the full API reference.

## Next Steps

- [API reference](api.md) — every function, option, and type
- [Architecture](architecture.md) — how the engine works
- [Threat model](threat-model.md) — what it protects against and what it does not
- [Format notes](formats.md) — how each format is parsed and rebuilt
- [Server API](server.md) — the HTTP API spec
- [Browser app](web.md) — running and deploying the web UI
- [Ethics](ethics.md) — intended use and misuse
