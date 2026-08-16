import { describe, expect, it } from 'vitest';
import { clean, inspect, summarise, UnmarkInputError } from '../src/pipeline.js';
import { classify, sniffBinary } from '../src/detect.js';
import { scoreStylometry, burstiness, mattr, extractSentences } from '../src/text/stylometry.js';
import { readZip, writeZip, MAX_UNCOMPRESSED_BYTES } from '../src/util/zip.js';
import { crc32 } from '../src/util/crc32.js';
import { decodeText, encodeText } from '../src/util/text-codec.js';
import {
  EXIF_TAG,
  makeDocx,
  makeExif,
  makeJpeg,
  makeOdt,
  makePdf,
  makePng,
  app1Exif,
} from './fixtures.js';

describe('sniffBinary', () => {
  it('recognises container magic numbers', () => {
    expect(sniffBinary(makePng())).toContain('PNG');
    expect(sniffBinary(makePdf())).toContain('PDF');
    expect(sniffBinary(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toContain('ZIP');
  });

  it('accepts text in encodings other than UTF-8', () => {
    // Latin-1 bytes are undecodable as UTF-8 but are still text, and a tool
    // that refused them would be useless outside the anglosphere.
    expect(sniffBinary(Uint8Array.of(0x48, 0xeb, 0x6c, 0x6c, 0xf6))).toBeNull();
  });

  it('rejects NUL bytes and dense control bytes', () => {
    expect(sniffBinary(Uint8Array.of(0x61, 0x00, 0x62))).toContain('NUL');
    expect(sniffBinary(new Uint8Array(200).fill(0x01))).toContain('control bytes');
  });

  it('treats empty input as text', () => {
    expect(sniffBinary(new Uint8Array(0))).toBeNull();
  });
});

describe('classify', () => {
  it('prefers the extension when it names a format', async () => {
    expect(await classify(encodeText('# hi'), 'notes.md')).toBe('container');
    expect(await classify(encodeText('plain'), 'notes.txt')).toBe('text');
    expect(await classify(makePng(), 'photo.png')).toBe('image');
  });

  it('sniffs when the name says nothing', async () => {
    expect(await classify(makePng())).toBe('image');
    expect(await classify(makeJpeg())).toBe('image');
    expect(await classify(makePdf())).toBe('container');
    expect(await classify(await makeDocx())).toBe('container');
    expect(await classify(await makeOdt())).toBe('container');
  });

  it('falls back to text for anything unrecognised', async () => {
    expect(await classify(encodeText('some prose'))).toBe('text');
  });
});

describe('inspect', () => {
  it('routes to the right engine', async () => {
    expect((await inspect(makePng(), { filename: 'a.png' })).kind).toBe('image');
    expect((await inspect(makePdf(), { filename: 'a.pdf' })).kind).toBe('container');
    expect((await inspect(encodeText('hi'), { filename: 'a.txt' })).kind).toBe('text');
  });

  it('refuses to read a binary container as text', async () => {
    await expect(inspect(await makeDocx(), { as: 'text' })).rejects.toThrow(UnmarkInputError);
  });

  it('can be forced past the binary guard', async () => {
    const report = await inspect(await makeDocx(), { as: 'text', forceText: true });
    expect(report.kind).toBe('text');
  });

  it('includes stylometry only when asked', async () => {
    const prose = encodeText('A short sentence. Another one here.');
    const without = await inspect(prose, { filename: 'a.txt' });
    expect(without.kind === 'text' && without.stylometry).toBeUndefined();

    const withScore = await inspect(prose, { filename: 'a.txt', stylometry: true });
    expect(withScore.kind === 'text' && withScore.stylometry).toBeDefined();
  });
});

describe('clean', () => {
  it('round-trips text through the byte layer without loss', async () => {
    const raw = Uint8Array.of(0x48, 0xeb, 0x6c, 0x6c, 0xff);
    const result = await clean(raw, { filename: 'latin1.txt' });
    expect(result.output).toEqual(raw);
  });

  it('reports stats for text', async () => {
    const result = await clean(encodeText('a​b'), { filename: 'a.txt' });
    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.stats.removedCount).toBe(1);
  });

  it('refuses binary input routed as text', async () => {
    await expect(clean(makePng(), { as: 'text' })).rejects.toThrow(UnmarkInputError);
  });
});

describe('summarise', () => {
  it('is quiet about a clean file', async () => {
    const report = await inspect(encodeText('ordinary prose'), { filename: 'a.txt' });
    const verdict = summarise(report);
    expect(verdict.flagged).toBe(false);
    expect(verdict.highestConfidence).toBe('none');
  });

  it('flags identifying metadata even with no AI provenance at all', async () => {
    const png = makePng([{ type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) }]);
    const verdict = summarise(await inspect(png, { filename: 'a.png' }));
    expect(verdict.flagged).toBe(true);
    expect(verdict.summary).toContain('location');
  });

  it('flags a confirmed finding even when it fits no privacy category', async () => {
    // A real macOS screenshot carries an eXIf block holding only
    // ExifIFDPointer and UserComment. Neither is location, device, author or
    // timestamp, so a verdict keyed solely off those categories called the
    // file clean while printing a confirmed finding directly underneath it.
    // A false clean is the worst thing this tool can output.
    const png = makePng([{ type: 'eXIf', payload: makeExif([{ tag: 0x8769 }, { tag: 0x9286 }]) }]);
    const report = await inspect(png, { filename: 'shot.png' });
    const verdict = summarise(report);

    expect(report.findings.some((f) => f.confidence === 'confirmed')).toBe(true);
    expect(verdict.flagged).toBe(true);
    expect(verdict.summary).not.toBe('no metadata found');
  });

  it('never says "no metadata found" while listing a substantiated finding', async () => {
    for (const png of [
      makePng([{ type: 'eXIf', payload: makeExif([{ tag: 0x9286 }]) }]),
      makePng([{ type: 'tIME', payload: Uint8Array.of(7, 0xea, 1, 5, 9, 12, 0) }]),
      makePng([{ type: 'eXIf', payload: makeExif([{ tag: 0x8769 }]) }]),
    ]) {
      const report = await inspect(png, { filename: 'x.png' });
      const verdict = summarise(report);
      const substantiated = report.findings.filter(
        (f) => f.confidence === 'confirmed' || f.confidence === 'probable',
      );
      if (substantiated.length > 0) {
        expect(verdict.flagged, verdict.summary).toBe(true);
        expect(verdict.summary).not.toBe('no metadata found');
      }
    }
  });

  it('names the strongest confidence it saw', async () => {
    const jpeg = makeJpeg([
      { marker: 0xe1, payload: app1Exif(makeExif([{ tag: EXIF_TAG.Make }])) },
    ]);
    expect(summarise(await inspect(jpeg, { filename: 'a.jpg' })).highestConfidence).toBe(
      'confirmed',
    );
  });
});

describe('stylometry', () => {
  it('refuses to score a sample that is too short', () => {
    const report = scoreStylometry('Too few words to say anything about.');
    expect(report.status).toBe('insufficient-length');
    expect(report.score).toBe(0);
    expect(report.notes.some((n) => n.includes('meaningless'))).toBe(true);
  });

  it('scores formulaic prose above varied prose', () => {
    const formulaic = Array.from(
      { length: 12 },
      (_, i) =>
        `In today's fast-paced world it is important to note that this plays a pivotal role in the process number ${i}.`,
    ).join(' ');
    const varied =
      'Rain. It had been raining since Tuesday, the kind of grey persistent drizzle that gets into your ' +
      'shoes and stays there. My neighbour, who I have never much liked, chose that morning to tell me ' +
      'at length about his boiler. I nodded. What else can you do? Later the sun came out for eleven ' +
      'minutes and everyone on the street pretended not to notice how much it mattered to them.';

    const a = scoreStylometry(formulaic);
    const b = scoreStylometry(varied);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.level).toBe('HIGH');
    expect(b.level).toBe('CLEAN');
  });

  it('never claims more than heuristic status', () => {
    const report = scoreStylometry('word '.repeat(200));
    expect(report.notes[0]).toContain('heuristic');
    expect(report.findings.every((f) => f.confidence === 'informational')).toBe(true);
  });

  it('ignores fenced code blocks when splitting sentences', () => {
    const withCode =
      'A sentence here.\n\n```\nconst x = 1;\nconst y = 2;\n```\n\nAnother sentence.';
    expect(extractSentences(withCode)).toEqual(['A sentence here.', 'Another sentence.']);
  });

  it('computes burstiness as a coefficient of variation', () => {
    expect(burstiness(['one two three', 'four five six'])).toBe(0);
    expect(burstiness(['a', 'b c d e f g h i j k'])).toBeGreaterThan(0.8);
  });

  it('keeps MATTR independent of document length', () => {
    // The whole reason to prefer a moving average over plain type-token ratio:
    // the same vocabulary must not score lower merely for going on longer.
    // Both samples are above the 50-word window, where the average applies.
    const shorter = 'alpha beta gamma delta epsilon '.repeat(20).trim().split(' ');
    const longer = 'alpha beta gamma delta epsilon '.repeat(200).trim().split(' ');
    expect(Math.abs(mattr(shorter) - mattr(longer))).toBeLessThan(0.01);

    // Plain TTR, by contrast, collapses as the document grows.
    const ttr = (words: string[]): number => new Set(words).size / words.length;
    expect(ttr(shorter) - ttr(longer)).toBeGreaterThan(0.04);
  });
});

describe('zip', () => {
  it('round-trips names, order, contents and method', async () => {
    const entries = [
      {
        name: 'mimetype',
        data: encodeText('text/plain'),
        method: 0,
        dosTime: 0,
        dosDate: 33,
        externalAttributes: 0,
      },
      {
        name: 'a/b.xml',
        data: encodeText('<x/>'.repeat(200)),
        method: 8,
        dosTime: 1,
        dosDate: 33,
        externalAttributes: 0,
      },
    ];
    const back = await readZip(await writeZip(entries));

    expect(back.map((e) => e.name)).toEqual(['mimetype', 'a/b.xml']);
    expect(back[0]?.method).toBe(0);
    expect(back[1]?.method).toBe(8);
    expect(decodeText(back[1]!.data)).toBe('<x/>'.repeat(200));
  });

  it('actually compresses deflated entries', async () => {
    const repetitive = encodeText('a'.repeat(10000));
    const archive = await writeZip([
      {
        name: 'big.txt',
        data: repetitive,
        method: 8,
        dosTime: 0,
        dosDate: 33,
        externalAttributes: 0,
      },
    ]);
    expect(archive.length).toBeLessThan(repetitive.length / 4);
  });

  it('writes correct CRCs', async () => {
    const data = encodeText('checksum me');
    const archive = await writeZip([
      { name: 'f.txt', data, method: 8, dosTime: 0, dosDate: 33, externalAttributes: 0 },
    ]);
    // The local header's CRC field sits at a fixed offset.
    const view = new DataView(archive.buffer, archive.byteOffset);
    expect(view.getUint32(14, true)).toBe(crc32(data));
  });

  it('rejects input that is not a ZIP', async () => {
    await expect(readZip(encodeText('not a zip'))).rejects.toThrow(/not a ZIP/);
  });

  it('has a decompression budget', () => {
    expect(MAX_UNCOMPRESSED_BYTES).toBeGreaterThan(0);
    expect(MAX_UNCOMPRESSED_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  it('handles an empty archive', async () => {
    expect(await readZip(await writeZip([]))).toEqual([]);
  });
});
