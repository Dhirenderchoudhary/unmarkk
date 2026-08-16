## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- What problem does it solve? Link an issue if there is one. -->

## Checklist

- [ ] `pnpm check` passes (format, lint, types, tests)
- [ ] Tests added for the new behaviour, or the bug that would have caught the regression
- [ ] No new runtime dependency in `@unmarkk/core`, and no Node built-ins imported there
- [ ] No new network call anywhere
- [ ] Documentation updated if behaviour changed (`README.md`, `docs/formats.md`)

## If this touches a format

- [ ] Content is preserved exactly — the file renders or reads identically
- [ ] No dangling references left behind (`[Content_Types].xml`, `_rels`, xref, chunk flags)
- [ ] Cleaning twice produces the same result as cleaning once
- [ ] Malformed input is refused rather than rewritten into something broken
- [ ] Fixtures are constructed in code, not checked in as binaries
