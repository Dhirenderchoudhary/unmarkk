import { describe, expect, it } from 'vitest';
import { auditBytes, buildAuditReport, rankItems, summariseAudit } from '../src/audit.js';
import {
  assessRewrite,
  buildPrompt,
  lexicalDivergence,
  rewriteModes,
  selectCandidate,
} from '../src/rewrite.js';
import { encodeText } from '../src/util/text-codec.js';
import { EXIF_TAG, makeExif, makePng, makeDocx } from './fixtures.js';

describe('auditBytes', () => {
  it('flattens an image report into a countable row', async () => {
    const png = makePng([
      { type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }, { tag: EXIF_TAG.Artist }]) },
    ]);
    const item = await auditBytes(png, 'photo.png');

    expect(item.kind).toBe('image');
    expect(item.format).toBe('png');
    expect(item.actionable).toBe(true);
    expect(item.privacy.some((p) => p.startsWith('location'))).toBe(true);
    expect(item.bytes).toBe(png.length);
  });

  it('counts invisible characters for text', async () => {
    const item = await auditBytes(encodeText('he​llo'), 'note.txt');
    expect(item.kind).toBe('text');
    expect(item.suspiciousTotal).toBe(1);
    expect(item.actionable).toBe(true);
  });

  it('leaves a clean file unflagged', async () => {
    const item = await auditBytes(encodeText('ordinary prose'), 'note.txt');
    expect(item.actionable).toBe(false);
    expect(item.findings).toHaveLength(0);
  });

  it('adds a stylometry finding only when asked and only above threshold', async () => {
    const formulaic = encodeText(
      Array.from(
        { length: 12 },
        (_, i) =>
          `In today's fast-paced world it is important to note that this plays a pivotal role in process ${i}.`,
      ).join(' '),
    );

    const without = await auditBytes(formulaic, 'a.txt');
    expect(without.stylometryScore).toBeUndefined();

    const withScore = await auditBytes(formulaic, 'a.txt', { stylometry: true });
    expect(withScore.stylometryLevel).toBe('HIGH');
    expect(withScore.findings.some((f) => f.code === 'text.stylometry.flagged')).toBe(true);
  });

  it('records an error rather than throwing', async () => {
    // A .docx extension over bytes that are not a zip: the container engine
    // reports it rather than blowing up the whole audit.
    const item = await auditBytes(encodeText('not a zip at all'), 'broken.docx');
    expect(item.error ?? item.findings.length > 0).toBeTruthy();
  });
});

describe('summariseAudit', () => {
  it('counts by format, confidence and exposure', async () => {
    const items = [
      await auditBytes(
        makePng([{ type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }]) }]),
        'a.png',
      ),
      await auditBytes(encodeText('he​llo'), 'b.txt'),
      await auditBytes(encodeText('nothing here'), 'c.txt'),
    ];

    const summary = summariseAudit(items);
    expect(summary.total).toBe(3);
    expect(summary.actionable).toBe(2);
    expect(summary.byKind['png']).toBe(1);
    expect(summary.byKind['text']).toBe(2);
    expect(summary.withLocation).toBe(1);
    expect(summary.withInvisibleText).toBe(1);
    expect(summary.highestConfidence).toBe('confirmed');
  });

  it('handles an empty audit', () => {
    const summary = summariseAudit([]);
    expect(summary.total).toBe(0);
    expect(summary.highestConfidence).toBe('none');
  });
});

describe('rankItems', () => {
  it('puts the worst first', async () => {
    const clean = await auditBytes(encodeText('nothing'), 'clean.txt');
    const invisible = await auditBytes(encodeText('a​b'), 'invisible.txt');
    const photo = await auditBytes(
      makePng([
        { type: 'eXIf', payload: makeExif([{ tag: EXIF_TAG.GpsInfo }, { tag: EXIF_TAG.Artist }]) },
      ]),
      'photo.png',
    );

    const ranked = rankItems([clean, invisible, photo]);
    expect(ranked[0]?.name).toBe('photo.png');
    expect(ranked[2]?.name).toBe('clean.txt');
  });
});

describe('buildAuditReport', () => {
  it('carries the root, summary and skipped list', async () => {
    const item = await auditBytes(await makeDocx(), 'report.docx');
    const report = buildAuditReport('/tmp', [item], [{ name: 'x.bin', reason: 'too large' }]);

    expect(report.root).toBe('/tmp');
    expect(report.summary.total).toBe(1);
    expect(report.skipped[0]?.reason).toBe('too large');
  });
});

describe('rewrite prompts', () => {
  it('offers every documented mode', () => {
    const modes = rewriteModes().map((m) => m.mode);
    expect(modes).toContain('paraphrase');
    expect(modes).toContain('humanize');
    expect(modes).toContain('code');
    expect(modes).toContain('outline');
  });

  it('substitutes the text into the template', () => {
    const prompt = buildPrompt('paraphrase', 'The quick brown fox.');
    expect(prompt).toContain('The quick brown fox.');
    expect(prompt).not.toContain('{TEXT}');
  });

  it('substitutes the language for back-translation', () => {
    const prompt = buildPrompt('backtranslate-out', 'hello', { language: 'Japanese' });
    expect(prompt).toContain('Japanese');
    expect(prompt).not.toContain('{LANGUAGE}');
  });

  it('rejects an unknown mode', () => {
    // @ts-expect-error deliberately invalid
    expect(() => buildPrompt('nonsense', 'x')).toThrow(/unknown rewrite mode/);
  });
});

describe('lexicalDivergence', () => {
  it('is 0 for identical text and 1 for unrelated text', () => {
    expect(lexicalDivergence('the quick brown fox', 'the quick brown fox')).toBe(0);
    expect(lexicalDivergence('alpha beta gamma', 'xylophone yacht zebra')).toBe(1);
  });

  it('measures word pairs, not words', () => {
    // Same vocabulary, different order: single-word overlap is total, but the
    // sentence shape moved — which is what a sampling watermark rides on.
    const reordered = lexicalDivergence('the cat sat on the mat', 'the mat sat on the cat');
    expect(reordered).toBeGreaterThan(0.3);
    expect(reordered).toBeLessThan(1);
  });

  it('handles empty input on either side', () => {
    expect(lexicalDivergence('', '')).toBe(0);
    expect(lexicalDivergence('words here', '')).toBe(1);
  });
});

describe('selectCandidate', () => {
  it('picks the most diverged candidate', () => {
    const original = 'the quick brown fox jumps over the lazy dog';
    const { best } = selectCandidate(original, [
      'the quick brown fox jumps over the lazy dog',
      'a swift auburn vulpine bounds above an idle hound',
    ]);
    expect(best.text).toContain('vulpine');
  });

  it('penalises a candidate that changed length drastically', () => {
    const original = 'one two three four five six seven eight nine ten eleven twelve';
    // Both are fully diverged, but the short one threw the content away.
    const { best } = selectCandidate(original, [
      'x',
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    ]);
    expect(best.text).toContain('bravo');
  });

  it('refuses an empty candidate list', () => {
    expect(() => selectCandidate('x', [])).toThrow(/no candidates/);
  });
});

describe('assessRewrite', () => {
  it('never claims the watermark was removed', () => {
    const assessment = assessRewrite('some original text here', 'entirely different wording now');
    const joined = assessment.notes.join(' ').toLowerCase();
    expect(joined).toContain('cannot be measured');
    expect(joined).not.toContain('undetectable');
    expect(joined).toContain('not a detection result');
  });

  it('flags a rewrite that barely moved', () => {
    const original = 'the quick brown fox jumps over the lazy dog again and again today';
    const assessment = assessRewrite(original, `${original} also`);
    expect(assessment.residualRisk).toBe('higher');
    expect(assessment.notes.some((n) => n.includes('close to the original'))).toBe(true);
  });

  it('calls a long passage higher risk after one pass', () => {
    const long = 'alpha bravo charlie delta echo foxtrot '.repeat(80);
    const rewritten = 'one two three four five six '.repeat(80);
    expect(assessRewrite(long, rewritten).residualRisk).toBe('higher');
  });

  it('calls a short sample lower risk', () => {
    const assessment = assessRewrite(
      'A short original sentence with some words in it.',
      'A brief initial line containing a handful of different terms.',
    );
    expect(assessment.residualRisk).toBe('lower');
  });

  it('warns when the length drifted a long way', () => {
    const original = 'one two three four five six seven eight nine ten '.repeat(6);
    const assessment = assessRewrite(original, 'tiny');
    expect(assessment.notes.some((n) => n.includes('Length changed'))).toBe(true);
  });
});
