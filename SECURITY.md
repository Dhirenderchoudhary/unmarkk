# Security policy

## Reporting a vulnerability

Report privately, not in a public issue. Use the repository's private vulnerability reporting if it is enabled, or contact the maintainer directly.

Please include what you did, what happened, and what you expected. A sample file that triggers the problem is the most useful thing you can send — but strip anything sensitive from it first, which is a use this project supports.

You should get an acknowledgement within a few days. Fixes for anything in the first category below are prioritised over everything else.

## What counts as a vulnerability here

This project's job is to remove data from files. That shapes what a security bug looks like.

**A clean that does not clean.** If `unmark` reports success and the metadata is still recoverable from the output bytes, that is the most serious class of bug in this repository. Someone published a file believing it was safe. This includes:

- data that survives in a form the re-inspection pass does not look at
- data recoverable from a structure the cleaner left in place
- a `degraded` result presented as a complete one

**Egress of any kind.** Any code path in any package that could cause file content to leave the machine. This is a supply-chain concern as much as a code one; a dependency that could do it is the same bug.

**Parser memory-safety and denial of service.** Every parser reads attacker-controlled bytes. Unbounded allocation, infinite loops, decompression bombs, quadratic blowup on crafted input.

**Path handling in the CLI and server.** Writing outside the intended destination, following a symlink, or acting on a client-supplied filename.

## What does not count

**Statistical text watermarks surviving.** Documented in the README under Limits. Byte editing cannot remove a signal carried in word choice, and the tool says so.

**Pixel-domain or audio watermarks surviving.** Out of scope, documented.

**Stylometry being wrong.** It is a heuristic, labelled as one, reported as informational, and off by default.

**A file being identifiable by its content, size or timing.** `unmark` removes metadata, not information-theoretic linkability.

**Reports on a fork or an old version.** Please confirm against the current release first.

## Threat model

The detailed version is in [docs/threat-model.md](docs/threat-model.md). In summary:

- **Untrusted input, trusted operator.** Files are hostile; the person running the tool is not.
- **The engine cannot do I/O.** `@unmarkk/core` has no file-system or network capability and no dependencies, so the attack surface for exfiltration is the CLI and server wrappers, which are small and auditable.
- **The server is a local helper.** It binds to loopback by default and warns loudly otherwise. Exposing it to a network means accepting other people's private documents; use a token and TLS if you do.
- **The browser app is confined by CSP.** `connect-src 'none'` means the browser refuses the requests, rather than the page choosing not to make them.

## Supported versions

The latest minor release receives security fixes.
