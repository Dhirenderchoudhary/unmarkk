import { describe, expect, it } from 'vitest';
import { cleanContainer, detectContainerFormat, inspectContainer } from '../src/container/index.js';
import { cleanMarkdown, inspectMarkdown } from '../src/container/markdown.js';
import { cleanHtml, inspectHtml } from '../src/container/html.js';
import { cleanSvg, inspectSvg } from '../src/container/svg.js';
import { cleanDocx, inspectDocx } from '../src/container/ooxml.js';
import { cleanOdt, inspectOdt } from '../src/container/odf.js';
import { readZip } from '../src/util/zip.js';
import { decodeText, encodeText } from '../src/util/text-codec.js';
import { makeDocx, makeOdt, makePdf } from './fixtures.js';

const text = (data: Uint8Array): string => decodeText(data);

describe('container format detection', () => {
  it('routes by extension first', async () => {
    expect(await detectContainerFormat(encodeText('# hi'), 'notes.md')).toBe('markdown');
    expect(await detectContainerFormat(encodeText('<html>'), 'page.html')).toBe('html');
    // A .md file that opens with an HTML tag is still Markdown to its author.
    expect(await detectContainerFormat(encodeText('<html>x</html>'), 'notes.md')).toBe('markdown');
  });

  it('falls back to sniffing', async () => {
    expect(await detectContainerFormat(makePdf())).toBe('pdf');
    expect(await detectContainerFormat(await makeDocx())).toBe('docx');
    expect(await detectContainerFormat(await makeOdt())).toBe('odt');
    expect(await detectContainerFormat(encodeText('<svg xmlns="x"></svg>'))).toBe('svg');
  });
});

describe('Markdown frontmatter', () => {
  const doc = [
    '---',
    'title: Notes',
    'author: Dhirender Choudhary',
    'generator: ChatGPT',
    'tags:',
    '  - one',
    '  - two',
    'ai_generated: true',
    '---',
    '',
    'Body text stays.',
    '',
  ].join('\n');

  it('separates provenance keys from identity keys', () => {
    const scan = inspectMarkdown(doc);
    expect(scan.hasAiMetadata).toBe(true);
    expect(scan.hasIdentity).toBe(true);
    expect(scan.keys).toEqual(['title', 'author', 'generator', 'tags', 'ai_generated']);

    const generator = scan.findings.find((f) => f.at === 'generator');
    expect(generator?.confidence).toBe('confirmed');
    const author = scan.findings.find((f) => f.code === 'markdown.frontmatter.identity');
    expect(author?.confidence).toBe('informational');
  });

  it('removes provenance keys and keeps everything else', () => {
    const result = cleanMarkdown(doc);
    expect(result.text).not.toContain('generator');
    expect(result.text).not.toContain('ai_generated');
    expect(result.text).toContain('title: Notes');
    expect(result.text).toContain('author: Dhirender Choudhary');
    expect(result.text).toContain('Body text stays.');
  });

  it('carries a nested block away with its parent key', () => {
    const nested = [
      '---',
      'generator:',
      '  name: ChatGPT',
      '  version: 4',
      'title: Keep',
      '---',
      '',
      'Body',
    ].join('\n');
    const result = cleanMarkdown(nested);
    expect(result.text).not.toContain('ChatGPT');
    expect(result.text).not.toContain('version');
    expect(result.text).toContain('title: Keep');
  });

  it('removes the block entirely when nothing survives', () => {
    const result = cleanMarkdown('---\ngenerator: ChatGPT\n---\n\nBody\n');
    expect(result.text).toBe('Body\n');
    expect(result.actions.some((a) => a.code === 'markdown.drop.block')).toBe(true);
  });

  it('leaves a document without frontmatter untouched', () => {
    const plain = '# Heading\n\nSome prose.\n';
    expect(cleanMarkdown(plain).text).toBe(plain);
  });

  it('does not treat a horizontal rule as frontmatter', () => {
    const doc2 = 'Intro\n\n---\n\nMore\n';
    expect(inspectMarkdown(doc2).hasFrontmatter).toBe(false);
    expect(cleanMarkdown(doc2).text).toBe(doc2);
  });
});

describe('HTML metadata', () => {
  const page = [
    '<!doctype html><html><head>',
    '<meta name="generator" content="Hugo 0.120">',
    '<meta name="generator" content="ChatGPT">',
    '<meta name="author" content="Dhirender Choudhary">',
    '<script type="application/ld+json">{"digitalSourceType":"trainedAlgorithmicMedia"}</script>',
    '</head><body><p data-ai-model="gpt-4">Hello</p></body></html>',
  ].join('\n');

  it('tells a CMS generator apart from a model generator', () => {
    const scan = inspectHtml(page);
    expect(scan.hasAiMetadata).toBe(true);
    expect(scan.findings.some((f) => f.code === 'html.meta.cms-generator')).toBe(true);
    expect(scan.findings.some((f) => f.code === 'html.meta.ai')).toBe(true);
  });

  it('removes AI provenance and keeps the CMS tag and the content', () => {
    const result = cleanHtml(page);
    expect(result.text).toContain('Hugo 0.120');
    expect(result.text).not.toContain('ChatGPT');
    expect(result.text).not.toContain('trainedAlgorithmicMedia');
    expect(result.text).not.toContain('data-ai-model');
    // The attribute pattern takes its leading space with it, so no gap is left.
    expect(result.text).toContain('<p>Hello</p>');
  });

  it('leaves a page with no provenance untouched', () => {
    const plain = '<html><head><title>Hi</title></head><body>Text</body></html>';
    expect(cleanHtml(plain).text).toBe(plain);
    expect(cleanHtml(plain).actions[0]?.code).toBe('html.clean.noop');
  });
});

describe('SVG metadata', () => {
  const svg = [
    '<?xml version="1.0"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" inkscape:version="1.1" sodipodi:docname="/home/me/secret-plan.svg">',
    '<metadata><rdf:RDF><dc:creator>Dhirender Choudhary</dc:creator></rdf:RDF></metadata>',
    '<!-- generated by Midjourney -->',
    '<circle cx="10" cy="10" r="5" fill="red"/>',
    '</svg>',
  ].join('\n');

  it('flags the local file path leaked by the editor attribute', () => {
    const scan = inspectSvg(svg);
    expect(scan.hasIdentity).toBe(true);
    expect(scan.findings.some((f) => f.code === 'svg.editor.attrs')).toBe(true);
  });

  it('removes metadata and keeps the drawing', () => {
    const result = cleanSvg(svg);
    expect(result.text).not.toContain('secret-plan');
    expect(result.text).not.toContain('Dhirender');
    expect(result.text).not.toContain('Midjourney');
    expect(result.text).toContain('<circle cx="10" cy="10" r="5" fill="red"/>');
  });

  it('leaves a comment that is not about provenance', () => {
    const commented = '<svg><!-- the logo mark --><rect/></svg>';
    expect(cleanSvg(commented).text).toContain('the logo mark');
  });
});

describe('DOCX', () => {
  it('reports identity, timestamps and provenance parts', async () => {
    const scan = await inspectDocx(await makeDocx());
    expect(scan.privacy.hasAuthorIdentity).toBe(true);
    expect(scan.privacy.hasTimestamps).toBe(true);
    expect(scan.hasAiMetadata).toBe(true);
    expect(scan.findings.some((f) => f.message.includes('Dhirender Choudhary'))).toBe(true);
    expect(scan.findings.some((f) => f.message.includes('Acme Holdings'))).toBe(true);
  });

  it('does not read the body as metadata', async () => {
    // The body mentions two vendors; that is a document about them, not one
    // written by them, and flagging it would misfire on every article on the topic.
    const docx = await makeDocx({
      creator: '',
      lastModifiedBy: '',
      company: '',
      application: '',
      withCustomXml: false,
      withCustomProps: false,
      body: 'A comparison of OpenAI and Claude, written entirely by hand.',
    });
    const scan = await inspectDocx(docx);
    expect(scan.hasAiMetadata).toBe(false);
  });

  it('clears properties, drops metadata parts and repairs the references', async () => {
    const { output, actions } = await cleanDocx(await makeDocx());
    const entries = await readZip(output);
    const names = entries.map((e) => e.name);

    expect(names).not.toContain('customXml/item1.xml');
    expect(names).not.toContain('docProps/custom.xml');
    expect(names).toContain('word/document.xml');

    const contentTypes = text(entries.find((e) => e.name === '[Content_Types].xml')!.data);
    expect(contentTypes).not.toContain('customXml/item1.xml');
    expect(contentTypes).not.toContain('docProps/custom.xml');
    expect(contentTypes).toContain('word/document.xml');

    const rels = text(entries.find((e) => e.name === '_rels/.rels')!.data);
    expect(rels).not.toContain('docProps/custom.xml');
    expect(rels).toContain('word/document.xml');

    const core = text(entries.find((e) => e.name === 'docProps/core.xml')!.data);
    expect(core).not.toContain('Dhirender');
    expect(core).not.toContain('2026-01-05');
    expect(core).toContain('<dc:creator></dc:creator>');
    // The title is content the author wrote deliberately, not a leak.
    expect(core).toContain('Q3 Strategy');

    expect(actions.some((a) => a.code === 'docx.fix.rels')).toBe(true);
  });

  it('leaves the document body byte-identical', async () => {
    const docx = await makeDocx();
    const before = (await readZip(docx)).find((e) => e.name === 'word/document.xml')!.data;
    const after = (await readZip((await cleanDocx(docx)).output)).find(
      (e) => e.name === 'word/document.xml',
    )!.data;
    expect(after).toEqual(before);
  });

  it('reports a broken archive instead of throwing', async () => {
    const scan = await inspectDocx(encodeText('PK not really a zip'));
    expect(scan.findings[0]?.code).toBe('docx.invalid');
  });

  it('is idempotent', async () => {
    const once = (await cleanDocx(await makeDocx())).output;
    const twice = (await cleanDocx(once)).output;
    expect(await inspectDocx(twice)).toMatchObject({ hasAiMetadata: false });
  });
});

describe('ODT', () => {
  it('reports what each meta element gives away', async () => {
    const scan = await inspectOdt(await makeOdt());
    expect(scan.privacy.hasAuthorIdentity).toBe(true);
    expect(scan.privacy.hasTimestamps).toBe(true);
    expect(scan.privacy.hasDeviceIdentity).toBe(true);
    expect(
      scan.findings.some((f) => f.message.includes('how many times the file has been saved')),
    ).toBe(true);
    expect(scan.findings.some((f) => f.message.includes('total time spent editing'))).toBe(true);
  });

  it('empties office:meta but keeps the element and the content', async () => {
    const { output } = await cleanOdt(await makeOdt());
    const entries = await readZip(output);
    const meta = text(entries.find((e) => e.name === 'meta.xml')!.data);

    expect(meta).not.toContain('Dhirender');
    expect(meta).not.toContain('editing-cycles');
    expect(meta).not.toContain('Falcon');
    // The element must survive or the file fails schema validation.
    expect(meta).toContain('<office:meta>');
    expect(text(entries.find((e) => e.name === 'content.xml')!.data)).toContain('Body text.');
  });

  it('keeps mimetype first and stored, as OpenDocument requires', async () => {
    const { output } = await cleanOdt(await makeOdt());
    const entries = await readZip(output);
    expect(entries[0]?.name).toBe('mimetype');
    expect(entries[0]?.method).toBe(0);
    expect(text(entries[0]!.data)).toBe('application/vnd.oasis.opendocument.text');
  });
});

describe('cleanContainer', () => {
  it('runs the invisible-character pass over Markdown bodies', async () => {
    const doc = encodeText('---\ngenerator: ChatGPT\n---\n\nBody with a​ mark.\n');
    const result = await cleanContainer(doc, { filename: 'notes.md' });
    expect(text(result.output)).not.toContain('​');
    expect(result.actions.some((a) => a.code === 'container.text.unicode')).toBe(true);
  });

  it('can be told to leave body text alone', async () => {
    const doc = encodeText('---\ngenerator: ChatGPT\n---\n\nBody with a​ mark.\n');
    const result = await cleanContainer(doc, { filename: 'notes.md', cleanTextBodies: false });
    expect(text(result.output)).toContain('​');
  });

  it('reports residual state after cleaning', async () => {
    const result = await cleanContainer(await makeDocx(), { filename: 'report.docx' });
    expect(result.residual.hasAiMetadata).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.actions.some((a) => a.code === 'container.privacy.cleared')).toBe(true);
  });

  it('refuses an unknown format rather than guessing', async () => {
    await expect(cleanContainer(encodeText('???'), { filename: 'x.bin' })).rejects.toThrow(
      /unsupported container format/,
    );
  });
});

describe('inspectContainer', () => {
  it('explains the DOCX scanning boundary in its notes', async () => {
    const report = await inspectContainer(await makeDocx(), 'report.docx');
    expect(report.notes.some((n) => n.includes('Body text is left alone'))).toBe(true);
  });
});
