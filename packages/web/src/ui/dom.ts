/**
 * Small DOM helpers.
 *
 * No framework. The app has three screens and a list; a renderer would be more
 * code than the thing it renders, and every dependency in a privacy tool is
 * another party the user has to trust.
 *
 * `el` sets text through `textContent` and never `innerHTML`, so a filename or
 * a finding message can never become markup. Some of the strings rendered here
 * come out of files the user did not write.
 */

type Child = Node | string | null | undefined | false;

export interface Attrs {
  readonly class?: string;
  readonly id?: string;
  readonly type?: string;
  readonly title?: string;
  readonly role?: string;
  readonly href?: string;
  readonly download?: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly tabindex?: string;
  readonly placeholder?: string;
  readonly spellcheck?: string;
  readonly rows?: string;
  readonly multiple?: boolean;
  readonly checked?: boolean;
  readonly value?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-live'?: string;
  readonly 'aria-hidden'?: string;
  readonly 'aria-selected'?: string;
  readonly 'aria-expanded'?: string;
  readonly 'aria-controls'?: string;
  readonly 'data-kind'?: string;
}

/** Create an element. Children are appended as text nodes, never parsed. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (name === 'class') node.className = String(value);
    else if (name === 'hidden') node.hidden = true;
    else if (name === 'disabled') (node as HTMLButtonElement).disabled = true;
    else if (name === 'multiple') (node as HTMLInputElement).multiple = true;
    else if (name === 'checked') (node as HTMLInputElement).checked = true;
    else if (name === 'value') (node as HTMLInputElement).value = String(value);
    else node.setAttribute(name, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replace an element's children in one go. */
export function fill(node: Element, ...children: Child[]): void {
  node.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
}

/** An inline SVG icon. Paths are from a fixed table, never user input. */
export function icon(name: keyof typeof ICONS, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const ICONS = {
  shield: ['M12 3 4 6v6c0 4.5 3.2 8.4 8 9 4.8-.6 8-4.5 8-9V6l-8-3Z'],
  location: ['M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z', 'M12 10.5h.01'],
  camera: [
    'M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.2-2h7.2l1.2 2h1.7A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-9Z',
    'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  ],
  person: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  download: ['M12 4v11', 'M7.5 11 12 15.5 16.5 11', 'M4 19h16'],
  check: ['M4.5 12.5 9 17 19.5 6.5'],
  alert: ['M12 8v5', 'M12 17h.01', 'M12 3 2 20h20L12 3Z'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5'],
  text: ['M5 6h14', 'M5 12h14', 'M5 18h9'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  copy: ['M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z', 'M15 5H7a2 2 0 0 0-2 2v8'],
  spark: [
    'M12 3v4',
    'M12 17v4',
    'M3 12h4',
    'M17 12h4',
    'M6 6l2.5 2.5',
    'M15.5 15.5 18 18',
    'M18 6l-2.5 2.5',
    'M8.5 15.5 6 18',
  ],
} as const;

/** Human-readable byte count. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `photo.jpg` -> `photo.cleaned.jpg` */
export function cleanedName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 1 ? `${name}.cleaned` : `${name.slice(0, dot)}.cleaned${name.slice(dot)}`;
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked straight afterwards: it is a copy of a private
 * file and there is no reason for it to stay reachable from the document.
 */
export function download(bytes: ArrayBuffer | Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Announce something to screen readers without moving focus. */
export function announce(message: string): void {
  const region = document.querySelector('#live-region');
  if (region !== null) region.textContent = message;
}
