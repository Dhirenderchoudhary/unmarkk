# What gets removed, per format

The rule throughout: **remove what describes the file, keep what renders it.**
Colour profiles stay. Author names go.

## Images

| Format   | Removed                                                                                                                        | Kept, deliberately                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **PNG**  | `tEXt`/`zTXt`/`iTXt` (author, copyright, comments, software), `eXIf` (a full TIFF block with GPS), `tIME`, C2PA private chunks | `iCCP` colour profile, `gAMA`, `sRGB`, `cHRM`, all APNG chunks |
| **JPEG** | APP1 (Exif and XMP), APP2, APP11 (JUMBF/C2PA), APP13 (IPTC byline and credit), `COM` comments                                  | APP0 (JFIF density) and APP14 (Adobe colour transform)         |
| **WebP** | `EXIF`, `XMP `, C2PA chunk; `VP8X` feature flags rewritten to match                                                            | `ICCP` colour profile                                          |

APP0 and APP14 are kept because dropping them changes how the image _decodes_ —
without APP14, CMYK and YCCK files render with wrong or inverted colours.
Neither carries personal data.

The JPEG entropy-coded scan is copied byte for byte, so the output decodes to
exactly the same pixels.

## Documents

| Format       | Removed                                                                                                                                                             | Kept                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **PDF**      | `/Info` (title, author, creator, producer, dates), XMP metadata streams, `/PieceInfo`, `/AF`, `/LastModified`                                                       | Page content, fonts, images, annotations, form fields                       |
| **DOCX**     | `docProps/custom.xml`, the `customXml/` tree; creator, last-modified-by, revision count, created/modified dates, Application, Company, Manager, Template, TotalTime | Everything in `word/`, and `dc:title`                                       |
| **ODT**      | The whole contents of `<office:meta>`: creator, initial creator, dates, generator, editing cycles, editing duration, user-defined properties                        | `content.xml`, `styles.xml`, and the required empty `<office:meta>` element |
| **SVG**      | `<metadata>` blocks, XMP packets, `sodipodi:docname` (a local file path), `inkscape:version`, generator comments                                                    | All drawing content                                                         |
| **HTML**     | AI provenance `<meta>` tags, JSON-LD provenance blocks, `data-ai-*` attributes                                                                                      | CMS generator tags, everything else                                         |
| **Markdown** | Frontmatter keys recording how the document was made: `generator`, `ai_generated`, `model`, `provenance`, and similar                                               | `author`, `date` and other editorial keys — reported, not removed           |

Two of these deserve explanation.

**PDF is rebuilt, not edited.** The usual approach — `exiftool -all=` — writes
an _incremental update_: it drops `/Info` from the trailer but the original
bytes stay in the file, and `exiftool` itself can restore them with
`-PDF-update:all=`. `unmark` re-serialises the document from its object graph,
so removed objects are absent rather than merely unreferenced. It also expands
object streams first, because in PDF 1.5+ files the Info dictionary usually
lives inside one.

**DOCX body text is not scanned.** A document that discusses a model in its
prose is a document _about_ that model. Treating body text as metadata would
produce a false positive on every article ever written about AI. Only
`docProps/` and `customXml/` are examined.

When a part is removed, its references go too — `[Content_Types].xml` overrides
and `_rels` entries. A DOCX with a dangling override makes Word offer to repair
the file, which is worse than leaving the metadata alone.

## Text

Removed: zero-width space, ZWNJ, ZWJ, word joiner, soft hyphen, bidi controls,
variation selectors, Unicode tag characters, private-use codepoints, and any
other format character not otherwise accounted for.

Normalised: exotic spaces (no-break, en, em, thin, hair, ideographic) fold to a
normal space. Disable with `--keep-spaces`.

**Kept, because they carry meaning:**

| Character                                            | Kept when                          | Why                                            |
| ---------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| ZWJ, VS15/VS16                                       | after an emoji                     | 👨‍👩‍👧 is six codepoints, two invisible            |
| ZWNJ, ZWJ                                            | between letters                    | orthographic in Persian, Devanagari and others |
| Tag characters                                       | after an emoji                     | subdivision flags are spelled with them        |
| Mongolian FVS, Khmer inherent vowels, Hangul fillers | after a letter of their own script | phonemic or structural                         |
| U+0600–0605, U+06DD, U+070F                          | always                             | ordinary Arabic and Syriac orthography         |

The same character is contraband when it floats free — a ZWJ between two Latin
letters has no orthographic job — and is removed there.

## Not supported

`.doc`/`.xls`/`.ppt` (OLE compound files), TIFF, HEIC, AVIF, GIF, audio and
video. These are **detected and refused**, not silently passed through, so a
file that cannot be cleaned never comes back reported as clean.
