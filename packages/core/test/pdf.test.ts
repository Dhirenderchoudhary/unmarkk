/**
 * PDF tests.
 *
 * The claim these need to hold up is specific: after cleaning, the metadata is
 * *absent from the bytes*, not merely unreferenced. That is the difference
 * between this and an incremental-update tool, so several tests search the raw
 * output for strings rather than re-parsing it.
 */

import { describe, expect, it } from 'vitest';
import { cleanPdf, inspectPdf, isPdf, parsePdf } from '../src/container/pdf.js';
import { decodeText, encodeText } from '../src/util/text-codec.js';
import { concatBytes } from '../src/util/bytes.js';
import { deflateZlib } from '../src/util/zip.js';
import { makePdf } from './fixtures.js';

const raw = (data: Uint8Array): string => decodeText(data);

describe('parsePdf', () => {
  it('recognises a PDF header', () => {
    expect(isPdf(makePdf())).toBe(true);
    expect(isPdf(encodeText('not a pdf'))).toBe(false);
  });

  it('finds every indirect object', () => {
    const doc = parsePdf(makePdf());
    expect([...doc.objects.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(doc.trailer).toContain('/Root 1 0 R');
    expect(doc.encrypted).toBe(false);
  });

  it('keeps stream payloads intact', () => {
    const doc = parsePdf(makePdf({ body: 'Hello world' }));
    expect(raw(doc.objects.get(4)!.stream!)).toContain('Hello world');
  });

  it('does not stop at an endobj that lives inside stream data', () => {
    // A content stream containing the literal word "endobj" is legal and has
    // broken naive parsers before.
    const trap = makePdf({ body: 'endobj endstream trap' });
    const doc = parsePdf(trap);
    expect(doc.objects.size).toBe(6);
    expect(raw(doc.objects.get(4)!.stream!)).toContain('endobj endstream trap');
  });
});

describe('inspectPdf', () => {
  it('reads the document information dictionary', async () => {
    const scan = await inspectPdf(makePdf());
    expect(scan.privacy.hasAuthorIdentity).toBe(true);
    expect(scan.privacy.hasDeviceIdentity).toBe(true);
    expect(scan.privacy.hasTimestamps).toBe(true);
    expect(scan.findings.some((f) => f.message.includes('Dhirender Choudhary'))).toBe(true);
    expect(scan.findings.some((f) => f.message.includes('Quarterly Plan'))).toBe(true);
  });

  it('finds the XMP metadata stream', async () => {
    const scan = await inspectPdf(makePdf());
    expect(scan.findings.some((f) => f.code === 'pdf.metadata.xmp')).toBe(true);
  });

  it('flags a C2PA claim inside XMP as confirmed', async () => {
    const doc = makePdf();
    const withC2pa = encodeText(raw(doc).replace('<dc:creator>', '<c2pa:claim/><dc:creator>'));
    const scan = await inspectPdf(withC2pa);
    expect(scan.hasC2pa).toBe(true);
    expect(scan.findings.find((f) => f.code === 'pdf.metadata.c2pa')?.confidence).toBe('confirmed');
  });

  it('decodes hex strings in the Info dictionary', async () => {
    const doc = raw(makePdf()).replace('(Dhirender Choudhary)', '<44686972656e646572>');
    const scan = await inspectPdf(encodeText(doc));
    expect(scan.findings.some((f) => f.message.includes('Dhirender'))).toBe(true);
  });

  it('reports an encrypted document instead of guessing at it', async () => {
    const encrypted = raw(makePdf()).replace('/Root 1 0 R', '/Encrypt 9 0 R /Root 1 0 R');
    const scan = await inspectPdf(encodeText(encrypted));
    expect(scan.encrypted).toBe(true);
    expect(scan.findings.some((f) => f.code === 'pdf.encrypted')).toBe(true);
  });
});

describe('cleanPdf', () => {
  it('removes the metadata from the bytes, not just from the references', async () => {
    const { output, actions } = await cleanPdf(makePdf());
    const text = raw(output);

    expect(text).not.toContain('Dhirender Choudhary');
    expect(text).not.toContain('Quarterly Plan');
    expect(text).not.toContain('SomeTool');
    expect(text).not.toContain('D:20260105');
    expect(text).not.toContain('xmpmeta');
    expect(text).not.toContain('/Metadata 5 0 R');

    expect(actions.some((a) => a.code === 'pdf.drop.info')).toBe(true);
    expect(actions.some((a) => a.code === 'pdf.drop.metadata')).toBe(true);
    expect(actions.some((a) => a.code === 'pdf.rebuild')).toBe(true);
  });

  it('keeps the page content and the document structure', async () => {
    const { output } = await cleanPdf(makePdf({ body: 'Important contract text' }));
    const text = raw(output);

    expect(text).toContain('Important contract text');
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('writes a cross-reference table whose offsets are correct', async () => {
    const { output } = await cleanPdf(makePdf());
    const text = raw(output);

    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    // Every "n" entry must point at the start of the object it indexes.
    const table = text.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const offset = Number(entry[1]);
      expect(text.slice(offset)).toMatch(/^\d+ 0 obj/);
    }
  });

  it('re-inspects clean', async () => {
    const { output } = await cleanPdf(makePdf());
    const scan = await inspectPdf(output);
    expect(scan.privacy).toEqual({
      hasLocation: false,
      hasDeviceIdentity: false,
      hasAuthorIdentity: false,
      hasTimestamps: false,
    });
    expect(scan.findings.filter((f) => f.code.startsWith('pdf.info'))).toHaveLength(0);
    expect(scan.hasAiMetadata).toBe(false);
  });

  it('is idempotent', async () => {
    const once = (await cleanPdf(makePdf())).output;
    const twice = (await cleanPdf(once)).output;
    expect(raw(twice)).not.toContain('Dhirender');
    expect(raw(twice)).toContain('Hello world');
  });

  it('refuses an encrypted document rather than mangling it', async () => {
    const encrypted = encodeText(
      raw(makePdf()).replace('/Root 1 0 R', '/Encrypt 9 0 R /Root 1 0 R'),
    );
    await expect(cleanPdf(encrypted)).rejects.toThrow(/encrypted/);
  });

  it('refuses a file with no objects rather than writing an empty PDF', async () => {
    await expect(cleanPdf(encodeText('%PDF-1.4\nnothing here\n%%EOF'))).rejects.toThrow(
      /no PDF objects/,
    );
  });

  it('strips PieceInfo application scratch data', async () => {
    const withPiece = encodeText(
      raw(makePdf()).replace(
        '/Type /Catalog',
        '/Type /Catalog /PieceInfo << /Illustrator 7 0 R >>',
      ),
    );
    expect((await inspectPdf(withPiece)).findings.some((f) => f.code === 'pdf.pieceinfo')).toBe(
      true,
    );
    const { output } = await cleanPdf(withPiece);
    expect(raw(output)).not.toContain('PieceInfo');
  });

  it('expands an object stream so nothing hides inside a compressed container', async () => {
    // Two objects packed into one /ObjStm, the way every PDF 1.5+ writer does
    // it. The second one carries a Producer string that must not survive.
    const first = '<< /Type /Font /BaseFont /Helvetica >>';
    const second = '<< /Producer (HiddenTool) >>';
    const header = `7 0 8 ${first.length + 1} `;
    const compressed = await deflateZlib(encodeText(`${header}${first} ${second}`));

    const merged = concatBytes([
      encodeText(
        '%PDF-1.5\n' +
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
          `9 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode ` +
          `/Length ${compressed.length} >>\nstream\n`,
      ),
      compressed,
      // The trailer names object 8 as /Info, which is exactly how a real
      // PDF 1.5+ file hides its document information inside a compressed
      // container. Expansion has to happen before the Info lookup, or the
      // author's name survives the clean untouched.
      encodeText('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Info 8 0 R >>\n%%EOF\n'),
    ]);

    const result = await cleanPdf(merged);
    expect(result.actions.some((a) => a.code === 'pdf.objstm.expand')).toBe(true);
    expect(result.actions.some((a) => a.code === 'pdf.drop.info')).toBe(true);

    const text = raw(result.output);
    expect(text).toContain('Helvetica');
    expect(text).toContain('7 0 obj');
    // The container is gone, and so is what it was hiding.
    expect(text).not.toContain('/Type /ObjStm');
    expect(text).not.toContain('HiddenTool');
  });

  it('reports degraded rather than claiming a clean it did not achieve', async () => {
    const broken =
      '%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
      '2 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 5 >>\nstream\nXXXXX\nendstream\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
    const result = await cleanPdf(encodeText(broken));
    expect(result.degraded).toBe(true);
    expect(result.actions.some((a) => a.code === 'pdf.objstm.failed')).toBe(true);
  });
});
