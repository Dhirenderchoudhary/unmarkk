# Agent skills

Two skills, so an assistant can drive `unmark` without you explaining it each
time.

| Skill                           | For                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`unmark-files`](unmark-files/) | Inspecting and cleaning files: photos, documents, PDFs, whole directories, live sites          |
| [`unmark-text`](unmark-text/)   | Prose hygiene: invisible characters, and the honest version of statistical-watermark rewriting |

Both are plain Markdown. They contain no code — they describe how to use the
CLI, what the confidence levels mean, and what the tool cannot do.

## Installing

```bash
node scripts/install-skills.mjs --target claude     # ~/.claude/skills
node scripts/install-skills.mjs --target project    # ./.claude/skills
node scripts/install-skills.mjs --target grok       # ~/.grok/skills
node scripts/install-skills.mjs --list
```

Symlinks by default, so `git pull` updates them. Use `--copy` on Windows
without developer mode, where symlinks need elevation. `--remove` uninstalls.

The skills assume `unmark` is on PATH:

```bash
npm install -g @unmarkk/cli
```

If it is not, they fall back to the local HTTP service (`npx @unmarkk/server`),
and if neither is available they say so rather than improvising a metadata
stripper out of shell tools.

## Editor integrations

Cursor uses rule files rather than skill directories:

```bash
cp integrations/cursor/unmark-text-hygiene.mdc .cursor/rules/
```

For assistants that read a project instruction file, there is a snippet to
paste in [`integrations/AGENTS.md`](../integrations/AGENTS.md).

## Why the skills are code-free

An agent skill that ships executable scripts has to keep them in step with the
tool, and runs against whatever interpreter happens to be on the host. These
call one binary with a stable interface and documented JSON output, so there is
exactly one implementation to keep correct.

It also means you can read them in five minutes and know exactly what your
assistant was told.
