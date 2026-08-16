# The limits, and why they exist

A privacy tool that overstates itself is worse than none, because people act on
it. These are the boundaries, with the reasoning, so you can explain them rather
than just repeat them.

## Statistical text watermarks cannot be removed by editing bytes

Schemes such as SynthID-Text work at generation time. The model's vocabulary is
partitioned by a keyed pseudorandom function, and sampling is nudged toward one
partition. No individual character is special; the signal is a statistical bias
in _which words were chosen_, detectable only across a passage and only by
someone holding the key.

There is nothing to delete. `unmark inspect` reports finding no invisible
carriers, which is true and is not the same as "no watermark".

What actually disturbs it is rewriting the prose, because a rewrite changes word
choice — which is the carrier. That is what `unmark rewrite` and the
`unmark-text` skill are for. Two honest caveats to pass on:

- The amount of signal removed **cannot be measured** without the key. Anyone
  claiming a percentage is guessing.
- Longer passages carry more signal and retain more of it after one pass.

Never say "undetectable". Say what was done.

## Stylometry is a heuristic, not a detector

The `--stylometry` score measures how text _reads_: how even the sentence
lengths are, how many formulaic transitions it uses, how tightly its vocabulary
clusters. Machine-written text tends to score high on all three.

So does some human writing — technical documentation, translated text, anything
written to a template, and anyone who was taught to write with connectives.

The score is reported as `informational`, dampened hard below 100 words,
refused entirely below 30, and off by default. Presenting it as a verdict would
be wrong in both directions: it would accuse careful writers and clear careless
machines.

If someone wants to use it to accuse a person of something, decline. It cannot
support that.

## Pixel-domain and audio watermarks are out of scope

A mark embedded in the image data itself — not in a metadata block — survives
metadata removal completely, because metadata removal does not touch pixels.

Removing one requires regenerating the image, and the trade is worth being clear
about: the output is a **different image**. Fine detail moves. For photographs
of people, that can matter more than the watermark did.

That is a different tool with different trade-offs, and it is out of scope here.
For the overwhelming majority of privacy work it is not what anyone needs
anyway — the metadata is the leak.

## Encrypted PDFs are refused

Without the password the object graph cannot be re-serialised. `unmark` says so
and stops, rather than producing a file that looks cleaned and is broken.

## A clean file is not an anonymous file

Metadata is one channel. What remains after a successful clean:

- the content itself, including anything identifying _in_ it
- file size, and how it compresses
- when it was sent, and to whom, and from where
- writing style, in text
- for photographs: everything visible in the frame

`unmark` removes a specific, well-defined category of leak. It does not make
someone anonymous, and should never be described as though it does.

## Unknown metadata in unknown places

The engine models the formats it knows. An unrecognised private chunk in a PNG
is left alone unless it carries a provenance marker, because removing every
unknown chunk would break legitimate application data.

If a threat model does not tolerate that, the answer is to re-encode the file
through an image editor, which discards everything the encoder does not
understand — at the cost of a re-compression generation.
