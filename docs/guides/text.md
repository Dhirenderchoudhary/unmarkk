# Text: invisible characters and watermarks

Text carries two very different things. One is deterministic and removable. The
other is neither, and this guide is careful about the difference.

---

## Invisible characters

Characters with no visual form that travel with text through copy and paste:
zero-width spaces, soft hyphens, bidirectional controls, variation selectors,
Unicode tag characters.

They get into text by accident far more often than by design — a bad paste, a
CMS inserting soft hyphens, a word processor using non-breaking spaces for
layout. They break search, diffs, string comparison and screen readers.

### See what is in there

```bash
unmark inspect draft.md
```

```
draft.md  text/text  found
  4 invisible characters across 3 codepoints

  [probable] U+200B ZERO WIDTH SPACE (Cf) x2 (offset 5)
  [probable] U+00AD SOFT HYPHEN (Cf) x1 (offset 11)
  [info]     U+3000 IDEOGRAPHIC SPACE (Zs) x1 (offset 26)
```

The **web app's Text tab** is better for this. Paste the text and every
invisible character is rendered inline as a visible chip, so you can see the
three sitting between "the" and "quick" rather than being told a count. That is
usually the difference between a warning you can act on and one you cannot.

### Remove them

```bash
unmark clean draft.md
cat draft.md | unmark clean - > clean.md      # or through a pipe
```

### What is deliberately kept

This is the part that separates a usable tool from one that corrupts
documents. An invisible character is only contraband when it has no job to do,
so each decision is made from what precedes it:

| Kept                                        | When                   | What breaks otherwise                |
| ------------------------------------------- | ---------------------- | ------------------------------------ |
| ZWJ, VS15/VS16                              | after an emoji         | 👨‍👩‍👧 becomes three separate people     |
| ZWNJ, ZWJ                                   | after a letter         | Persian می‌روم misspells             |
| Tag characters                              | after an emoji         | 🏴󠁧󠁢󠁳󠁣󠁴󠁿 stops rendering                   |
| Mongolian FVS, Khmer vowels, Hangul fillers | after their own script | wrong glyph, or a lost syllable slot |
| Arabic and Syriac format marks              | always                 | ordinary orthography                 |

The same codepoint floating between two Latin letters is removed.

`--strip-emoji-glue` removes all of them, breakage included. Only for inputs
where no invisible character is acceptable.

### Options worth knowing

```bash
unmark clean draft.md --keep-spaces      # leave NBSP and friends alone
unmark clean draft.md --aggressive       # rewrite Cyrillic/fullwidth lookalikes
unmark clean draft.md --nfkc             # NFKC normalisation
```

`--keep-spaces` matters when a non-breaking space is doing layout work — a
table, `5 kg`, a French guillemet.

`--aggressive` is destructive on multilingual text: Cyrillic "Опера" becomes
"Onepa". Only for text you know should be plain Latin.

### Encodings

Text that is not UTF-8 round-trips byte-exactly. A Latin-1 or Shift-JIS file
comes out unchanged apart from what was deliberately removed. Most naive
cleaners corrupt those files by decoding through a lossy path; this one does
not.

---

## Statistical watermarks

Now the honest part.

Some text carries a watermark that **is not made of characters**. Schemes like
SynthID-Text work at generation time: the model's vocabulary is partitioned by
a keyed pseudorandom function and sampling is nudged toward one partition. No
individual character is special. The signal is a statistical bias in _which
words were chosen_, spread across a passage, detectable only by someone holding
the key.

**There is nothing to delete.** `unmark inspect` will correctly report finding
no invisible carriers, and that is not the same as "no watermark".

### What actually disturbs it

Rewriting the prose, because a rewrite changes word choice — which is the
carrier.

```bash
unmark rewrite draft.md
```

By default this **contacts no model**. It prints a prompt and stops; you run it
wherever you like and the text never leaves your machine. That is the right
default for a tool whose premise is that your content stays local.

To use a local model:

```bash
unmark rewrite draft.md --backend ollama --model llama3.2
unmark rewrite draft.md --backend openai-compatible --base-url http://127.0.0.1:8080
```

Endpoints must be on loopback unless you pass `--allow-remote`, which prints a
warning saying your text is leaving the machine. API keys are read from
`UNMARK_REWRITE_API_KEY` only — never from the command line, where they would
land in `ps` and shell history.

### Modes

```bash
unmark rewrite --list
```

| Mode                                       | What it does                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `paraphrase`                               | Change wording and syntax, keep every claim. The default.                                    |
| `humanize`                                 | Rewrite so it reads as if written from scratch.                                              |
| `code`                                     | Rewrite comments and local names only; behaviour untouched.                                  |
| `outline` → `expand`                       | Reduce to claims, then write fresh prose. The strongest, and the most likely to lose nuance. |
| `backtranslate-out` → `backtranslate-back` | A round trip through another language.                                                       |

Generate several and keep whichever moved furthest:

```bash
unmark rewrite draft.md --backend ollama --candidates 3
```

"Furthest" is bigram Jaccard distance — word _pairs_, not single words, because
a rewrite that swaps synonyms while keeping the sentence shape has barely
moved, and sentence shape is a large part of what these schemes ride on.

### What you get told afterwards

```
draft.md -> draft.rewritten.md
  62% of word pairs changed · 340 words · residual signal moderate

  A rewrite changes word choice, which is what a token-sampling watermark is
  carried in. How much signal remains cannot be measured without the scheme key.
  This is not a detection result.
```

Note what that does **not** say. It does not say the watermark is gone, because
nobody can know that without the key.

### The three categories

When reporting on text work, keep these separate:

|                     |                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------- |
| **Verified**        | Invisible characters removed, with counts. Re-inspect and confirm.                      |
| **Attempted**       | Prose rewritten, changing the word choice a watermark rides on. Magnitude unmeasurable. |
| **Not established** | That a detector would no longer fire. That a human wrote it.                            |

Anything that collapses those into "cleaned" is overclaiming.

---

## The stylometry score

```bash
unmark inspect draft.md --stylometry
```

```
  stylometry  MEDIUM  score 0.582
  412 words, 24 sentences, burstiness 0.31, diversity 0.71, marker density 1.2/100w
```

It measures three things machine-written text tends to do: keep sentence
lengths unnaturally even, lean on formulaic transitions, and cluster in a
narrow band of lexical diversity.

**It is a heuristic, and it is wrong regularly.** Technical documentation,
translated text, anything written to a template, and anyone taught to write
with connectives all score high. It is reported as `informational`, dampened
below 100 words, refused below 30, and off by default.

It cannot tell you how a document was produced. If someone wants to use it to
accuse a person of something, it does not support that.

---

## Related

- [How to remove metadata](removing-metadata.md) — files rather than text
- [Character classes](../../skills/unmark-text/references/what-gets-removed.md) — the full table
- [Responsible use](../../skills/unmark-text/references/responsible-use.md) — where this stops
