---
name: unmark-files
description: >
  Inspect and remove identifying metadata and provenance marks from files —
  GPS coordinates, camera serial numbers, author names, editing timestamps,
  C2PA content credentials, and invisible Unicode carriers. Works on PNG, JPEG,
  WebP, PDF, DOCX, ODT, SVG, HTML, Markdown and plain text. Use when someone
  asks to strip metadata or EXIF, remove GPS from photos, clean a document
  before sending it, remove C2PA or Content Credentials, find invisible
  characters in text, or audit a folder or website for what it leaks.
---

# Removing metadata from files

Files carry more than their contents. A phone photo knows where it was taken to
within a few metres and which camera took it. A Word document knows who wrote
it, for which company, and how many minutes they spent. A PDF exported from a
design tool knows the local path of the file it came from.

None of that is visible. All of it travels when the file is sent.

This skill drives `unmark`, which removes it. Everything runs on the user's
machine; no file is uploaded anywhere.

## Before anything else: inspect

Never clean before showing the user what is there. The report is usually the
thing they actually wanted — people are more often surprised by what a file
contains than they are interested in the removal step.

```bash
unmark inspect path/to/file
```

Add `--json` when you need to reason about the result rather than show it.

Report back in the user's terms. "This photo contains the GPS coordinates where
it was taken, your camera's serial number, and the timestamp" is useful.
"has_c2pa: false, privacy.hasLocation: true" is not.

## Then clean

```bash
unmark clean path/to/file                 # writes path/to/file.cleaned.ext
unmark clean path/to/file -o output.ext   # explicit destination
unmark clean path/to/file --in-place      # overwrite, keeping a .bak
```

Default to writing a new file. In-place editing of someone's original is a
decision they should make deliberately, not one you make for them.

After cleaning, say what was actually removed — the `actions` list is specific,
so use it. If `residual` reports anything left, or `degraded` is true, say that
too rather than reporting a clean success.

## Auditing more than one file

```bash
unmark scan ~/Pictures --quiet          # only the files that need attention
unmark scan ./site --stylometry --json  # everything, machine-readable
unmark audit-site https://example.com/sitemap.xml --quiet
```

`scan` walks a directory. `audit-site` fetches the URLs in a sitemap — it is
the one command that touches the network, and it only ever issues GETs against
URLs the user named.

Both rank output worst-first and exit `1` when something needs attention, which
makes them usable in a check.

## What the confidence levels mean

Every finding carries one. Do not flatten them in your summary — a tool that
reports everything at the same volume gets ignored.

| Level                   | What it means                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `confirmed`             | A structure was parsed. An Exif directory, a JUMBF box, a named property. Treat as fact.   |
| `probable`              | A marker sat inside a real metadata structure, but no claim was parsed out. Likely real.   |
| `informational`         | Context. A CMS generator tag, "an XMP packet exists", a stylometry score.                  |
| `likely-false-positive` | A raw byte-scan hit. These collide with compressed data constantly. Mention only if asked. |

## Two things this cannot do

Say so plainly when either comes up. Both are documented limits, not bugs.

**Statistical text watermarks.** Schemes like SynthID-Text bias which words a
model picks during generation. The signal is spread across word choice over a
whole passage; there is no character to delete. `unmark inspect` will correctly
report finding nothing, and that is not the same as the text being unmarked.
The only thing that disturbs it is rewriting the prose — see the `unmark-text`
skill, and be honest that the result cannot be verified.

**Pixel-domain and audio watermarks.** Marks embedded in the image data itself
survive metadata removal completely. Removing them means regenerating the image
through a diffusion model, which changes it. `unmark backends` reports whether
such a backend is installed; it is not, by default, and it is rarely what
someone actually wants.

Never tell a user their file is "clean" in a way that implies either of these
was handled.

## Working without the CLI installed

If `unmark` is not on PATH, there is a local HTTP service:

```bash
npx @unmarkk/server              # http://127.0.0.1:8765
curl -s http://127.0.0.1:8765/health
```

```bash
curl -s -X POST http://127.0.0.1:8765/inspect \
  -H 'Content-Type: application/octet-stream' \
  -H "X-Unmark-Filename: $(basename FILE)" \
  --data-binary @FILE
```

`/clean` takes the same request and returns `{ cleaned: "<base64>", report }`;
decode `cleaned` and write it out yourself. `GET /openapi.json` is the full
contract.

If neither is available, say so and stop. Do not improvise a metadata stripper
out of shell tools — a partial strip that looks like a success is worse than no
strip at all, because the user then sends the file.

## Deciding what to remove

`unmark clean` removes all metadata from images by default. That is the right
default for privacy, and it is lossless: pixel data is never touched.

Two cases where you should ask first:

- **`--keep-non-ai-metadata`** keeps ordinary EXIF and removes only provenance
  structures. Useful when the user wants their camera settings preserved for a
  photography workflow, and knows GPS is in there.
- **`--aggressive`** rewrites Latin lookalikes to ASCII. It is genuinely
  destructive on multilingual text — Cyrillic "Опера" becomes "Onepa" — so
  never enable it without asking.

## Reading more

- `references/formats.md` — what is removed and what is deliberately kept, per format
- `references/limits.md` — the boundaries, in detail, with the reasoning
- `references/ethics.md` — intended use, and where it stops

## Intended use

This is for files the user owns or is authorised to modify. Removing metadata
from your own photograph before posting it is ordinary self-defence.

Stripping provenance from someone else's work in order to misrepresent where it
came from is not what this is for. If a request is plainly about passing off
another person's work, say so once, plainly, and do the technical part only for
material they actually own.
