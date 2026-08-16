# Agent instructions snippet

Drop this into your project's `AGENTS.md`, `CLAUDE.md`, or equivalent, for
assistants that read a project instruction file rather than loading skills.

---

## Handling files with metadata

This project uses [`unmark`](https://www.npmjs.com/package/@unmarkk/cli) to
inspect and remove identifying metadata.

**Before sharing any file that came from outside the repository** — a
screenshot, a photo, an exported document — inspect it:

```bash
npx @unmarkk/cli inspect FILE
```

If it reports location, device identity, author identity or timestamps, clean
it before the file is committed or sent:

```bash
npx @unmarkk/cli clean FILE --in-place
```

**Before committing prose**, run the invisible-character pass. Zero-width
characters arrive through copy-paste and break search, diffs and screen
readers:

```bash
npx @unmarkk/cli clean docs/page.md --in-place
```

**To check the whole tree**, which is worth doing in CI:

```bash
npx @unmarkk/cli scan . --quiet     # exits 1 if anything needs attention
```

### Reporting rules

Findings carry a confidence level — `confirmed`, `probable`, `informational`,
`likely-false-positive`. Do not flatten them; a `confirmed` Exif directory and
a `likely-false-positive` byte-scan hit are not the same claim.

Two things `unmark` cannot do, which should never be implied:

- It cannot remove a statistical text watermark. Those live in word choice, not
  in any byte.
- It cannot remove a pixel-domain image watermark. Those survive metadata
  removal entirely.
