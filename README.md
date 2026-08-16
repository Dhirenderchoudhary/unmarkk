# unmark

[![CI](https://github.com/Dhirenderchoudhary/unmarkk/actions/workflows/ci.yml/badge.svg)](https://github.com/Dhirenderchoudhary/unmarkk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@unmarkk/cli?label=%40unmarkk%2Fcli)](https://www.npmjs.com/package/@unmarkk/cli)
[![npm](https://img.shields.io/npm/v/@unmarkk/core?label=%40unmarkk%2Fcore)](https://www.npmjs.com/package/@unmarkk/core)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-2c6a4d)](https://www.npmjs.com/package/@unmarkk/core?activeTab=dependencies)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Privacy-first watermark and metadata remover.** Strips the data your files carry about you — GPS coordinates, camera serial numbers, author names, editing timestamps — along with AI provenance manifests and invisible Unicode carriers.

Everything runs locally. The engine has no network code in it at all.

```bash
npm install -g @unmarkk/cli

unmark inspect photo.jpg          # what does this file say about me?
unmark clean photo.jpg            # write photo.cleaned.jpg without it
unmark scan ~/Pictures --quiet    # which files in here are leaking?
```

---

## Why this exists

A photo from your phone knows where you were to within a few metres, which camera took it, and the exact second the shutter opened. A Word document knows your name, your employer, how many times you saved it, and how long you spent editing. A PDF exported from a design tool knows the local path of the file it came from.

None of that is visible when you look at the file. All of it travels with it when you send it to someone.

Separately, and more recently, files have started carrying provenance claims: C2PA content credentials, `digitalSourceType` assertions, generator tags naming a model. Text picked up its own version of this — zero-width spaces and variation selectors woven between the words, invisible on screen and intact through copy and paste.

`unmark` removes both classes of thing from files you own, and is precise about which is which.

## What it does

| Layer                    | What is removed                                                                                                            | Formats                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Identifying metadata** | GPS, camera make/model/serial, author, copyright, capture and edit timestamps, company, editing duration, local file paths | JPEG, PNG, WebP, PDF, DOCX, ODT, SVG, HTML, Markdown |
| **AI provenance**        | C2PA/JUMBF manifests, XMP provenance claims, generator tags, `data-ai-*` attributes, JSON-LD provenance blocks             | all of the above                                     |
| **Invisible characters** | Zero-width spaces, variation selectors, bidi controls, tag characters, private-use codepoints, exotic spaces               | any text, plus Markdown and HTML bodies              |

It is equally precise about what it will **not** do, which is covered in [Limits](#limits).

## The privacy claim, and how to check it

Most tools in this space ask you to trust a privacy policy. This one is built so you do not have to.

**The engine cannot perform I/O.** [`@unmarkk/core`](packages/core) takes bytes and returns bytes. It has no file-system access, no network client, no dependencies. There is no code path that could send a file anywhere, because there is no code in it that can send anything anywhere.

```bash
# Zero dependencies. Read the whole thing in an afternoon.
npm ls --package-lock-only @unmarkk/core
```

**The browser app is blocked from the network by the browser.** [The page](packages/web) sets `connect-src 'none'` in its Content-Security-Policy, so every `fetch`, XHR, WebSocket and beacon it could attempt is refused by the browser itself. Open the Network tab, drop a file in, and watch nothing happen. The built bundle also contains no network API at all:

```bash
pnpm --filter @unmarkk/web build
grep -c "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" packages/web/dist/assets/*.js   # 0
```

**The server binds to loopback and keeps nothing.** [`@unmarkk/server`](packages/server) defaults to `127.0.0.1`, holds request bodies in memory for exactly the length of the request, never writes them to disk, and never logs a filename or any content.

**Nothing is stored anywhere.** No config file, no cache, no history, no telemetry, no crash reporting, no update check.

## Install

```bash
# Command line
npm install -g @unmarkk/cli

# Library
npm install @unmarkk/core

# Local HTTP API
npm install -g @unmarkk/server
```

| Package                                                            |                          |                            |
| ------------------------------------------------------------------ | ------------------------ | -------------------------- |
| [`@unmarkk/cli`](https://www.npmjs.com/package/@unmarkk/cli)       | the `unmark` command     | `npm i -g @unmarkk/cli`    |
| [`@unmarkk/core`](https://www.npmjs.com/package/@unmarkk/core)     | the engine, as a library | `npm i @unmarkk/core`      |
| [`@unmarkk/server`](https://www.npmjs.com/package/@unmarkk/server) | the local HTTP API       | `npm i -g @unmarkk/server` |

Requires Node 20.11 or newer. No system tools — no `exiftool`, no `qpdf`, no ImageMagick. Every format is parsed directly, which is what lets the same engine run unchanged in a browser.

## Command line

```bash
unmark inspect <path...>     # report what a file carries; changes nothing
unmark clean   <path...>     # write a cleaned copy
unmark scan    <dir...>      # audit a directory tree, ranked worst-first
unmark audit-site <url>      # audit a live site from its sitemap
unmark rewrite <path>        # Layer B: rephrase prose to disturb a sampling watermark
```

```bash
# Inspect, including the stylometry heuristic
unmark inspect draft.md --stylometry

# Clean in place, keeping a .bak
unmark clean report.docx --in-place

# Pipe through stdin
cat draft.txt | unmark clean - > clean.txt

# Audit a folder, then clean only what needs it
unmark scan ~/Pictures --quiet --json \
  | jq -r '.items[] | select(.actionable) | .name' \
  | while read -r f; do unmark clean "$f" --in-place; done

# Audit a public site
unmark audit-site https://example.com/sitemap.xml --quiet

# Rewrite prose — contacts no model by default, just prints the prompt
unmark rewrite draft.md
unmark rewrite draft.md --backend ollama --model llama3.2
```

Exit codes are meant to be useful in a pipeline: `0` nothing found, `1` metadata found (or signals survived a clean), `2` bad input or usage.

Run `unmark --help` for the full option list.

## Agent skills

Two Markdown skills so an assistant can drive this without you explaining it each time — one for files, one for prose. They contain no code; they describe the CLI, what the confidence levels mean, and what the tool cannot do.

```bash
pnpm skills:install --target claude     # ~/.claude/skills
pnpm skills:install --target project    # ./.claude/skills
pnpm skills:install --list
```

Cursor uses rule files instead: copy `integrations/cursor/unmark-text-hygiene.mdc` into `.cursor/rules/`. See [`skills/`](skills/).

## Library

```ts
import { inspect, clean, summarise } from '@unmarkk/core';

const bytes = new Uint8Array(await file.arrayBuffer());

const report = await inspect(bytes, { filename: 'photo.jpg' });
console.log(summarise(report).summary);
// "C2PA manifest, location, device identity, timestamps"

for (const finding of report.findings) {
  console.log(`[${finding.confidence}] ${finding.message}`);
  // [confirmed] Exif block with 5 identifying tags: Artist, DateTime, GPSInfo, Make, Model
}

const { output, actions } = await clean(bytes, { filename: 'photo.jpg' });
```

The same code runs in Node and in the browser. See [`docs/api.md`](docs/api.md).

## HTTP API

```bash
unmark-server --port 8765
```

```bash
curl -X POST localhost:8765/inspect \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Unmark-Filename: photo.jpg' \
  --data-binary @photo.jpg
```

Full spec at `GET /openapi.json`. See [`docs/server.md`](docs/server.md).

## Browser app

```bash
pnpm --filter @unmarkk/web dev
```

Drag files in, read the report, download the cleaned copy. It is a static site — build it and serve the folder from anywhere, or open it with the network unplugged.

## Confidence levels

Every finding carries a confidence, assigned where the finding is produced rather than inferred afterwards from how it was worded:

| Level                   | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `confirmed`             | A structure was parsed. A JUMBF box, an Exif directory, a named property.                    |
| `probable`              | A marker appeared inside a recognised metadata structure, but no claim was parsed out of it. |
| `informational`         | Context. A CMS generator tag, "an XMP packet exists", a stylometry score.                    |
| `likely-false-positive` | A raw byte-scan hit, which collides with compressed data routinely.                          |

A tool that reports everything at the same volume is a tool people stop reading.

## Limits

These are the honest boundaries. A privacy tool that overstates itself is worse than none, because you act on it.

**Statistical text watermarks cannot be removed by editing bytes.** Schemes like SynthID-Text bias token sampling during generation; the signal lives in word choice across a passage, not in any character you could delete. `unmark` will tell you it found nothing and say why. Rewriting the text in your own words is the only thing that touches it — and that is a writing task, not a software one.

**Stylometry is a heuristic, not a detector.** The score measures how text _reads_: sentence-length evenness, formulaic phrasing, lexical diversity. It is reported as informational, dampened hard on short samples, and refuses to produce a number below 30 words. It cannot tell you how a document was produced, and it is off by default.

**Pixel-domain and audio watermarks are out of scope.** Marks embedded in the image data itself survive metadata removal completely. Removing them means re-rendering the image and degrading it, which is a different tool with different tradeoffs.

**Encrypted PDFs are refused, not mangled.** Without the password the object graph cannot be re-serialised. `unmark` says so instead of producing a broken file.

**Legacy Office formats (`.doc`, `.xls`, `.ppt`) are not supported.** They are OLE compound files, an entirely different container. They are detected and refused rather than silently passed through.

**A "clean" result is not a guarantee of anonymity.** File size, timing, writing style, the content itself, and how you send the file all remain. `unmark` removes a specific, well-defined category of leak.

## How it compares

Its closest relatives are `exiftool` (comprehensive metadata editing) and `mat2` (metadata anonymisation). Both are excellent and both are more thorough across obscure formats.

`unmark` differs in three ways that matter for its purpose:

- **It runs where the file already is.** Same engine in a browser tab, a CLI, and a server, with no native binaries to install or trust.
- **It rebuilds rather than edits.** In particular, PDF cleaning re-serialises the document from its object graph. `exiftool -all=` writes an _incremental update_: it drops `/Info` from the trailer, but the original bytes stay in the file and `exiftool` itself can put them back with `-PDF-update:all=`. Rebuilding means removed objects are absent from the output, not merely unreferenced.
- **It reports provenance and identity separately,** because "this was made by a model" and "this was made by me, here, at this time" are different problems that happen to live in the same bytes.

## Documentation

|                                                            |                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                 | Install, first scan, reading the output                                |
| [How to remove metadata](docs/guides/removing-metadata.md) | Practical, task-first: a photo, a document, a PDF, a folder, a website |
| [Text and invisible characters](docs/guides/text.md)       | The Unicode pass, the rewrite layer, and the honest limits of both     |
| [Format reference](docs/formats.md)                        | Exactly what is removed and what is deliberately kept, per format      |
| [API reference](docs/api.md)                               | Using `@unmarkk/core` as a library                                     |
| [HTTP API](docs/server.md)                                 | Running and calling the local service                                  |
| [Browser app](docs/web.md)                                 | Running and hosting the web front end                                  |
| [Architecture](docs/architecture.md)                       | How it is put together, and why                                        |
| [Threat model](docs/threat-model.md)                       | What the guarantees actually cover                                     |
| [Deploying](DEPLOYING.md)                                  | Hosting the web app and the HTTP service                               |

## Repository layout

```
packages/
  core/      Engine. Zero dependencies, isomorphic, no I/O.
    src/
      text/        invisible-character pass, stylometry
      image/       PNG, JPEG, WebP, EXIF
      container/   Markdown, HTML, SVG, DOCX, ODT, PDF
      util/        bytes, CRC-32, ZIP, lossless UTF-8 codec
      detect.ts    binary sniffing and pipeline routing
      audit.ts     aggregate reporting across many files
      rewrite.ts   Layer B prompts and divergence scoring
      pipeline.ts  the unified inspect/clean entry points
  cli/       The `unmark` command. The only package that does I/O or networking.
  server/    Local HTTP API, node:http only.
  web/       Browser front end, processing in a Web Worker.
skills/      Agent skills for files and for text.
integrations/  Cursor rule, and a snippet for project instruction files.
scripts/     Skill installer, scope rename, version bump.
docs/        Guides, architecture, threat model, format notes, API reference.
```

## Development

```bash
pnpm install
pnpm check          # format, lint, typecheck, test
pnpm test           # 237 tests
pnpm build
```

No test fixture is a checked-in binary. Every one is constructed byte by byte in [`packages/core/test/fixtures.ts`](packages/core/test/fixtures.ts) — a repository about metadata should not ship files whose metadata nobody has read.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Intended use

`unmark` is for removing metadata from files you own or are authorised to modify — your photos before you post them, your documents before you send them, your drafts before you publish them.

Stripping provenance from someone else's work in order to misrepresent its origin is a misuse of it, and the fact that a tool can do a thing has never been the same as the thing being right. See [docs/ethics.md](docs/ethics.md).

## License

MIT © Dhirender Choudhary. See [LICENSE](LICENSE).
