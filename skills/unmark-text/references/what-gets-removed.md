# Character classes

## Removed

**Zero-width family** — U+200B zero width space, U+200C non-joiner, U+200D
joiner, U+2060 word joiner, U+FEFF byte-order mark, U+180E Mongolian vowel
separator. The classic carriers: invisible, survive copy-paste, and a run of
them encodes bits.

**Bidirectional controls** — U+061C, U+200E/200F, U+202A–202E, U+2066–2069.
Beyond watermarking these enable filename spoofing: `invoice‮fdp.exe` renders
as `invoicexe.pdf`.

**Variation selectors** — U+FE00–FE0F and the supplement U+E0100–E01EF. Two
hundred and fifty-six of them, stackable after any character, and invisible.

**Unicode tag characters** — U+E0001, U+E0020–E007F. An entire ASCII alphabet
with no rendering, which is exactly as useful for hiding data as it sounds.

**Private-use codepoints** — U+E000–F8FF and the supplementary planes. No
portable meaning by definition.

**Other format characters** — anything else in category `Cf` not on the keep
list, so new Unicode additions are covered rather than missed.

**Soft hyphen** (U+00AD), **combining grapheme joiner** (U+034F), and the
**interlinear annotation** marks.

## Normalised

Exotic spaces fold to U+0020: no-break, Ogham, en quad, em quad, en, em,
three-per-em, four-per-em, six-per-em, figure, punctuation, thin, hair, narrow
no-break, medium mathematical, ideographic.

Disable with `--keep-spaces` when the spacing is doing layout work.

## Kept, because removing them corrupts text

This is the part that separates a usable tool from one that breaks documents.
An invisible character is only contraband when it has no job to do — so each
decision is made in context, based on what precedes it.

| Character                                             | Kept when                | What breaks otherwise                            |
| ----------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| ZWJ, VS15, VS16                                       | after an emoji base      | 👨‍👩‍👧 becomes three separate people; ❤️‍🔥 falls apart |
| ZWNJ, ZWJ                                             | after a letter or mark   | Persian می‌روم, Devanagari क्‍ष misspell         |
| Tag characters U+E0020–E007F                          | after an emoji base      | 🏴󠁧󠁢󠁳󠁣󠁴󠁿 and other subdivision flags stop rendering    |
| Mongolian free variation selectors                    | after a Mongolian letter | the wrong glyph form is selected                 |
| Khmer inherent vowels U+17B4/17B5                     | after a Khmer letter     | invisible but phonemic — the word changes        |
| Hangul jamo fillers                                   | after a jamo             | a partial syllable loses its slot                |
| U+0600–0605, U+06DD, U+070F, U+08E2, U+110BD, U+110CD | always                   | ordinary Arabic and Syriac orthography           |

The same codepoint floating free is removed. A zero-width joiner between two
Latin letters is not doing orthography.

`--strip-emoji-glue` removes them all, including the load-bearing ones. It
exists for inputs where any invisible character is unacceptable and the caller
accepts the breakage.

## Optional, off by default

**Latin lookalikes** (`--aggressive`) — Cyrillic а/е/о/р/с, fullwidth forms.
Used for spoofing (`pаypal.com` with a Cyrillic а), but also completely normal
in any multilingual document. Rewriting them turns Cyrillic "Опера" into
"Onepa". Ask first.

**NFKC normalisation** (`--nfkc`) — folds compatibility characters: ﬁ becomes
fi, ① becomes 1, fullwidth becomes ASCII. Changes visible characters, so it is
a content decision rather than a hygiene one.

## Encoding safety

Text in encodings other than UTF-8 round-trips byte-exactly. A Latin-1 or
Shift-JIS file comes out unchanged apart from what was deliberately removed —
the tool does not decode-and-re-encode through a lossy path, which is how most
naive cleaners corrupt non-English documents.
