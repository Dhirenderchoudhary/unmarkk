#!/usr/bin/env node
/**
 * Install the agent skills into whichever assistant you use.
 *
 * Skills are plain Markdown, so "installing" one means putting the directory
 * somewhere the assistant looks. This script symlinks by default, which means
 * a `git pull` updates the installed skill with no further action — the copy
 * mode exists for Windows without developer mode, where symlinks need
 * elevation.
 *
 * Nothing here touches the network or writes outside the target directory.
 *
 *   node scripts/install-skills.mjs --list
 *   node scripts/install-skills.mjs --target claude
 *   node scripts/install-skills.mjs --target project --copy
 */

import { cp, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');

/** Where each assistant keeps its skills. */
const TARGETS = {
  claude: {
    label: 'Claude Code (user-wide)',
    path: join(homedir(), '.claude', 'skills'),
  },
  project: {
    label: 'this project (.claude/skills)',
    path: join(process.cwd(), '.claude', 'skills'),
  },
  grok: {
    label: 'Grok (user-wide)',
    path: join(homedir(), '.grok', 'skills'),
  },
  cursor: {
    label: 'Cursor rules (user-wide)',
    path: join(homedir(), '.cursor', 'rules'),
    rulesOnly: true,
  },
};

const RESET = '\u001b[0m';
const colour = (code, text) =>
  process.stdout.isTTY === true ? `\u001b[${code}m${text}${RESET}` : text;
const bold = (t) => colour('1', t);
const dim = (t) => colour('2', t);
const green = (t) => colour('32', t);
const yellow = (t) => colour('33', t);

function usage() {
  console.log(`${bold('install-skills')} — put the unmark agent skills where your assistant looks

${bold('USAGE')}
  node scripts/install-skills.mjs [--target <name>] [--copy] [--remove]

${bold('TARGETS')}
${Object.entries(TARGETS)
  .map(([name, t]) => `  ${name.padEnd(10)} ${t.label}\n  ${' '.repeat(10)} ${dim(t.path)}`)
  .join('\n')}

${bold('OPTIONS')}
  --target <name>   Where to install (default: claude)
  --copy            Copy instead of symlinking. Use on Windows without
                    developer mode, where symlinks need elevation.
  --remove          Uninstall instead of installing.
  --list            Show the available skills and exit.
  -h, --help        This message.
`);
}

async function listSkills() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Replace whatever is at `destination`, but only if we put it there. */
async function clearDestination(destination, force) {
  let info;
  try {
    info = await lstat(destination);
  } catch {
    return true; // nothing there
  }

  if (info.isSymbolicLink()) {
    const current = await readlink(destination);
    if (current.startsWith(SKILLS_DIR) || force) {
      await rm(destination, { force: true });
      return true;
    }
    console.log(`  ${yellow('skipped')} ${destination} — a symlink pointing somewhere else`);
    return false;
  }

  if (force) {
    await rm(destination, { recursive: true, force: true });
    return true;
  }

  console.log(
    `  ${yellow('skipped')} ${destination} — already exists and is not one of ours (use --copy to overwrite)`,
  );
  return false;
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'claude' },
      copy: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help === true) {
    usage();
    return 0;
  }

  const skills = await listSkills();

  if (values.list === true) {
    console.log(bold('Available skills'));
    for (const skill of skills) console.log(`  ${skill}`);
    return 0;
  }

  const target = TARGETS[values.target];
  if (target === undefined) {
    console.error(`unknown target "${values.target}". One of: ${Object.keys(TARGETS).join(', ')}`);
    return 2;
  }

  if (target.rulesOnly === true) {
    console.log(
      `${yellow('note')} Cursor uses rule files rather than skill directories.\n` +
        `     Copy ${dim('integrations/cursor/unmark-text-hygiene.mdc')} into ${dim(target.path)}\n` +
        '     or into .cursor/rules in your project.',
    );
    return 0;
  }

  await mkdir(target.path, { recursive: true });
  console.log(
    `${bold(values.remove === true ? 'Removing from' : 'Installing into')} ${target.label}`,
  );
  console.log(dim(`  ${target.path}`));
  console.log('');

  for (const skill of skills) {
    const source = join(SKILLS_DIR, skill);
    const destination = join(target.path, skill);

    if (values.remove === true) {
      const cleared = await clearDestination(destination, false);
      if (cleared) console.log(`  ${green('removed')} ${skill}`);
      continue;
    }

    if (!(await clearDestination(destination, values.copy === true))) continue;

    if (values.copy === true) {
      await cp(source, destination, { recursive: true });
      console.log(`  ${green('copied')}  ${skill}`);
    } else {
      try {
        await symlink(source, destination, 'dir');
        console.log(`  ${green('linked')}  ${skill}`);
      } catch (error) {
        if (error.code === 'EPERM') {
          console.log(
            `  ${yellow('symlink refused')} — retry with --copy (Windows needs elevation for symlinks)`,
          );
          return 1;
        }
        throw error;
      }
    }
  }

  console.log('');
  if (values.remove !== true) {
    console.log(dim('  Restart your assistant, then ask it to inspect or clean a file.'));
    if (values.copy !== true) {
      console.log(dim('  These are symlinks, so a git pull updates them in place.'));
    }
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
