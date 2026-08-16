# Threat model

## What is being protected

The contents and provenance of files the operator owns, from disclosure they did not intend when they share the file.

Concretely: the coordinates in a holiday photo, the employer in a CV's document properties, the local file path in an exported SVG, the number of times a contract was revised, the name of whoever last saved it.

## Who the adversary is

**The recipient of the file.** Someone who receives a document and reads more from it than was meant. This is the common case and it requires no skill — every image viewer shows EXIF.

**A crafted input.** A file designed to make the tool misbehave: exhaust memory, hang, write outside its destination, or produce output that appears clean and is not.

**A network observer, if you expose the server.** Out of scope for the default configuration, which binds to loopback.

## Who the adversary is not

**The operator.** Anyone running the tool already has the files. There is no privilege boundary between the user and the CLI.

**A local attacker with code execution.** If something else on your machine is running as you, this tool is not what stands between it and your documents.

## Trust boundaries

```
┌──────────────────────────────────────────────────┐
│ operator's machine                               │
│                                                  │
│  ┌────────────┐        ┌──────────────────────┐  │
│  │ file bytes │───────▶│ @unmarkk/core         │  │
│  │ UNTRUSTED  │        │ no I/O capability    │  │
│  └────────────┘        │ no dependencies      │  │
│                        └──────────────────────┘  │
│                                 │                │
│                        ┌──────────────────────┐  │
│                        │ CLI / server wrapper │  │
│                        │ the only I/O         │  │
│                        └──────────────────────┘  │
└──────────────────────────────────────────────────┘
                     ✗ no egress
```

Every byte the engine sees is hostile. Every byte it returns goes somewhere the operator chose.

## Properties the design provides

### No exfiltration path

`@unmarkk/core` has no dependencies and no I/O capability. It cannot open a file or a socket because nothing in it can. This is stronger than a policy: there is no configuration that would enable it and no dependency update that could introduce it, because there are no dependencies.

The browser front end is additionally confined by the page's Content-Security-Policy (`connect-src 'none'`), which means the browser refuses the requests rather than the page choosing not to make them. The built bundle contains no network API at all, which is checkable with `grep`.

### No persistence

Nothing is written except the output file the operator asked for. No config, no cache, no history, no temporary copy of the input, no crash dump. The server holds bodies in memory for the duration of a request and discards them. Reloading the web app loses everything.

### Bounded resource use

Every parser reads attacker-controlled bytes, so:

- input size is capped (`UNMARK_MAX_INPUT_BYTES`, `UNMARK_MAX_STDIN_BYTES`, `UNMARK_MAX_BODY_BYTES`)
- ZIP expansion is budgeted against decompression bombs, and entry counts are capped
- EXIF directory counts are capped and pointer chains are depth-limited, with visited offsets tracked so a self-referential IFD terminates
- every structural read is bounds-checked; a malformed offset produces a note, not an out-of-bounds read

### Safe writes

The CLI writes to a temporary file in the destination directory, flushes it, then renames it into place. An interrupted run cannot leave a half-written document where the original was. Writes refuse to follow a symlink, so a pre-placed link in a downloads or temp directory cannot redirect a clean onto an arbitrary victim file. `--in-place` takes a `.bak` copy first, before anything is overwritten.

### Honest failure

The tool refuses rather than guesses:

- binary input routed to the text pipeline is refused, because decoding a DOCX as text and writing it back destroys the file
- an encrypted PDF is refused, because its objects cannot be re-serialised
- an unsupported format is refused, not passed through and reported as clean
- a partial rebuild sets `degraded` and says so

A tool that quietly does nothing is more dangerous than one that fails loudly, because the user publishes the file either way.

## Residual risks

**Content is still content.** The words in a document, the faces in a photo, the size of the file, the time you sent it. `unmark` removes a specific category of metadata, not linkability.

**Statistical text watermarks survive.** They are carried in word choice across a passage, not in any byte you could delete. Documented in the README.

**Pixel-domain and audio watermarks survive.** Out of scope; removing them requires re-rendering and degrading the media.

**Unknown metadata in unknown formats.** The engine models the formats it knows. An unrecognised private chunk in a PNG is left alone unless it carries a marker, because removing every unknown chunk would break legitimate application data. If your threat model does not tolerate that, re-encode the file.

**Thumbnails and embedded previews.** EXIF IFD1 is detected and removed with the rest of the block. Embedded previews in other containers (an ODT `Thumbnails/` entry, for instance) are left in place — they are a rendering of content you are already sharing, but if that matters to you, check.

**The wrapper is where the risk is.** The engine cannot exfiltrate; the CLI and server can read and write files by definition. They are deliberately small for that reason.

## If you expose the server

The default bind is `127.0.0.1` and the tool warns when it is not. Anything sent to this service is a document somebody did not intend to publish. If you make it reachable:

- set an API key (`--api-key`), which is compared in constant time
- put it behind TLS
- leave `--log` off, or accept that you are logging method, path and status (never filenames or content)
- leave CORS unset unless you specifically need a browser origin; the default sends no CORS headers at all
