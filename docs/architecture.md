# Architecture

## The shape of it

```
                    ┌──────────────┐
   CLI ────────────▶│              │
   HTTP server ────▶│ @unmarkk/core │  bytes in, bytes out
   Web Worker ─────▶│              │  no I/O, no dependencies
                    └──────────────┘
```

Three front ends, one engine. The engine is the only place that knows anything about file formats, and it is deliberately incapable of touching the outside world: no `fs`, no `fetch`, no `process`. Everything that reads or writes a file lives in a wrapper.

This is not architectural neatness for its own sake. It is what makes the privacy claim checkable rather than promised — you can read the whole engine and confirm there is no code in it that could send a file anywhere, and you can confirm the wrappers are small enough to audit in an afternoon.

## Layers inside the engine

```
pipeline.ts          inspect() / clean() / summarise()
    │
detect.ts            sniffBinary() — "would treating this as text destroy it?"
    │                classify()    — "which pipeline owns this?"
    ├──────────────┬────────────────────┐
    ▼              ▼                    ▼
  text/          image/             container/
  unicode.ts     png.ts             markdown.ts   ooxml.ts
  stylometry.ts  jpeg.ts            html.ts       odf.ts
  tables.ts      webp.ts            svg.ts        pdf.ts
                 exif.ts                          vocab.ts
                       │                    │
                       └────────┬───────────┘
                                ▼
                    util/  bytes, crc32, zip, text-codec
                    markers.ts  shared marker vocabulary
```

### `util/text-codec.ts`

The least obvious file and one of the more important.

`TextDecoder` replaces bytes it cannot decode with U+FFFD. That is fine for display and destructive for a tool that writes the file back: cleaning a Latin-1 or Shift-JIS document would silently corrupt every non-ASCII byte in it. So this module escapes instead of replacing: an undecodable byte `0xNN` becomes the lone low surrogate `U+DCNN`, which encodes back to exactly `0xNN`.

The round trip is byte-exact for any input, valid UTF-8 or not. It also rejects overlong encodings and CESU-8 surrogate halves, which are the classic ways to smuggle bytes past a filter, escaping them instead of decoding them.

### `util/zip.ts`

DOCX and ODT are ZIP archives, so editing them means unpacking and repacking. Built on `CompressionStream`/`DecompressionStream`, which ship in Node 18+ and every current browser — which is what lets the package stay dependency-free and run in both.

Two properties matter for round-tripping office documents: entry order is preserved (ODT is only valid if `mimetype` is first and stored uncompressed), and each entry's original compression method is preserved. Everything is budgeted — a 40 KB archive that expands to 4 GB is a denial of service, not a document.

### `detect.ts`

Two questions people conflate:

`sniffBinary` asks whether treating these bytes as text would destroy them. It is deliberately conservative: text in encodings other than UTF-8 must keep working, so undecodable bytes are never on their own proof of anything. It looks for magic numbers, NUL bytes, and an implausible density of control bytes.

`classify` asks which pipeline owns the input. The extension wins when it names a known format — a `.md` file that happens to start with `<html>` is still Markdown to its author — and magic bytes decide otherwise. Unrecognised bytes fall back to text, and callers that must not mangle an unknown binary check `sniffBinary` first.

### `markers.ts`

One shared vocabulary, asked two separate questions of every metadata blob:

1. Does it carry AI provenance? (C2PA manifests, `digitalSourceType`, a vendor name in a generator field.)
2. Does it carry _you_? (GPS, a camera serial, your name in an Artist tag, the second the shutter opened.)

The second question is the one that matters more often and the one most provenance tooling ignores.

### `image/exif.ts`

EXIF is binary TIFF: tags are numeric, so a string scan finds nothing in it. Without a real directory walker, a photo straight off a phone would be reported as carrying no identifying metadata while holding the coordinates of the room it was taken in.

The walker reads structure only — it never decodes values — so a malformed offset can mislead a report but cannot read out of bounds. Directory counts are capped, pointer chasing is depth-limited, and visited offsets are tracked so a self-referential IFD chain terminates instead of hanging.

It also follows IFD1, the embedded thumbnail. A thumbnail that still shows the unredacted original is a real leak and an easy one to miss.

### `container/pdf.ts`

The most involved parser in the project, and the one where the obvious approach is wrong.

The conventional approach — `exiftool -all=` — does not do what people think. exiftool edits PDFs _incrementally_: it appends an update that frees the Info object and drops `/Info` from the trailer, but the original metadata bytes stay in the file verbatim, and exiftool itself will put them back with `-PDF-update:all=`. A file cleaned that way still contains your name; it has only stopped advertising it.

So this module rebuilds the document. Every object is parsed out, the ones carrying metadata are dropped, the survivors are re-emitted with a fresh cross-reference table, and anything not written out is simply not in the output.

Object numbers are preserved rather than compacted. Renumbering would mean rewriting every reference in every object, including references inside compressed content streams — far more ways to break a document than leaving gaps and marking them free, which is exactly what free xref entries are for.

Object streams (`/Type /ObjStm`) are decompressed and their contents promoted to top-level objects. This matters more than it sounds: in a PDF 1.5+ file the Info dictionary itself is usually _inside_ one, so a cleaner that does not expand them removes nothing at all.

### `container/ooxml.ts`

Note what is _not_ scanned: `word/document.xml`. A document that discusses a model in its body text is a document about that model, not one written by it, and treating prose as metadata would produce a false positive on every article ever written about AI.

When a part is removed, the references to it go too — `[Content_Types].xml` overrides and `_rels` relationship entries. A DOCX with a dangling override makes Word offer to "repair" the file on open, which is a worse outcome than leaving the metadata in.

## Report contract

```ts
interface Finding {
  code: string; // stable machine id, safe to match on
  message: string; // human sentence, wording may change
  confidence: Confidence;
  at?: string; // byte offset, part name, key
}
```

Confidence is assigned **where the finding is emitted**, never inferred afterwards from the wording. The parser that just read a JUMBF box knows more about what it saw than any classifier reading the sentence about it. Inferring severity by pattern-matching a message after the fact is how a tool ends up reporting a byte-scan coincidence and a parsed Exif directory at the same volume.

`code` is stable and `message` is not — scripts match on `code`.

## Async, and why

`inspect` and `clean` are async because `DecompressionStream` is. That is the only reason. Text and image paths do no real asynchronous work; the uniform signature exists so callers do not have to know which formats happen to involve a ZIP.

## Testing

No fixture is a checked-in binary. Every PNG, JPEG, WebP, DOCX, ODT and PDF used in the tests is constructed byte by byte in `packages/core/test/fixtures.ts`, so what is being tested is visible in the test — and a repository about metadata does not ship files whose metadata nobody has read.

The assertions that matter most are properties a user would care about: the author's name is absent from the output bytes; the page content is byte-identical before and after; cleaning twice changes nothing the second time.
