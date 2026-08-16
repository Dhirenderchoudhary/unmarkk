import { describe, expect, it } from 'vitest';
import { cleanImage, detectImageFormat, inspectImage } from '../src/image/index.js';
import { parsePng, stripPng } from '../src/image/png.js';
import { parseJpeg, stripJpeg } from '../src/image/jpeg.js';
import { parseWebp, stripWebp } from '../src/image/webp.js';
import { scanExif } from '../src/image/exif.js';
import { decodeText, encodeText } from '../src/util/text-codec.js';
import { crc32Of } from '../src/util/crc32.js';
import {
  EXIF_TAG,
  app1Exif,
  app1Xmp,
  makeExif,
  makeJpeg,
  makePng,
  makeWebp,
  textChunk,
} from './fixtures.js';

const chunkTypes = (data: Uint8Array): string[] => parsePng(data).chunks.map((c) => c.type);

describe('format detection', () => {
  it('identifies each supported raster format', () => {
    expect(detectImageFormat(makePng())).toBe('png');
    expect(detectImageFormat(makeJpeg())).toBe('jpeg');
    expect(detectImageFormat(makeWebp())).toBe('webp');
    expect(detectImageFormat(encodeText('not an image'))).toBe('unknown');
  });
});

describe('PNG', () => {
  it('parses chunks and validates CRCs', () => {
    const png = makePng([{ type: 'tEXt', payload: textChunk('Author', 'Dhirender Choudhary') }]);
    const parsed = parsePng(png);
    expect(parsed.chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(parsed.chunks.every((c) => c.crcValid)).toBe(true);
    expect(parsed.problems).toHaveLength(0);
  });

  it('reads the tEXt keyword up to the NUL, not up to a space', () => {
    // PNG text chunks are `keyword\0value`. Splitting on whitespace reported
    // `Author\0Jane Smith` as the keyword "author.jane" — wrong, and it leaked
    // the value into the field that is meant to name the field.
    const png = makePng([{ type: 'tEXt', payload: textChunk('Author', 'Jane Smith') }]);
    const finding = inspectImage(png).findings.find((f) => f.code === 'png.chunk.text.identity');

    expect(finding?.message).toContain('"author"');
    expect(finding?.message).not.toContain('jane');
  });

  it('handles a text chunk with no NUL without reading the whole payload', () => {
    const png = makePng([{ type: 'tEXt', payload: encodeText('a'.repeat(200)) }]);
    expect(() => inspectImage(png)).not.toThrow();
  });

  it('reports a text chunk that names a person', () => {
    const png = makePng([{ type: 'tEXt', payload: textChunk('Author', 'Dhirender Choudhary') }]);
    const report = inspectImage(png);
    expect(report.privacy.hasAuthorIdentity).toBe(true);
    expect(report.findings.some((f) => f.code === 'png.chunk.text.identity')).toBe(true);
  });

  it('reads GPS out of an eXIf chunk', () => {
    const exif = makeExif([{ tag: EXIF_TAG.GpsInfo }, { tag: EXIF_TAG.Make }]);
    const report = inspectImage(makePng([{ type: 'eXIf', payload: exif }]));
    expect(report.privacy.hasLocation).toBe(true);
    expect(report.privacy.hasDeviceIdentity).toBe(true);
  });

  it('flags a C2PA private chunk as confirmed', () => {
    const png = makePng([{ type: 'caBX', payload: encodeText('jumb c2pa manifest') }]);
    const report = inspectImage(png);
    expect(report.hasC2pa).toBe(true);
    expect(report.findings[0]?.confidence).toBe('confirmed');
  });

  it('removes metadata chunks and keeps the pixels', () => {
    const png = makePng([
      { type: 'tEXt', payload: textChunk('Author', 'Dhirender Choudhary') },
      { type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) },
      { type: 'tIME', payload: Uint8Array.of(7, 0xea, 1, 5, 9, 12, 0) },
    ]);
    const { output } = stripPng(png);
    expect(chunkTypes(output)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(decodeText(output)).not.toContain('Dhirender');

    const original = parsePng(png).chunks.find((c) => c.type === 'IDAT')!;
    const cleaned = parsePng(output).chunks.find((c) => c.type === 'IDAT')!;
    expect(cleaned.payload).toEqual(original.payload);
  });

  it('keeps the colour profile, which is not metadata about you', () => {
    const png = makePng([{ type: 'iCCP', payload: encodeText('sRGB\0\0profile') }]);
    expect(chunkTypes(stripPng(png).output)).toContain('iCCP');
  });

  it('recomputes CRCs so a hand-edited file comes out well formed', () => {
    const png = makePng([{ type: 'tEXt', payload: textChunk('a', 'b') }]);
    const damaged = Uint8Array.from(png);
    // Corrupt the IHDR CRC, which sits just before the next chunk.
    damaged[29] = damaged[29]! ^ 0xff;
    expect(parsePng(damaged).chunks.some((c) => !c.crcValid)).toBe(true);
    expect(parsePng(stripPng(damaged).output).chunks.every((c) => c.crcValid)).toBe(true);
  });

  it('says so when there was nothing to remove', () => {
    expect(stripPng(makePng()).actions[0]?.code).toBe('png.clean.noop');
  });

  it('notes truncation rather than inventing chunks', () => {
    const truncated = makePng([{ type: 'tEXt', payload: encodeText('x') }]).subarray(0, 40);
    expect(parsePng(truncated).problems.length).toBeGreaterThan(0);
  });
});

describe('JPEG', () => {
  it('parses segments up to the scan', () => {
    const jpeg = makeJpeg([
      { marker: 0xe1, payload: app1Exif(makeExif([{ tag: EXIF_TAG.Make }])) },
    ]);
    const parsed = parseJpeg(jpeg);
    expect(parsed.segments.some((s) => s.marker === 0xe1)).toBe(true);
    expect(parsed.scanOffset).toBeGreaterThan(0);
  });

  it('reads Exif structurally rather than by string matching', () => {
    const exif = makeExif([
      { tag: EXIF_TAG.GpsInfo },
      { tag: EXIF_TAG.Model },
      { tag: EXIF_TAG.Artist },
      { tag: EXIF_TAG.DateTime },
    ]);
    const report = inspectImage(makeJpeg([{ marker: 0xe1, payload: app1Exif(exif) }]));
    expect(report.privacy).toEqual({
      hasLocation: true,
      hasDeviceIdentity: true,
      hasAuthorIdentity: true,
      hasTimestamps: true,
    });
  });

  it('flags APP11 as a confirmed C2PA container', () => {
    const report = inspectImage(makeJpeg([{ marker: 0xeb, payload: encodeText('JUMBF') }]));
    expect(report.hasC2pa).toBe(true);
    expect(report.findings.some((f) => f.code === 'jpeg.app11.jumbf')).toBe(true);
  });

  it('flags APP13 as an IPTC block', () => {
    const report = inspectImage(makeJpeg([{ marker: 0xed, payload: encodeText('Photoshop 3.0') }]));
    expect(report.privacy.hasAuthorIdentity).toBe(true);
  });

  it('drops metadata segments and preserves the scan byte for byte', () => {
    const jpeg = makeJpeg([
      { marker: 0xe1, payload: app1Exif(makeExif([{ tag: EXIF_TAG.GpsInfo }])) },
      { marker: 0xe1, payload: app1Xmp('<x:xmpmeta><dc:creator>Someone</dc:creator></x:xmpmeta>') },
      { marker: 0xeb, payload: encodeText('c2pa') },
      { marker: 0xfe, payload: encodeText('a comment') },
    ]);
    const { output } = stripJpeg(jpeg);

    const remaining = parseJpeg(output).segments.map((s) => s.marker);
    expect(remaining).not.toContain(0xe1);
    expect(remaining).not.toContain(0xeb);
    expect(remaining).not.toContain(0xfe);
    expect(decodeText(output)).not.toContain('Someone');

    const before = jpeg.subarray(parseJpeg(jpeg).scanOffset);
    const after = output.subarray(parseJpeg(output).scanOffset);
    expect(after).toEqual(before);
  });

  it('keeps APP0 and APP14, which change how the image decodes', () => {
    const jpeg = makeJpeg([
      { marker: 0xe0, payload: encodeText('JFIF\0') },
      { marker: 0xee, payload: encodeText('Adobe') },
    ]);
    const remaining = parseJpeg(stripJpeg(jpeg).output).segments.map((s) => s.marker);
    expect(remaining).toContain(0xe0);
    expect(remaining).toContain(0xee);
  });

  it('refuses to write an image with no scan', () => {
    const headerOnly = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);
    expect(() => stripJpeg(headerOnly)).toThrow(/start-of-scan/);
  });
});

describe('WebP', () => {
  it('parses chunks and notices trailing bytes', () => {
    const webp = makeWebp([{ fourcc: 'EXIF', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) }]);
    expect(parseWebp(webp).chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8 ', 'EXIF']);
    expect(parseWebp(webp).problems).toHaveLength(0);
  });

  it('reads GPS out of an EXIF chunk', () => {
    const webp = makeWebp([{ fourcc: 'EXIF', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) }]);
    expect(inspectImage(webp).privacy.hasLocation).toBe(true);
  });

  it('clears the VP8X flags for the chunks it removed', () => {
    const webp = makeWebp([
      { fourcc: 'EXIF', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) },
      { fourcc: 'XMP ', payload: encodeText('<x:xmpmeta/>') },
    ]);
    expect(parseWebp(webp).chunks[0]!.payload[0]).toBe(0x0c); // EXIF | XMP

    const { output } = stripWebp(webp);
    const parsed = parseWebp(output);
    expect(parsed.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8 ']);
    expect(parsed.chunks[0]!.payload[0]).toBe(0x00);
    expect(parsed.problems).toHaveLength(0);
  });

  it('keeps the colour profile by default', () => {
    const webp = makeWebp([{ fourcc: 'ICCP', payload: encodeText('profile') }]);
    expect(parseWebp(stripWebp(webp).output).chunks.map((c) => c.fourcc)).toContain('ICCP');
  });

  it('drops a C2PA chunk', () => {
    const webp = makeWebp([{ fourcc: 'C2PA', payload: encodeText('manifest') }]);
    expect(inspectImage(webp).hasC2pa).toBe(true);
    expect(parseWebp(stripWebp(webp).output).chunks.map((c) => c.fourcc)).not.toContain('C2PA');
  });

  it('refuses to rewrite a malformed container rather than corrupt it', () => {
    const webp = makeWebp([{ fourcc: 'EXIF', payload: encodeText('x') }]);
    const truncated = webp.subarray(0, webp.length - 3);
    expect(() => stripWebp(truncated)).toThrow(/malformed/);
  });
});

describe('EXIF walker', () => {
  it('rejects bytes that are not TIFF', () => {
    expect(scanExif(encodeText('not tiff')).parsed).toBe(false);
  });

  it('survives a self-referential IFD chain without hanging', () => {
    // An IFD whose "next" pointer loops back to itself is a valid file to
    // write and an infinite loop to a naive walker.
    const looping = Uint8Array.from(makeExif([{ tag: EXIF_TAG.Make }]));
    const nextOffsetAt = 8 + 2 + 12;
    looping[nextOffsetAt] = 8;
    expect(() => scanExif(looping)).not.toThrow();
    expect(scanExif(looping).parsed).toBe(true);
  });

  it('ignores directory offsets that point past the end', () => {
    const bad = Uint8Array.from(makeExif([{ tag: EXIF_TAG.ExifIfd, value: 0xfffff }]));
    expect(scanExif(bad).parsed).toBe(true);
  });
});

describe('cleanImage', () => {
  it('reports what it cleared and re-inspects the output', async () => {
    const png = makePng([
      { type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }, { tag: EXIF_TAG.Artist }]) },
    ]);
    const result = cleanImage(png);

    expect(result.residual.hasC2pa).toBe(false);
    expect(result.residual.findings).toHaveLength(0);
    expect(result.degraded).toBe(false);
    expect(result.bytesOut).toBeLessThan(result.bytesIn);
    expect(result.actions.some((a) => a.code === 'image.privacy.cleared')).toBe(true);
    expect(inspectImage(result.output).privacy.hasLocation).toBe(false);
  });

  it('leaves provenance-only segments when asked to keep other metadata', () => {
    const jpeg = makeJpeg([
      { marker: 0xe1, payload: app1Exif(makeExif([{ tag: EXIF_TAG.Make }])) },
      { marker: 0xeb, payload: encodeText('c2pa') },
    ]);
    const result = cleanImage(jpeg, { stripAllMetadata: false });
    const markers = parseJpeg(result.output).segments.map((s) => s.marker);
    expect(markers).not.toContain(0xeb);
    expect(markers).toContain(0xe1);
  });

  it('refuses formats it cannot parse', () => {
    expect(() => cleanImage(encodeText('nope'))).toThrow(/unsupported image format/);
  });

  it('labels a raw byte-scan hit as unreliable', () => {
    // "c2pa" appearing in compressed pixel data is a coincidence, not a manifest.
    const typeBytes = Uint8Array.from('IDAT', (c) => c.charCodeAt(0));
    const payload = encodeText('....c2pa....');
    const crc = crc32Of(typeBytes, payload);
    void crc;
    const png = makePng([{ type: 'zTXt', payload: encodeText('x') }]);
    const withMarker = new Uint8Array(png.length + 4);
    withMarker.set(png);
    withMarker.set(encodeText('c2pa'), png.length);

    const report = inspectImage(withMarker);
    const byteScan = report.findings.find((f) => f.code === 'image.bytescan.c2pa');
    expect(byteScan?.confidence).toBe('likely-false-positive');
  });
});
