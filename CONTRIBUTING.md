# Contributing

Thanks for taking an interest. This document covers what the project expects, which is mostly about honesty regarding what the code does and does not do.

## Getting set up

```bash
pnpm install
pnpm check     # format, lint, typecheck, test — run this before pushing
```

Node 20.11+ and pnpm 10+. There is nothing else to install: the project deliberately has no runtime dependencies and no native tools.

## The rules that are not negotiable

**`@unmarkk/core` stays dependency-free and I/O-free.** No `fs`, no `fetch`, no `process`, no globals beyond the standard web platform. The privacy claim in the README is structural — it holds because the engine is incapable of doing anything else, and a single import would end that. If you need a capability the platform does not provide, the answer is usually to write the twenty lines rather than take the dependency.

**The core must run in a browser.** It is the same code as the CLI. Anything Node-specific belongs in `packages/cli` or `packages/server`.

**Confidence is assigned where a finding is emitted.** Never infer it later from how a message was phrased. The parser that just read a JUMBF box knows more than any classifier reading the sentence about it.

**Never claim more than was done.** If a clean was partial, set `degraded` and say why in an action. If a format is not supported, refuse it — do not pass the bytes through and call it clean. Every message in the output is something a user will act on.

**Do not add a network call anywhere.** Not for updates, not for telemetry, not for a font, not for an error report. There is no configuration flag that would make this acceptable.

## Adding a format

A new format needs, in order:

1. **A parser that can fail cleanly.** Input is attacker-controlled. Bounds-check every read, cap every loop, and return structural problems as data rather than throwing where you can.
2. **An inspector** that emits `Finding[]` with real confidence levels, and fills in `PrivacyFindings` for anything identifying.
3. **A cleaner** that rebuilds the file. It must preserve the content exactly and must not leave dangling references — a DOCX with an orphaned `[Content_Types].xml` override makes Word offer to repair the file, which is worse than leaving the metadata alone.
4. **Fixtures built in code**, in `packages/core/test/fixtures.ts`. No checked-in binaries.
5. **Tests covering**: detection, a clean round trip, content preservation, idempotence, and at least one malformed input.

Wire it into `detect.ts` and the relevant `index.ts` router last.

## Tests

```bash
pnpm test
pnpm test:watch
pnpm coverage
```

Write tests that would fail if the behaviour regressed, not tests that restate the implementation. The most valuable ones in this repository assert things like "the author's name is absent from the output bytes" and "the page content is byte-identical before and after" — properties a user cares about.

If you fix a bug, add the test that would have caught it.

## Style

Prettier and ESLint are enforced; `pnpm check` runs both. Beyond that:

- Comments explain _why_, not _what_. If a line needs a comment to say what it does, rename something instead.
- Prefer a clear name to a clever one.
- Error messages tell the user what to do next, not just what went wrong.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Scope

Reasonable additions: more formats, better parsers, more precise findings, better error messages, documentation.

Out of scope: pixel-domain or audio watermark removal (a different tool with different tradeoffs), anything that phones home, anything that requires a native binary, and anything whose main purpose is to help pass someone else's work off as your own.
