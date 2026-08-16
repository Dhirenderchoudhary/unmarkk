/** Key and attribute names that carry provenance in document containers. */

/** Top-level frontmatter / metadata keys that announce a generator. */
export const AI_METADATA_KEYS: ReadonlySet<string> = new Set([
  'generator',
  'ai',
  'ai_generated',
  'ai-generated',
  'aigenerated',
  'synthid',
  'c2pa',
  'content_credentials',
  'contentcredentials',
  'provenance',
  'digital_source_type',
  'digitalsourcetype',
  'created_with',
  'createdwith',
  'model',
  'llm',
]);

/** Frontmatter keys that identify a person or a moment rather than a tool. */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'author',
  'authors',
  'byline',
  'creator',
  'email',
  'contact',
  'date',
  'created',
  'modified',
  'last_modified',
  'lastmod',
  'location',
  'geo',
  'coordinates',
]);

/** Matches a metadata name or value that suggests AI provenance. */
export const AI_NAME_PATTERN =
  /generator|ai[-_ ]?generated|synthid|c2pa|content.?credential|provenance|digital.?source|aigc|trainedalgorithmic/i;

/**
 * Vendor names, used only to tell an AI generator tag from an ordinary one.
 *
 * `<meta name="generator" content="WordPress 6.4">` is CMS provenance and
 * gets left alone; the same tag naming an image or text model does not.
 */
export const AI_VENDOR_PATTERN =
  /\b(?:openai|chatgpt|gpt-[0-9]|claude|anthropic|gemini|bard|copilot|midjourney|dall.?e|stable.?diffusion|firefly|synthid|llama|mistral)\b/i;
