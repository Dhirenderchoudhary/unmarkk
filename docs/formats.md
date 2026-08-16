# Formats

What is read, what is removed, and what is deliberately left alone in each format.

The general rule: **remove what describes the file, keep what renders it.** Colour profiles stay. Author names go.

---

## Text (any encoding)

**Removed:** invisible and format Unicode — zero-width space, ZWNJ, ZWJ, word joiner, soft hyphen, bidi controls (LRM, RLM, LRE, RLO, isolates), variation selectors VS1–VS256, Unicode tag characters, private-use codepoints, interlinear annotation marks, and any other `Cf` category character not otherwise accounted for.

**Normalised:** exotic spaces (no-break, en/em, thin, hair, ideographic, …) fold to U+0020. Off with `--keep-spaces`.

**Kept, deliberately:** invisible characters that carry meaning.

| Character                                             | Kept when                | Because                                                                       |
| ----------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| ZWJ, VS15/VS16                                        | after an emoji base      | 👨‍👩‍👧 is six codepoints, two invisible. Stripping them changes what is rendered. |
| ZWNJ, ZWJ                                             | between letters or marks | Orthographic in Persian (می‌روم), Devanagari, and others.                     |
| Tag characters U+E0020–E007F                          | after an emoji base      | Subdivision flags (🏴󠁧󠁢󠁳󠁣󠁴󠁿) are spelled with them.                                 |
| Mongolian FVS                                         | after a Mongolian letter | Selects a glyph form of the preceding letter.                                 |
| Khmer inherent vowels                                 | after a Khmer letter     | Invisible but phonemic.                                                       |
| Hangul fillers                                        | after a jamo             | Hold a slot in a partial syllable.                                            |
| U+0600–0605, U+06DD, U+070F, U+08E2, U+110BD, U+110CD | always                   | Ordinary Arabic and Syriac orthography.                                       |

The same character is contraband when it floats free: a ZWJ between two Latin letters has no orthographic job to do and is removed. `--strip-emoji-glue` removes them all, which breaks family emoji and Persian spelling, and exists for inputs where any invisible character is unacceptable.

**Optional:** `--aggressive` rewrites Latin lookalikes (Cyrillic `а` → `a`, fullwidth forms → ASCII). Off by default because it is genuinely destructive on multilingual text — Cyrillic "Опера" becomes "Onepa".

Non-UTF-8 text round-trips byte-exactly. A Latin-1 or Shift-JIS file comes out unchanged except for what was deliberately removed.

---

## PNG

**Removed:** `tEXt`, `zTXt`, `iTXt` (author, copyright, comments, generator strings), `eXIf` (a full TIFF block — GPS, camera, timestamps), `tIME` (last modification), `caBX`/`juMB`/`c2*` (C2PA/JUMBF containers), and any unknown ancillary chunk carrying a C2PA marker.

**Kept:** `IHDR`, `PLTE`, `IDAT`, `IEND`, `tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `bKGD`, `hIST`, `pHYs`, `sPLT`, and the APNG chunks `acTL`/`fcTL`/`fdAT`.

`iCCP` is a colour profile. Dropping it visibly shifts colours, so it stays.

CRCs are recomputed on output, which means a hand-edited or slightly damaged file comes out well formed. A file with no `IEND` is reported as truncated.

---

## JPEG

**Removed:** APP1 (Exif and XMP), APP2, APP3–APP10, APP11 (JUMBF — where C2PA lives), APP12, APP13 (Photoshop IRB / IPTC — captions, byline, credit), APP15, and `COM` comments.

**Kept:** APP0 (JFIF density) and APP14 (the Adobe colour-transform flag). Both change how the image _decodes_: without APP14, CMYK and YCCK files render with wrong or inverted colours. Neither carries personal data.

The entropy-coded scan is copied from the SOS marker to end of file as one block, so the compressed image data is byte-identical and the output decodes to exactly the same pixels.

Exif is parsed as TIFF rather than string-matched, because tag names are numeric and a string scan finds nothing in it. The embedded thumbnail directory (IFD1) is covered.

---

## WebP

**Removed:** `EXIF`, `XMP `, and the C2PA chunk.

**Kept:** `ICCP` by default (colour profile), `VP8`/`VP8L`/`VP8X`/`ANIM`/`ANMF`/`ALPH`.

The `VP8X` feature flags are rewritten to match what actually remains. A file that claims to have EXIF and does not is rejected by strict decoders.

A malformed container is refused rather than rewritten — chunk boundaries guessed wrong would be re-emitted as truth, and unaccounted-for trailing bytes would vanish silently.

---

## PDF

**Removed:** the document information dictionary (`/Info`: title, author, subject, keywords, creator, producer, creation and modification dates), every XMP metadata stream (`/Type /Metadata`), `/PieceInfo` application scratch data, `/AF` associated-file references, and `/LastModified`.

**Kept:** page content, fonts, images, annotations, form fields, the structure tree. The document renders identically.

The file is **rebuilt**, not edited. Objects are parsed out, metadata objects are dropped, and the survivors are re-emitted with a fresh cross-reference table — so removed data is absent from the output rather than merely unreferenced. This is the difference from `exiftool -all=`, whose incremental update leaves the original bytes in the file and can be reverted with `-PDF-update:all=`.

Object streams (`/Type /ObjStm`) are decompressed and their contents promoted to top level. In a PDF 1.5+ file the Info dictionary is usually inside one, so a cleaner that skips this step removes nothing.

**Refused:** encrypted PDFs. Without the password the object graph cannot be re-serialised, and producing a broken file would be worse than declining.

**Degraded:** if an object stream cannot be expanded (an unsupported filter, a predictor), the result is marked `degraded` and the reason is reported. The output is still safer than the input, but not provably clean.

---

## DOCX

**Removed:** `docProps/custom.xml` and the whole `customXml/` tree, plus these fields cleared in place — `dc:creator`, `cp:lastModifiedBy`, `dc:contributor`, `dc:publisher`, `dcterms:created`, `dcterms:modified`, `cp:lastPrinted`, `cp:revision`, `Application`, `AppVersion`, `Company`, `Manager`, `Template`, `TotalTime`, `LastAuthor`.

`cp:revision` counts saves and `TotalTime` counts minutes spent editing; together they describe a working session.

**Kept:** everything in `word/`, and `dc:title` — a title is content the author wrote deliberately, not a leak.

**Not scanned:** `word/document.xml`. A document that discusses a model in its body is a document about that model. Treating prose as metadata would misfire on every article on the subject.

References to removed parts are cleaned up in `[Content_Types].xml` and `_rels`. A dangling override makes Word offer to repair the file on open, which is worse than leaving the metadata alone.

---

## ODT

**Removed:** the entire contents of `<office:meta>` — `dc:creator`, `meta:initial-creator`, `dc:date`, `meta:creation-date`, `meta:print-date`, `meta:printed-by`, `meta:generator`, `meta:editing-cycles`, `meta:editing-duration`, and any `meta:user-defined` properties.

The element itself is kept but emptied, because OpenDocument requires it to exist.

**Kept:** `content.xml`, `styles.xml`, and everything else. `mimetype` stays first and stored uncompressed, as the format requires.

---

## SVG

**Removed:** `<metadata>` blocks, `<x:xmpmeta>` packets, `<?xpacket?>` wrappers, comments naming a generator, and editor attributes — `inkscape:version`, `sodipodi:docname`, `inkscape:export-filename`, `illustrator:*`, `generator`.

`sodipodi:docname` typically contains the local path of the file on the machine that made it, which is a surprisingly direct leak.

**Kept:** all drawing content — paths, shapes, defs, styles, comments that are not about provenance. The rendered image is identical.

---

## HTML

**Removed:** `<meta>` tags recording AI provenance, JSON-LD blocks containing provenance claims (`digitalSourceType`, `trainedAlgorithmicMedia`, `SoftwareAgent`, C2PA), and `data-ai-*` attributes.

**Kept:** everything else, including CMS generator tags. `<meta name="generator" content="Hugo 0.120">` is CMS provenance, and stripping it from someone's site is vandalism, not privacy. Only a generator tag naming a model vendor is treated as provenance.

Body text also gets the invisible-character pass unless disabled.

---

## Markdown

**Removed:** YAML frontmatter keys recording how the document was produced — `generator`, `ai_generated`, `synthid`, `c2pa`, `provenance`, `digital_source_type`, `created_with`, `model`, `llm`, and any key or value matching the provenance pattern. A nested block travels with its parent key.

**Kept and reported:** `author`, `date`, `email` and similar. These are flagged as identifying, but in a blog post they are the point of the file rather than a leak — removing them is an editorial decision the caller should make explicitly.

Only top-level keys are considered. Parsing YAML properly would mean a dependency or a half-correct parser, and a half-correct parser that rewrites your file is worse than one that admits its limits.

Body text also gets the invisible-character pass unless disabled.

---

## Not supported

| Format                      | Why                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.doc`, `.xls`, `.ppt`      | OLE compound files — a different container entirely. Detected and refused.                           |
| TIFF, HEIC, AVIF, GIF       | Not yet implemented. Detected and refused rather than passed through.                                |
| Audio and video             | Out of scope.                                                                                        |
| Pixel-domain watermarks     | Removing them means re-rendering and degrading the image; a different tool with different tradeoffs. |
| Statistical text watermarks | Not removable by editing bytes. See the README.                                                      |
