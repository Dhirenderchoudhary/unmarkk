# @unmarkk/cli

Command-line [unmark](../../README.md). Removes metadata from files on your machine, and never sends them anywhere.

```bash
npm install -g @unmarkk/cli
```

```bash
unmark inspect photo.jpg          # what does this file say about me?
unmark clean photo.jpg            # write photo.cleaned.jpg without it
unmark scan ~/Pictures --quiet    # which files in here are leaking?
```

No system tools required — no `exiftool`, no `qpdf`. Node 20.11+ and nothing else.

## Commands

```
unmark inspect <path...>     Report what a file carries. Changes nothing.
unmark clean   <path...>     Write a cleaned copy.
unmark scan    <dir...>      Walk a directory and list files carrying metadata.
```

```bash
unmark clean report.docx --in-place            # overwrite, keeping a .bak
unmark inspect draft.md --stylometry           # include the writing-style heuristic
cat draft.txt | unmark clean - > clean.txt     # pipe through stdin
unmark scan ~/Documents --json | jq '.files[] | select(.flagged)'
```

Exit codes: `0` nothing found, `1` metadata found or signals survived a clean, `2` bad input or usage.

Run `unmark --help` for every option.

## Safety

Writes are atomic — a temporary file in the destination directory, flushed, then renamed — so an interrupted run cannot leave a half-written document where the original was. Writes refuse to follow symlinks. `--in-place` takes a `.bak` copy before anything is overwritten.

## License

MIT © Dhirender Choudhary
