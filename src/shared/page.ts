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
    if (block.text === '' || block.text.length > limits.maxCharsPerItem) {
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
