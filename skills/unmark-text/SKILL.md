---
name: unmark-text
description: >
  Apply a final hygiene pass to prose a reader will see — remove invisible
  Unicode carriers that arrived via copy-paste, and optionally rephrase to
  reduce statistical watermark signal. Use when asked to clean, polish or
  finalise articles, documentation, reports, emails, product copy, UI strings,
  Markdown or HTML prose. Do not use for code-only tasks, and never to help
  misrepresent authorship.
---

# Text hygiene

Two different problems, in order of how reliably they can be solved.

**Invisible characters** get into text by accident far more often than by
design: a bad copy-paste, a CMS that inserts soft hyphens, a word processor
using non-breaking spaces for layout. They break search, diffs, screen readers
and string comparison. Removing them is deterministic and safe.

**Statistical watermarks** are the harder case, and the honest answer is
covered at the bottom.

## The deterministic pass

```bash
unmark inspect draft.md              # what is in there
unmark clean draft.md -o clean.md    # remove it
```

Or in a pipeline:

```bash
cat draft.md | unmark clean - > clean.md
```

Inspect before cleaning when editing an existing file. Show the user what was
found; it is usually more interesting than the removal.

### Defaults worth knowing

- **Exotic spaces are normalised** to a plain space. For prose that is right.
  For anything where a non-breaking space is doing layout work — a table, a
  measurement like `5 kg`, a French guillemet — pass `--keep-spaces`.
- **Emoji and script joiners are preserved.** 👨‍👩‍👧 is six codepoints, two of
  them invisible, and Persian می‌روم needs its zero-width non-joiner. The tool
  keeps invisibles that sit after a base they belong to and removes the ones
  floating free. Only use `--strip-emoji-glue` if the user explicitly wants
  every invisible character gone and accepts that it breaks those.
- **`--aggressive` and `--nfkc` are off for a reason.** The first rewrites
  Cyrillic and fullwidth lookalikes to ASCII, which mangles multilingual text.
  The second changes visible characters. Ask before either.

## Protect the non-prose

When prose and code are mixed, the deterministic pass is safe on the whole file
— it never touches ASCII. But if you are _rewriting_ rather than cleaning,
leave these alone byte for byte:

- fenced and inline code
- commands, paths, URLs, identifiers, API names
- formulas, citations, and anything quoted verbatim
- required legal, academic or platform disclosures

Rewriting a variable name inside a code block because it read awkwardly is a
bug, not a polish.

## Statistical watermarks, honestly

Some text carries a watermark that is not made of characters. Token-sampling
schemes bias which words a model picks during generation; the signal is spread
across word choice over a whole passage. There is no character to delete, and
`unmark inspect` correctly reports finding nothing.

The only thing that disturbs it is rewriting the prose:

```bash
unmark rewrite draft.md                                  # prints a prompt, contacts nothing
unmark rewrite draft.md --backend ollama --model llama3.2
```

The default backend prints a prompt and stops — you run it wherever you like,
and the text never leaves the machine. A live backend must be on loopback
unless `--allow-remote` is passed, which exists so nobody sends a private
document to a remote inference endpoint by accident.

Then clean again, because a model can introduce invisible characters of its own.

### What to tell the user afterwards

Separate the three categories, every time:

- **Verified:** invisible characters removed, with counts. You can re-inspect
  the bytes and confirm this.
- **Attempted:** the prose was rewritten, which changes the word choice a
  sampling watermark rides on. How much signal remains cannot be measured
  without the scheme's key.
- **Not established:** that a detector would no longer fire, that the text is
  undetectable, or that it proves human authorship. None of these follow.

Never compress those three into "cleaned".

## When not to use this

- **Code-only tasks.** Format the code instead.
- **Text you were asked to quote exactly.**
- **Anything where the point is to misrepresent who wrote something.** See
  `references/responsible-use.md`. One clear sentence, then help only with what
  the user actually owns.

## Reading more

- `references/what-gets-removed.md` — the exact character classes, and which are kept
- `references/responsible-use.md` — where this stops
