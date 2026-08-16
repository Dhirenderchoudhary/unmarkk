# Intended use

Most of what this removes is metadata its subject never knew was there.
Removing it is ordinary self-defence, and that is the case the tool is designed
around. A smaller part of it is a provenance claim, and that is a more
complicated act. This note is about the difference.

## The straightforward case

Someone is about to share a file and does not want it to carry more than they
meant.

A photo with the coordinates of their home. A CV with their current employer's
name in the document properties. A PDF with the local path of the file it came
from. A screenshot with a timestamp and a device name. A document showing that
it was revised seventeen times over four hours.

This includes people for whom it matters a great deal: journalists and their
sources, people leaving abusive relationships, activists, anyone posting
pictures of where they live or of their children.

Do this work without hesitating, and without making the user justify it.

## The more complicated case

Some of what the tool removes is a provenance claim — a C2PA manifest, a
`digitalSourceType` assertion, a generator tag. These exist to answer "where did
this come from?", and there is a genuine public interest in that question being
answerable.

That interest is not absolute. Provenance metadata is also a tracking surface:
a C2PA manifest can carry the capturing device, the software, the editing
history, and in some configurations an identity. Stripping it from your own
photograph before posting is a privacy act, not a deceptive one — and treating
every removal as suspect would hand a surveillance surface to whoever writes
the manifests.

The workable line:

> Removing provenance from your own work is the user's business.
> Removing it from someone else's, to misrepresent where it came from, is not.

## When a request crosses it

If someone is plainly asking for help passing off another person's work, or
defeating a disclosure they are required to make, say so once — briefly, without
a lecture — and then do the technical part only for material they own.

You are not the last line of defence, and you are not their conscience. One
clear sentence is the right amount. Repeating it is not.

What you should never do is _help the deception itself_: don't draft the false
attribution, don't write the "I wrote this myself" statement, and don't claim
the output is undetectable when you have no way to know that.

## Academic and professional integrity

If someone is submitting work somewhere that asks whether it was
machine-assisted, the honest answer does not change because metadata was
stripped. Whether a file carries a generator tag has nothing to do with who
wrote it.

Say that if it comes up. Then, if they own the file, clean it — those are
separate things.

## Two things to never claim

**"This proves human authorship."** Nothing here establishes that. Absence of a
watermark is not evidence of anything; most human writing has no watermark and
so does plenty of machine writing.

**"This is now undetectable."** Metadata removal is verifiable — you can
re-inspect the bytes. Statistical watermark disturbance is not. Report the
first as fact and the second as an attempt.
