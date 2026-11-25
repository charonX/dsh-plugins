/**
 * Block selection and batch planning for whole-page translation.
 *
 * DOM-free on purpose: the rules that decide what becomes one block, which
 * strings are sent once, and how blocks split into requests are the parts worth
 * testing, and the Node test environment has no DOM. The thin adapter that walks
 * a real document lives in `client/pageDom.ts`.
 *
 * @module dsh-immersive-translate/shared/page
 */

/**
 * Displays that make an element part of an inline run instead of a block.
 *
 * A paragraph and a `div` card body are blocks; the `span`/`strong`/inline-chip
 * inside them are not. `contents` belongs here because the element contributes no
 * box of its own, so the nearest real block above it owns the text.
 */
const INLINE_DISPLAYS: ReadonlySet<string> = new Set([
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'inline-table',
  'contents',
  'ruby',
  'ruby-base',
  'ruby-text',
])

/**
 * Whether a computed `display` participates in an inline run.
 * @param display - `getComputedStyle(element).display`.
 * @returns true for inline-level and zero-box displays.
 */
export function isInlineDisplay(display: string): boolean {
  return INLINE_DISPLAYS.has(display)
}

/**
 * Tags whose subtree is never translated.
 *
 * `pre`/`code` hold literal source; form controls own their value; `script` and
 * `style` have no visible text at all.
 */
export const SKIP_TAGS = [
  'pre',
  'code',
  'textarea',
  'input',
  'select',
  'option',
  'script',
  'style',
  'noscript',
] as const

/**
 * Selector matching a subtree no translation may touch.
 *
 * `[data-dsh-translate-ui]` is this plugin's own surface: the panel must never
 * translate itself. A block that already carries a translation is handled
 * separately, because it may have gone stale and then needs the opposite
 * treatment.
 */
export const SKIP_SELECTOR = [
  ...SKIP_TAGS,
  '[contenteditable]',
  '[hidden]',
  '[data-dsh-translate-ui]',
  '[data-dsh-tr-owned="true"]',
].join(',')

/**
 * Collapse a block's text into one line for the model.
 * @param raw - the element's raw text content.
 * @returns the text with runs of whitespace collapsed and edges trimmed.
 */
export function blockText(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim()
}

/** Limits the planner honours; both come from the Host's `/api/state`. */
export interface PageLimits {
  /** Text units one request may carry. */
  readonly maxItemsPerBatch: number
  /** Longest accepted single text unit in UTF-16 code units. */
  readonly maxCharsPerItem: number
  /** Optional destination language tag, e.g. 'zh-CN', 'en'. */
  readonly targetLanguage?: string
}

const DEV_TOOL_KEYWORDS: ReadonlySet<string> = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'bash', 'zsh', 'sh', 'ssh',
  'http', 'https', 'url', 'uri', 'api', 'cli', 'sdk', 'gui', 'ui',
  'dom', 'css', 'html', 'js', 'ts', 'jsx', 'tsx', 'json', 'yaml',
  'yml', 'toml', 'sql', 'readme', 'license', 'docker', 'dockerfile',
])

/**
 * Whether a text contains any linguistic letters (Latin, Han, Kana, Hangul, Cyrillic, etc.).
 * Pure symbols, numbers, punctuation, or whitespace cannot be meaningfully translated.
 * @param text - normalized block text.
 * @returns true if text contains translatable characters.
 */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  // Skip standalone URLs
  if (/^https?:\/\/[^\s]+$/u.test(trimmed)) return false
  // Skip standalone commit hashes or hex object IDs (at least one digit and 7-64 hex chars, or 32+ hex chars)
  if (/^(?=.*\d)[0-9a-fA-F]{7,64}$|^[0-9a-fA-F]{32,64}$/u.test(trimmed)) return false
  // Skip standalone versions like v1.2.0, 0.2.2-alpha.3
  if (/^v?\d+(\.\d+)+(-[a-zA-Z0-9.]+)?$/u.test(trimmed)) return false
  // Skip standalone kebab-case / snake_case slugs without spaces (e.g. backnotprop-pstack, foo_bar)
  if (/^[a-zA-Z0-9]+([-_][a-zA-Z0-9]+)+$/u.test(trimmed)) return false
  // Skip common standalone developer tool / tech abbreviations (e.g. git, npm, cli, json)
  if (DEV_TOOL_KEYWORDS.has(trimmed.toLowerCase())) return false
  // Must contain at least one letter in any alphabet or script
  return /\p{L}/u.test(trimmed)
}

/**
 * Whether a text is already in the requested destination language.
 * E.g. when translating to Chinese, text that is already primarily Chinese
 * does not need to be translated and should not be duplicated.
 *
 * @param text - normalized block text.
 * @param targetLanguage - destination language tag, e.g. 'zh-CN', 'en'.
 * @returns true if text is already in the target language.
 */
export function isAlreadyInTargetLanguage(text: string, targetLanguage?: string): boolean {
  if (targetLanguage === undefined || targetLanguage.trim() === '') return false
  const trimmed = text.trim()
  if (trimmed === '') return true

  const tag = targetLanguage.toLowerCase()

  // Chinese target languages (zh, zh-CN, zh-TW, zh-HK, etc.)
  if (tag.startsWith('zh')) {
    const hanMatches = trimmed.match(/\p{Script=Han}/gu)
    if (!hanMatches) return false
    const hanCount = hanMatches.length
    const latinMatches = trimmed.match(/[a-zA-Z]/gu)
    const latinCount = latinMatches ? latinMatches.length : 0

    // 1. Pure Chinese text (with optional numbers, punctuation, spaces)
    if (latinCount === 0) return true

    // 2. Chinese characters are greater or equal to Latin characters (e.g. "DSH 本地构建")
    if (hanCount >= latinCount) return true

    // 3. Starts with Chinese label followed by path/code (e.g. "技能目录 : skills/architect", "版本 4ae1636")
    if (/^\p{Script=Han}+[\s:：·/_-]/u.test(trimmed)) return true

    // 4. Substantial Chinese presence (>= 25% of all letters/Hanzi)
    if (hanCount / (hanCount + latinCount) >= 0.25) return true

    return false
  }

  // English target language (en, en-US, etc.)
  if (tag.startsWith('en')) {
    const hanMatches = trimmed.match(/\p{Script=Han}/gu)
    if (hanMatches && hanMatches.length > 0) return false
    const latinMatches = trimmed.match(/[a-zA-Z]/gu)
    return (latinMatches?.length ?? 0) > 0
  }

  return false
}

/** One distinct string to translate, addressed by a request-local id. */
export interface BlockRequest {
  /** Request-local id; also the id the answer carries. */
  readonly id: string
  /** Collapsed source text. */
  readonly text: string
}

/** One block the adapter found, before planning. */
export interface PageBlock {
  /** Adapter-assigned key; opaque to the planner. */
  readonly key: string
  /** Collapsed source text. */
  readonly text: string
}

/** A plan that connects page blocks to requests and requests to batches. */
export interface PagePlan {
  /** Requests grouped into batches, in page order. */
  readonly batches: readonly (readonly BlockRequest[])[]
  /** Page block key to request id, for every block that will be sent. */
  readonly requestOf: ReadonlyMap<string, string>
  /**
   * Request id to the page block keys it answers.
   *
   * One request per distinct string means several blocks can share an answer;
   * a batch is applied as soon as its answer arrives, so this map is what lets
   * the adapter paint block by block instead of waiting for the whole page.
   */
  readonly blocksByRequest: ReadonlyMap<string, readonly string[]>
  /** Page block keys left out entirely. */
  readonly skipped: readonly string[]
}

/**
 * Plan one page sweep: de-duplicate text, assign request ids, split into batches.
 *
 * Identical strings are sent once and shared by every block that carries them,
 * which is most of the saving on a settings page. A block above the per-item
 * limit is skipped rather than truncated: half a sentence translated is worse
 * than an untranslated one.
 * @param blocks - blocks the adapter found, in page order.
 * @param limits - request ceilings.
 * @returns the batches, the block-to-request map, and the skipped keys.
 */
export function planPage(blocks: readonly PageBlock[], limits: PageLimits): PagePlan {
  const size = Math.max(1, Math.floor(limits.maxItemsPerBatch))
  const requestOf = new Map<string, string>()
  const blocksByRequest = new Map<string, string[]>()
  const requests: BlockRequest[] = []
  const skipped: string[] = []
  const seen = new Map<string, string>()
  for (const block of blocks) {
    if (
      block.text === '' ||
      block.text.length > limits.maxCharsPerItem ||
      (limits.targetLanguage !== undefined && (
        !isTranslatableText(block.text) ||
        isAlreadyInTargetLanguage(block.text, limits.targetLanguage)
      ))
    ) {
      skipped.push(block.key)
      continue
    }
    const known = seen.get(block.text)
    if (known !== undefined) {
      requestOf.set(block.key, known)
      blocksByRequest.get(known)?.push(block.key)
      continue
    }
    const id = `b${String(seen.size)}`
    seen.set(block.text, id)
    requestOf.set(block.key, id)
    blocksByRequest.set(id, [block.key])
    requests.push({ id, text: block.text })
  }
  const batches: BlockRequest[][] = []
  for (let index = 0; index < requests.length; index += size) {
    batches.push(requests.slice(index, index + size))
  }
  return { batches, requestOf, blocksByRequest, skipped }
}
