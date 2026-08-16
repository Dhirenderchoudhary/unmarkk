# Intended use

This project removes metadata from files. Most of that metadata is there without its subject's knowledge, and removing it is ordinary self-defence. Some of it is a provenance claim, and removing that is a more complicated act. This document is about the difference.

## What this is for

**Your own files, before you share them.**

A photo you are about to post carries the coordinates where you took it. A CV carries your employer's name in its document properties. A PDF you exported carries the local path of the file it came from, and the number of times you revised it. A screenshot you paste into a chat carries the timestamp and the device.

None of this is visible. All of it travels. Removing it before you share is the same instinct as closing the curtains, and it is the use this project is designed around.

Concretely, that includes: journalists and their sources, people leaving abusive relationships, activists, anyone posting photographs of their home or their children, anyone sending a document to a stranger, and anyone who simply does not think their camera's serial number is anyone else's business.

**Text hygiene.** Invisible characters get into text by accident — bad copy-paste, a CMS, a tracking experiment — and they break search, diffs, and accessibility tools. Removing them is basic cleanup.

## Where it gets more complicated

Some of what this tool removes is a **provenance claim**: a C2PA manifest, a `digitalSourceType` assertion, a generator tag. These exist to answer "where did this come from?", and there is a real public interest in that question being answerable.

That interest is not absolute. Provenance metadata is also a tracking surface: C2PA manifests can carry the capturing device, the software, the editing history, and in some configurations an identity. Stripping it from your own photograph before you post it is a privacy act, not a deceptive one, and treating every removal as suspicious would hand a surveillance surface to whoever gets to write the manifests.

So the honest framing is: **removing provenance from your own work is your business. Removing it from someone else's, in order to misrepresent where it came from, is not.**

That second case is what this project is not for. It does not become acceptable because the tool made it easy, any more than a photocopier makes forgery acceptable. If what you are doing depends on a reader being wrong about who made something, the tool is not the thing that makes it wrong.

## What the tool refuses to pretend

Two honest limits, both enforced in the code rather than only in this document.

**It cannot remove a statistical text watermark.** Schemes like SynthID-Text bias token sampling during generation. The signal lives in word choice across a passage, not in any character you could delete. `unmark` reports that it found nothing and explains why. It does not offer a paraphrase mode, because "rewrite this until a detector stops recognising it" is a different product with a different purpose.

**Stylometry is not detection.** The score measures how text reads — sentence-length evenness, formulaic phrasing, lexical diversity. It is reported as informational, dampened on short samples, refused below thirty words, and off by default. It cannot tell you how a document was produced. Presenting it as a verdict would be dishonest in both directions: it would falsely accuse careful writers and falsely clear careless machines.

The general rule the codebase follows: **never claim more than was done.** A partial rebuild is reported as `degraded`. An unsupported format is refused rather than passed through and called clean. A byte-scan hit is labelled unreliable. Someone is going to publish a file based on what this tool told them.

## Academic and professional integrity

If you are submitting work somewhere that asks whether it was machine-assisted, answer the question honestly. Whether metadata was stripped from the file has no bearing on what you actually did, and using a metadata tool to make a false answer harder to check does not change the answer.

## If you maintain a fork

The limits above are load-bearing. A fork that adds a "make this undetectable" mode, or that presents the stylometry score as a verdict, is a different project with a different purpose — please give it a different name, so that nobody arrives at it expecting this one.
