/**
 * The text panel — paste prose, see what is hiding in it.
 *
 * This exists because "there is a zero-width space in your text" is close to
 * useless as a sentence. The character is invisible; that is the entire point
 * of it. A count tells you something is wrong but not where, and not whether
 * it matters.
 *
 * So the text is re-rendered with every suspicious codepoint replaced by a
 * visible chip showing what it is and where it sits. You can look at a
 * paragraph and see the three invisible characters sitting between "the" and
 * "quick". That turns an abstract warning into something you can act on.
 *
 * Analysis runs on the main thread rather than in the worker: it is fast, it
 * needs to keep up with typing, and a round trip per keystroke would feel
 * worse than the work it avoids. Large pastes are debounced and capped.
 */

import {
  cleanText,
  codepointName,
  inspectText,
  scoreStylometry,
  type CharHit,
  type TextReport,
} from '@unmarkk/core';
import { announce, el, fill, icon } from './dom.js';

/** Past this, live re-analysis on every keystroke stops feeling live. */
const LIVE_LIMIT = 200_000;
const DEBOUNCE_MS = 120;

/** A short, human label for each hit class. */
const KIND_LABEL: Record<CharHit['kind'], string> = {
  'zero-width': 'zero-width',
  bidi: 'bidi control',
  'tag-chars': 'tag char',
  'variation-selector': 'variation selector',
  'private-use': 'private use',
  'space-homoglyph': 'exotic space',
  'latin-confusable': 'lookalike',
  'other-format-char': 'format char',
  strip: 'invisible',
};

export class TextPanel {
  readonly root: HTMLElement;

  private readonly input: HTMLTextAreaElement;
  private readonly summary: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly breakdown: HTMLElement;
  private readonly actions: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private report: TextReport | undefined;

  constructor() {
    this.input = el('textarea', {
      class: 'text-input',
      rows: '9',
      spellcheck: 'false',
      placeholder:
        'Paste text here.\n\nInvisible characters will be shown inline so you can see exactly where they are.',
      'aria-label': 'Text to inspect',
    }) as HTMLTextAreaElement;

    this.summary = el('div', { class: 'text-summary', 'aria-live': 'polite' });
    this.preview = el('div', { class: 'text-preview', hidden: true });
    this.breakdown = el('div', { class: 'text-breakdown' });
    this.actions = el('div', { class: 'text-actions' });

    this.input.addEventListener('input', () => this.schedule());

    this.root = el(
      'div',
      { class: 'text-panel' },
      el(
        'p',
        { class: 'panel-intro' },
        'Nothing here is uploaded — the analysis runs in this tab as you type.',
      ),
      this.input,
      this.actions,
      this.summary,
      this.preview,
      this.breakdown,
    );

    this.renderActions();
    this.analyse();
  }

  /** Put text in and analyse it, used by the paste handler. */
  setText(text: string): void {
    this.input.value = text;
    this.analyse();
  }

  focus(): void {
    this.input.focus();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.analyse(), DEBOUNCE_MS);
  }

  private analyse(): void {
    const text = this.input.value;

    if (text === '') {
      this.report = undefined;
      fill(this.summary);
      fill(this.breakdown);
      this.preview.hidden = true;
      this.renderActions();
      return;
    }

    if (text.length > LIVE_LIMIT) {
      this.report = undefined;
      fill(
        this.summary,
        el(
          'div',
          { class: 'note note-warn' },
          icon('alert', 15),
          el(
            'div',
            {},
            `That is ${text.length.toLocaleString()} characters — too long to re-check on every keystroke. Save it to a file and use the Files tab, or the command-line tool.`,
          ),
        ),
      );
      this.preview.hidden = true;
      fill(this.breakdown);
      this.renderActions();
      return;
    }

    this.report = inspectText(text);
    this.renderSummary(text);
    this.renderPreview(text);
    this.renderBreakdown();
    this.renderActions();
  }

  private renderSummary(text: string): void {
    const report = this.report;
    if (report === undefined) return;

    if (report.suspiciousTotal === 0) {
      fill(
        this.summary,
        el(
          'div',
          { class: 'note note-good' },
          icon('check', 15),
          el(
            'div',
            {},
            el('strong', {}, 'No invisible characters. '),
            'Nothing in this text is hidden from view.',
          ),
        ),
      );
    } else {
      const n = report.suspiciousTotal;
      fill(
        this.summary,
        el(
          'div',
          { class: 'note note-warn' },
          icon('eye', 15),
          el(
            'div',
            {},
            el(
              'strong',
              {},
              `${n} invisible character${n === 1 ? '' : 's'} across ${report.hits.length} codepoint${report.hits.length === 1 ? '' : 's'}. `,
            ),
            'They are highlighted below.',
          ),
        ),
      );
    }

    // Stylometry is only meaningful on a real sample, and it is a heuristic, so
    // it sits below the deterministic result rather than beside it.
    const style = scoreStylometry(text);
    if (style.status === 'ok') {
      this.summary.append(
        el(
          'div',
          { class: 'note note-neutral' },
          icon('spark', 15),
          el(
            'div',
            {},
            el(
              'strong',
              {},
              `Writing style: ${style.level.toLowerCase()} (${style.score.toFixed(2)}). `,
            ),
            'A heuristic about how the text reads, not evidence of how it was written — and not something this tool can change. ',
            el(
              'span',
              { class: 'muted' },
              `${style.wordCount} words, sentence-length variation ${style.burstinessCv.toFixed(2)}.`,
            ),
          ),
        ),
      );
    }
  }

  /**
   * Re-render the text with each suspicious codepoint made visible.
   *
   * Built with `textContent` on separate nodes rather than string
   * concatenation, so the pasted text can never become markup.
   */
  private renderPreview(text: string): void {
    const report = this.report;
    if (report === undefined || report.suspiciousTotal === 0) {
      this.preview.hidden = true;
      return;
    }

    // One lookup from offset to hit, so the walk below stays linear.
    const marks = new Map<number, CharHit>();
    for (const hit of report.hits) {
      for (const offset of hit.sampleOffsets) marks.set(offset, hit);
    }

    const nodes: Node[] = [];
    let plain = '';
    let shown = 0;
    const LIMIT = 400;

    const flush = (): void => {
      if (plain !== '') {
        nodes.push(document.createTextNode(plain));
        plain = '';
      }
    };

    for (let i = 0; i < text.length; i += 1) {
      const hit = marks.get(i);
      if (hit === undefined) {
        plain += text[i];
        continue;
      }
      flush();

      if (shown < LIMIT) {
        nodes.push(
          el(
            'span',
            {
              class: `invis invis-${hit.kind}`,
              title: `${hit.label} ${codepointName(hit.codepoint)} — ${KIND_LABEL[hit.kind]}`,
            },
            hit.kind === 'space-homoglyph' ? '␣' : hit.label,
          ),
        );
        shown += 1;
      }
      // A replaced character is consumed; a stripped one occupies no width, so
      // in both cases nothing else is emitted for this offset.
      if (text.codePointAt(i)! > 0xffff) i += 1;
    }
    flush();

    fill(this.preview, ...nodes);
    this.preview.hidden = false;
  }

  private renderBreakdown(): void {
    const report = this.report;
    if (report === undefined || report.hits.length === 0) {
      fill(this.breakdown);
      return;
    }

    fill(
      this.breakdown,
      el('h4', { class: 'findings-title' }, 'What was found'),
      el(
        'ul',
        { class: 'hit-list' },
        ...report.hits.map((hit) =>
          el(
            'li',
            { class: 'hit' },
            el('code', { class: 'hit-code' }, hit.label),
            el('span', { class: 'hit-name' }, codepointName(hit.codepoint)),
            el('span', { class: `chip chip-kind chip-${hit.kind}` }, KIND_LABEL[hit.kind]),
            el('span', { class: 'hit-count' }, `×${hit.count}`),
          ),
        ),
      ),
    );
  }

  private renderActions(): void {
    const hasText = this.input.value !== '';
    const hasHits = (this.report?.suspiciousTotal ?? 0) > 0;

    const cleanBtn = el(
      'button',
      { class: 'btn btn-primary', type: 'button' },
      icon('check', 15),
      'Clean the text',
    );
    if (!hasHits) cleanBtn.disabled = true;
    cleanBtn.addEventListener('click', () => this.cleanInPlace());

    const copyBtn = el('button', { class: 'btn', type: 'button' }, icon('copy', 15), 'Copy');
    if (!hasText) copyBtn.disabled = true;
    copyBtn.addEventListener('click', () => void this.copy(copyBtn));

    const clearBtn = el('button', { class: 'btn btn-quiet', type: 'button' }, 'Clear');
    if (!hasText) clearBtn.disabled = true;
    clearBtn.addEventListener('click', () => {
      this.input.value = '';
      this.analyse();
      this.input.focus();
    });

    fill(this.actions, cleanBtn, copyBtn, clearBtn);
  }

  private cleanInPlace(): void {
    const result = cleanText(this.input.value);
    this.input.value = result.text;
    this.analyse();
    announce(
      `Removed ${result.stats.removedCount} characters, replaced ${result.stats.replacedCount}.`,
    );

    this.summary.prepend(
      el(
        'div',
        { class: 'note note-good' },
        icon('check', 15),
        el(
          'div',
          {},
          el(
            'strong',
            {},
            `Removed ${result.stats.removedCount} character${result.stats.removedCount === 1 ? '' : 's'}`,
          ),
          result.stats.replacedCount > 0
            ? ` and replaced ${result.stats.replacedCount} exotic space${result.stats.replacedCount === 1 ? '' : 's'}`
            : '',
          '. The text above is updated — copy it out.',
        ),
      ),
    );
  }

  private async copy(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.input.value);
      const original = button.textContent;
      fill(button, icon('check', 15), 'Copied');
      setTimeout(() => fill(button, icon('copy', 15), original ?? 'Copy'), 1400);
    } catch {
      // Clipboard access can be refused; select the text so the user can copy
      // it themselves rather than leaving them with a button that did nothing.
      this.input.select();
      announce('Clipboard was blocked. The text is selected — copy it manually.');
    }
  }
}
