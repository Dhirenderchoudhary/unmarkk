# Where this stops

Text hygiene is not controversial. Removing zero-width characters that arrived
through a bad paste is cleanup, and nobody needs a justification for it.

Rewriting prose to reduce a statistical watermark is a different act, and the
context decides whether it is reasonable.

## Reasonable

- **Privacy.** You drafted something with a model's help, you are publishing it
  under your own name, and you would rather it not carry a marker identifying
  which service you used. That is the same instinct as stripping EXIF.
- **Hygiene before publication.** Removing artefacts of the tools you used,
  the way you would remove tracked changes or a template's placeholder text.
- **Research.** Measuring how robust a scheme is, which is how these schemes
  get improved.
- **Your own work, your own name.** The default case.

## Not reasonable

- Submitting machine-written work where you have been asked to declare it, and
  using the rewrite to make the declaration harder to check.
- Passing off someone else's writing as your own.
- Removing a disclosure you are legally or contractually required to make.

The technical operation is identical in all of these. What differs is what the
person is doing with it, and that is not something a tool can detect.

## How to handle a request that crosses the line

Say it once, plainly, without a lecture:

> Removing a watermark doesn't change what you'd be declaring. If you've been
> asked whether this was machine-assisted, the honest answer is the same either
> way — but I can still do the text cleanup on work you own.

Then do the technical part for material they own, and stop bringing it up.

What not to do:

- Refuse the whole request because part of it was uncomfortable. Text hygiene
  on someone's own draft is legitimate regardless of what else they mentioned.
- Repeat the caveat every turn. Once is honest; three times is nagging.
- Help with the deception itself — drafting the false declaration, writing the
  "this is entirely my own work" statement, or claiming the result is
  undetectable.

## Three claims to never make

**"This is undetectable."** You cannot know that. Nobody can measure how much
signal a rewrite removed without the scheme's key.

**"This proves a human wrote it."** Absence of a watermark establishes nothing.
Most human writing carries no watermark, and so does plenty of machine writing.

**"This is clean."** Too compressed to be honest. Say which part is verified
(invisible characters removed, re-inspectable) and which part is an attempt
(the prose was rewritten).

## The reporting habit

Every time, three buckets:

|                     |                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| **Verified**        | Characters removed, with counts. Re-inspect the output and confirm.                              |
| **Attempted**       | Prose rewritten, changing the word choice a sampling watermark rides on. Magnitude unmeasurable. |
| **Not established** | Detector evasion, human authorship, removal of a keyed watermark.                                |

That structure is the whole of responsible use here. Someone reading it knows
exactly what they have and can decide for themselves.
