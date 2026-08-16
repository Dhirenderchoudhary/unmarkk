/**
 * The files panel: drop things in, see what they carry, download them clean.
 *
 * Two decisions worth explaining.
 *
 * **Inspection is automatic, cleaning is not.** Files are inspected the moment
 * they arrive, because the report is usually what the person actually came
 * for — most people are more surprised by what a file contains than they are
 * interested in the removal step. Cleaning is a button, because it produces a
 * different file and that should be deliberate.
 *
 * **The queue is a list, not a modal.** Drop twenty photos and you get twenty
 * rows you can scan down. Anything that made you deal with files one at a time
 * would make the common case — a folder of holiday pictures — unusable.
 */

import type { CleanOptions, InspectReport } from '@unmarkk/core';
import { announce, cleanedName, download, el, fill, formatBytes, icon } from './dom.js';
import {
  plainSummary,
  renderExposure,
  renderFindings,
  renderNotes,
  renderRaw,
  renderStylometry,
} from './report.js';
import type { WorkerBridge } from '../bridge.js';

type ItemState = 'reading' | 'inspecting' | 'ready' | 'cleaning' | 'cleaned' | 'error';

interface QueueItem {
  readonly id: number;
  readonly file: File;
  state: ItemState;
  report?: InspectReport;
  flagged?: boolean;
  summary?: string;
  error?: string;
  cleanedBytes?: ArrayBuffer;
  cleanedSize?: number;
  actions?: readonly string[];
  degraded?: boolean;
  residual?: boolean;
  readonly root: HTMLElement;
}

/** Cap on what is worth doing in a browser tab. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export class FilesPanel {
  readonly root: HTMLElement;

  private readonly bridge: WorkerBridge;
  private readonly options: () => CleanOptions;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly bulk: HTMLElement;
  private readonly items = new Map<number, QueueItem>();
  private nextId = 0;

  constructor(bridge: WorkerBridge, options: () => CleanOptions) {
    this.bridge = bridge;
    this.options = options;

    this.list = el('div', { class: 'queue', role: 'list' });
    this.empty = el(
      'div',
      { class: 'empty' },
      icon('file', 28),
      el('p', {}, 'Nothing queued yet.'),
      el(
        'p',
        { class: 'muted' },
        'Drop files above, or paste an image with ' +
          (navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V') +
          '.',
      ),
    );

    this.bulk = el('div', { class: 'bulk', hidden: true });
    this.root = el('div', {}, this.bulk, this.list, this.empty);
    this.refreshChrome();
  }

  /** Queue files for inspection. */
  add(files: readonly File[]): void {
    for (const file of files) void this.addOne(file);
  }

  private async addOne(file: File): Promise<void> {
    const id = this.nextId++;
    const root = el('article', { class: 'card', role: 'listitem' });
    const item: QueueItem = { id, file, state: 'reading', root };
    this.items.set(id, item);

    this.list.prepend(root);
    this.render(item);
    this.refreshChrome();

    if (file.size > MAX_FILE_BYTES) {
      item.state = 'error';
      item.error = `This file is ${formatBytes(file.size)}, past the ${formatBytes(MAX_FILE_BYTES)} limit for browser processing. Use the command-line tool for files this size.`;
      this.render(item);
      return;
    }

    try {
      item.state = 'inspecting';
      this.render(item);

      const buffer = await file.arrayBuffer();
      const response = await this.bridge.send({
        action: 'inspect',
        filename: file.name,
        data: buffer,
        options: this.options(),
      });

      if (!response.ok) {
        item.state = 'error';
        item.error = response.error;
      } else if (response.action === 'inspect') {
        item.state = 'ready';
        item.report = response.report;
        item.flagged = response.verdict.flagged;
        item.summary = plainSummary(response.report);
      }
    } catch (error) {
      item.state = 'error';
      item.error = error instanceof Error ? error.message : String(error);
    }

    this.render(item);
    this.refreshChrome();
    announce(`${file.name}: ${item.summary ?? item.error ?? 'done'}`);
  }

  private async clean(item: QueueItem): Promise<void> {
    if (item.state === 'cleaning') return;
    item.state = 'cleaning';
    this.render(item);

    try {
      const buffer = await item.file.arrayBuffer();
      const response = await this.bridge.send({
        action: 'clean',
        filename: item.file.name,
        data: buffer,
        options: this.options(),
      });

      if (!response.ok) {
        item.state = 'error';
        item.error = response.error;
      } else if (response.action === 'clean') {
        item.state = 'cleaned';
        item.cleanedBytes = response.output;
        item.cleanedSize = response.output.byteLength;
        item.actions = response.result.actions.map((a) => a.message);
        item.degraded = response.result.kind !== 'text' && response.result.degraded;
        item.residual =
          response.result.kind !== 'text' &&
          (response.result.residual.hasC2pa || response.result.residual.hasAiMetadata);

        download(response.output, cleanedName(item.file.name));
        announce(`${item.file.name} cleaned and downloaded`);
      }
    } catch (error) {
      item.state = 'error';
      item.error = error instanceof Error ? error.message : String(error);
    }

    this.render(item);
    this.refreshChrome();
  }

  private remove(item: QueueItem): void {
    this.items.delete(item.id);
    item.root.remove();
    this.refreshChrome();
  }

  private cleanAll(): void {
    for (const item of this.items.values()) {
      if (item.state === 'ready' && item.flagged === true) void this.clean(item);
    }
  }

  private clearAll(): void {
    for (const item of [...this.items.values()]) this.remove(item);
  }

  /** Update the empty state and the bulk action bar. */
  private refreshChrome(): void {
    const items = [...this.items.values()];
    this.empty.hidden = items.length > 0;

    const pending = items.filter((i) => i.state === 'ready' && i.flagged === true).length;
    const done = items.filter((i) => i.state === 'cleaned').length;

    if (items.length === 0) {
      this.bulk.hidden = true;
      return;
    }

    this.bulk.hidden = false;
    fill(
      this.bulk,
      el(
        'span',
        { class: 'bulk-count' },
        `${items.length} file${items.length === 1 ? '' : 's'}`,
        pending > 0 ? el('span', { class: 'bulk-pending' }, `${pending} need attention`) : null,
        done > 0 ? el('span', { class: 'bulk-done' }, `${done} cleaned`) : null,
      ),
      el(
        'span',
        { class: 'bulk-actions' },
        pending > 0
          ? el(
              'button',
              { class: 'btn btn-primary', type: 'button' },
              icon('download', 15),
              `Clean all ${pending}`,
            )
          : null,
        el('button', { class: 'btn btn-quiet', type: 'button' }, 'Clear'),
      ),
    );

    const [cleanBtn, clearBtn] = [...this.bulk.querySelectorAll('button')];
    if (pending > 0 && cleanBtn !== undefined) {
      cleanBtn.addEventListener('click', () => this.cleanAll());
      clearBtn?.addEventListener('click', () => this.clearAll());
    } else {
      cleanBtn?.addEventListener('click', () => this.clearAll());
    }
  }

  private render(item: QueueItem): void {
    const { file, state } = item;

    const badge = ((): HTMLElement => {
      switch (state) {
        case 'reading':
        case 'inspecting':
          return el('span', { class: 'badge badge-busy' }, 'reading');
        case 'cleaning':
          return el('span', { class: 'badge badge-busy' }, 'cleaning');
        case 'cleaned':
          return el('span', { class: 'badge badge-ok' }, icon('check', 13), 'cleaned');
        case 'error':
          return el('span', { class: 'badge badge-error' }, icon('alert', 13), 'error');
        default:
          return item.flagged === true
            ? el('span', { class: 'badge badge-found' }, 'found something')
            : el('span', { class: 'badge badge-ok' }, icon('check', 13), 'nothing found');
      }
    })();

    const head = el(
      'header',
      { class: 'card-head' },
      el('span', { class: 'card-name' }, file.name),
      el(
        'span',
        { class: 'card-meta' },
        formatBytes(file.size),
        item.report === undefined ? null : ` · ${item.report.format}`,
      ),
      badge,
      el(
        'button',
        { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${file.name}` },
        icon('close', 15),
      ),
    );
    head.querySelector('.icon-btn')?.addEventListener('click', () => this.remove(item));

    const body = el('div', { class: 'card-body' });

    if (state === 'error') {
      body.append(
        el(
          'p',
          { class: 'note note-bad' },
          icon('alert', 15),
          el('div', {}, item.error ?? 'failed'),
        ),
      );
    } else if (state === 'reading' || state === 'inspecting') {
      body.append(el('p', { class: 'muted' }, 'Inspecting…'));
    } else if (item.report !== undefined) {
      body.append(el('p', { class: 'summary' }, item.summary ?? ''));

      const exposure = renderExposure(
        item.report.kind === 'text'
          ? {
              hasLocation: false,
              hasDeviceIdentity: false,
              hasAuthorIdentity: false,
              hasTimestamps: false,
            }
          : item.report.privacy,
      );
      if (exposure !== null) body.append(exposure);

      const stylometry = renderStylometry(item.report);
      if (stylometry !== null) body.append(stylometry);

      const findings = renderFindings(item.report.findings);
      if (findings !== null) body.append(findings);

      if (state === 'cleaned') {
        const saved = file.size - (item.cleanedSize ?? file.size);
        body.append(
          el(
            'div',
            { class: 'note note-good' },
            icon('check', 15),
            el(
              'div',
              {},
              el('strong', {}, `Downloaded ${cleanedName(file.name)}`),
              ` — ${formatBytes(file.size)} → ${formatBytes(item.cleanedSize ?? 0)}`,
              saved > 0 ? `, ${formatBytes(saved)} of metadata removed` : '',
              item.actions === undefined || item.actions.length === 0
                ? null
                : el('ul', { class: 'action-list' }, ...item.actions.map((a) => el('li', {}, a))),
            ),
          ),
        );

        if (item.degraded === true) {
          body.append(
            el(
              'div',
              { class: 'note note-warn' },
              icon('alert', 15),
              el(
                'div',
                {},
                'This file could not be fully rebuilt, so the clean is best effort. It is safer than the original but not provably complete.',
              ),
            ),
          );
        }
        if (item.residual === true) {
          body.append(
            el(
              'div',
              { class: 'note note-warn' },
              icon('alert', 15),
              el('div', {}, 'Some provenance signals remain in the output. See the full report.'),
            ),
          );
        }
      } else {
        const cleanButton = el(
          'button',
          { class: 'btn btn-primary', type: 'button' },
          icon('download', 15),
          state === 'cleaning' ? 'Cleaning…' : 'Clean and download',
        );
        if (state === 'cleaning') cleanButton.disabled = true;
        cleanButton.addEventListener('click', () => void this.clean(item));
        body.append(el('div', { class: 'card-actions' }, cleanButton));
      }

      const notes = renderNotes(item.report.notes);
      if (notes !== null) body.append(notes);
      body.append(renderRaw(item.report));
    }

    fill(item.root, head, body);
  }
}
