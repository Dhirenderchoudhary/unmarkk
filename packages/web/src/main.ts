/**
 * The app shell.
 *
 * Two panels — files and text — because they are genuinely different tasks.
 * Cleaning a photo is "show me what this gives away, then give me a safe copy".
 * Cleaning prose is "show me what is hiding in this, inline, where I can see
 * it". Forcing both through one interface would make each worse.
 *
 * The page has no network capability at all: `index.html` sets
 * `connect-src 'none'`, so the browser refuses every request this code could
 * make. Nothing here would need it — there is no fetch, no analytics, no font
 * from a CDN, no error reporting. Nothing is stored either: no localStorage,
 * no IndexedDB, no service worker. Reloading loses everything, which is the
 * correct behaviour for a tool people point at private documents.
 */

import './styles.css';
import type { CleanOptions } from '@unmarkk/core';
import { WorkerBridge } from './bridge.js';
import { el, fill, icon } from './ui/dom.js';
import { FilesPanel } from './ui/files-panel.js';
import { TextPanel } from './ui/text-panel.js';

interface OptionSpec {
  readonly key: keyof CleanOptions;
  readonly label: string;
  readonly help: string;
  value: boolean;
}

const OPTIONS: OptionSpec[] = [
  {
    key: 'stripAllMetadata',
    label: 'Remove all image metadata',
    help: 'Remove every metadata block, not only the ones that look like AI provenance. This is the privacy-first choice, and it never touches pixels.',
    value: true,
  },
  {
    key: 'cleanTextBodies',
    label: 'Clean text inside documents',
    help: 'Also run the invisible-character pass over the body of Markdown and HTML files.',
    value: true,
  },
  {
    key: 'normalizeSpaces',
    label: 'Normalise exotic spaces',
    help: 'Fold no-break, thin, ideographic and other unusual spaces to a plain space. Turn this off if non-breaking spaces are doing layout work.',
    value: true,
  },
  {
    key: 'aggressiveHomoglyphs',
    label: 'Rewrite lookalike letters',
    help: 'Rewrite Cyrillic and fullwidth lookalikes to ASCII. Genuinely destructive on multilingual text — Cyrillic “Опера” becomes “Onepa”.',
    value: false,
  },
  {
    key: 'stripEmojiGlue',
    label: 'Strip emoji joiners',
    help: 'Also remove the invisible joiners inside emoji and complex scripts. This breaks 👨‍👩‍👧 and Persian spelling. Only for inputs where no invisible character is acceptable.',
    value: false,
  },
];

function currentOptions(): CleanOptions {
  const options: Record<string, boolean> = {};
  for (const spec of OPTIONS) options[spec.key] = spec.value;
  return options as CleanOptions;
}

function buildHeader(): HTMLElement {
  return el(
    'header',
    { class: 'site-head' },
    el(
      'div',
      { class: 'brand' },
      icon('shield', 22),
      el('h1', {}, 'unmark'),
      el('span', { class: 'brand-tag' }, 'privacy-first metadata remover'),
    ),
    el(
      'p',
      { class: 'guarantee' },
      el('strong', {}, 'Your files never leave this device. '),
      'This page declares ',
      el('code', {}, "connect-src 'none'"),
      ', so the browser blocks every network request it could make — open the Network tab and watch. ',
      'Nothing is stored either; reloading clears it.',
    ),
  );
}

function buildOptions(): HTMLElement {
  const body = el('div', { class: 'options-body' });

  for (const spec of OPTIONS) {
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = spec.value;
    input.addEventListener('change', () => {
      spec.value = input.checked;
    });

    body.append(
      el(
        'label',
        { class: 'option' },
        input,
        el(
          'span',
          {},
          el('span', { class: 'option-label' }, spec.label),
          el('span', { class: 'option-help' }, spec.help),
        ),
      ),
    );
  }

  return el('details', { class: 'options' }, el('summary', {}, 'Options'), body);
}

function mount(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app === null) return;

  const bridge = new WorkerBridge();
  const filesPanel = new FilesPanel(bridge, currentOptions);
  const textPanel = new TextPanel();

  // --- drop zone ---------------------------------------------------------

  const input = el('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  const drop = el(
    'div',
    { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Choose files to inspect' },
    icon('download', 26),
    el('h2', {}, 'Drop files here'),
    el(
      'p',
      {},
      'Images (PNG, JPEG, WebP) · Documents (PDF, DOCX, ODT) · Text (Markdown, HTML, SVG, plain)',
    ),
    el('p', { class: 'muted' }, 'or click to choose'),
  );

  const openPicker = (): void => input.click();
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });
  input.addEventListener('change', () => {
    if (input.files !== null) filesPanel.add(Array.from(input.files));
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'dragend'] as const) {
    drop.addEventListener(type, () => drop.classList.remove('dragging'));
  }
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) filesPanel.add(Array.from(files));
  });

  // The whole window accepts a drop, so a near-miss does not open the file in
  // the browser and lose the user's place.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) {
      selectTab('files');
      filesPanel.add(Array.from(files));
    }
  });

  // --- tabs --------------------------------------------------------------

  const filesTab = el(
    'button',
    { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'true' },
    icon('file', 15),
    'Files',
  );
  const textTab = el(
    'button',
    { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false' },
    icon('text', 15),
    'Text',
  );

  const filesView = el('section', { class: 'view' }, drop, input, buildOptions(), filesPanel.root);
  const textView = el('section', { class: 'view', hidden: true }, textPanel.root);

  function selectTab(which: 'files' | 'text'): void {
    const files = which === 'files';
    filesTab.classList.toggle('active', files);
    textTab.classList.toggle('active', !files);
    filesTab.setAttribute('aria-selected', String(files));
    textTab.setAttribute('aria-selected', String(!files));
    filesView.hidden = !files;
    textView.hidden = files;
    if (!files) textPanel.focus();
  }

  filesTab.addEventListener('click', () => selectTab('files'));
  textTab.addEventListener('click', () => selectTab('text'));

  // --- paste -------------------------------------------------------------

  window.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;

    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      selectTab('files');
      filesPanel.add(files);
      return;
    }

    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.trim() !== '') {
      event.preventDefault();
      selectTab('text');
      textPanel.setText(text);
    }
  });

  // --- assemble ----------------------------------------------------------

  fill(
    app,
    buildHeader(),
    el('nav', { class: 'tabs', role: 'tablist' }, filesTab, textTab),
    filesView,
    textView,
    el(
      'footer',
      { class: 'site-foot' },
      el(
        'p',
        {},
        'unmark removes what identifies you — GPS coordinates, camera serial numbers, author names, editing timestamps — along with AI provenance manifests and invisible Unicode carriers.',
      ),
      el(
        'p',
        {},
        'It ',
        el('strong', {}, 'cannot'),
        ' remove a statistical watermark carried in word choice, or one embedded in image pixels. It says so rather than pretending otherwise.',
      ),
      el('p', { class: 'muted' }, 'MIT licensed. Built by Dhirender Choudhary.'),
    ),
    el('div', { id: 'live-region', class: 'sr-only', 'aria-live': 'polite' }),
  );
}

mount();
