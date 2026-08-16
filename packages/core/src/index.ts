/**
 * @unmarkk/core — a privacy-first watermark and metadata removal engine.
 *
 * Bytes in, bytes out. No file system, no network, no dependencies, no global
 * state. The same code runs in Node and in a browser tab, which is what lets
 * the web front end promise that nothing you drop on it ever leaves the device:
 * there is no code path that could send it anywhere.
 *
 * ```ts
 * import { inspect, clean, summarise } from '@unmarkk/core';
 *
 * const report = await inspect(bytes, { filename: 'photo.jpg' });
 * console.log(summarise(report).summary);
 *
 * const { output } = await clean(bytes, { filename: 'photo.jpg' });
 * ```
 */

export const VERSION = '1.0.0';

export * from './types.js';
export * from './pipeline.js';
export * from './detect.js';
export * from './markers.js';
export * from './audit.js';
export * from './rewrite.js';

export { inspectText, cleanText, codepointName } from './text/unicode.js';
export type { InspectTextOptions, CleanTextOptions, CleanTextOutcome } from './text/unicode.js';
export * from './text/tables.js';
export {
  scoreStylometry,
  extractWords,
  extractSentences,
  burstiness,
  mattr,
  scanPhrases,
  DEFAULT_THRESHOLD,
} from './text/stylometry.js';

export * from './image/index.js';
export * from './container/index.js';

export { crc32, crc32Of } from './util/crc32.js';
export { decodeText, encodeText } from './util/text-codec.js';
export {
  readZip,
  writeZip,
  listZipNames,
  inflateRaw,
  deflateRaw,
  inflateZlib,
  deflateZlib,
  MAX_UNCOMPRESSED_BYTES,
} from './util/zip.js';
export type { ZipEntry } from './util/zip.js';
