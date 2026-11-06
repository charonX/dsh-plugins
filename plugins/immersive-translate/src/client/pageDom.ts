/**
 * Thin DOM adapter for whole-page translation.
 *
 * Everything decidable without a document lives in `shared/page.ts`; this module
 * only walks the DOM, reads block text, and writes the two attributes the
 * plugin's stylesheet renders.
 *
 * Block detection used to be a tag whitelist (`p`, `li`, headings, cells...),
 * which silently reported "nothing to translate" on any surface built from
 * `div`s - the skills page and the plugin market are both like that. The rule is
 * now a *leaf block*: an element that lays out as a block, carries text, and has
 * no block-level descendant carrying text. That is what the reader sees as one
 * paragraph, whatever tags the author chose.
 *
 * @module dsh-immersive-translate/client/pageDom
 */

import { SKIP_SELECTOR, blockText, isInlineDisplay } from '../shared/page.ts'

/** Attribute carrying the translated text; rendered by `::after`. */
export const TRANSLATION_ATTRIBUTE = 'data-dsh-tr'

/** Attribute carrying the source text a translation was produced from. */
export const SOURCE_ATTRIBUTE = 'data-dsh-tr-src'

/** Stylesheet element id, so a second install replaces instead of duplicating. */
const STYLE_ELEMENT_ID = 'dsh-immersive-translate-page'

/**
 * Stylesheet rendering the translations.
 *
 * `content: attr()` adds no nodes, so a React re-render cannot drop or fight a
 * translation, and unloading is "remove the attributes and this element". The
 * translation takes a secondary label color so the original keeps primacy.
 */
const STYLE_TEXT = [
  `[${TRANSLATION_ATTRIBUTE}]::after {`,
  `  content: attr(${TRANSLATION_ATTRIBUTE});`,
  '  display: block;',
  '  margin-top: 0.25em;',
  '  white-space: pre-wrap;',
  '  color: var(--dsw-alias-label-secondary, #4b5563);',
  '}',
].join('\n')

/** One block that still needs a translation. */
export interface PendingBlock {
  /** The element owning the block's text. */
  readonly element: HTMLElement
  /** Collapsed source text. */
  readonly text: string
}

/**
 * The element whole-page translation is applied to.
 * @returns the document body, or null before there is one.
 */
export function pageRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.body
}

/**
 * Collect the blocks that need a translation right now.
 *
 * One reverse pass computes each element's text (skipped subtrees excluded) and
 * marks the containers that hold a deeper block; a second pass turns the
 * remaining leaves into pending work. Reverse document order means a child is
 * known before its parent, so the scan stays linear instead of re-walking each
 * subtree.
 * @param root - subtree to scan.
 * @returns pending blocks in document order.
 */
export function pendingBlocks(root: ParentNode): PendingBlock[] {
  const doc = root instanceof Document ? root : root.ownerDocument
  const view = doc?.defaultView
  if (doc === null || view === null || view === undefined) return []
  const elements = Array.from(root.querySelectorAll<HTMLElement>('*'))
  const styles = new Map<Element, CSSStyleDeclaration>()
  const texts = new Map<Element, string>()
  const skipped = new Map<Element, boolean>()
  const container = new Set<Element>()

  const styleOf = (element: Element): CSSStyleDeclaration => {
    const cached = styles.get(element)
    if (cached !== undefined) return cached
    const style = view.getComputedStyle(element)
    styles.set(element, style)
    return style
  }
  // `display` is not inherited, so an ancestor that is hidden or unrendered must
  // be walked explicitly: otherwise the inside of a collapsed panel, a closed
  // dialog, or a `display:none` helper would be sent to the model.
  const isSkipped = (element: Element): boolean => {
    const cached = skipped.get(element)
    if (cached !== undefined) return cached
    const parent = element.parentElement
    const style = styleOf(element)
    const result = element.matches(SKIP_SELECTOR)
      || (parent !== null && isSkipped(parent))
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
    skipped.set(element, result)
    return result
  }
  const displayOf = (element: Element): string => styleOf(element).display
  /** Whether this element lays out as a block that could own text. */
  const isBlock = (element: Element): boolean => {
    if (isSkipped(element)) return false
    const display = displayOf(element)
    return display !== 'none' && !isInlineDisplay(display)
  }

  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]
    if (element === undefined) continue
    if (isSkipped(element)) {
      texts.set(element, '')
      continue
    }
    let raw = ''
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        raw += node.nodeValue ?? ''
      } else {
        // Children were classified already; a skipped child contributed ''.
        raw += texts.get(node as Element) ?? ''
      }
      raw += ' '
    }
    const text = blockText(raw)
    texts.set(element, text)
    if (text === '') continue
    for (const child of element.children) {
      if (container.has(child) || (isBlock(child) && (texts.get(child) ?? '') !== '')) {
        container.add(element)
        break
      }
    }
  }

  const pending: PendingBlock[] = []
  for (const element of elements) {
    if (container.has(element)) continue
    if (!isBlock(element)) continue
    const text = texts.get(element) ?? ''
    if (text === '') continue
    const translated = element.getAttribute(TRANSLATION_ATTRIBUTE)
    if (translated !== null) {
      // Unchanged since it was translated: nothing to do.
      if (element.getAttribute(SOURCE_ATTRIBUTE) === text) continue
      clearBlock(element)
    }
    pending.push({ element, text })
  }
  return pending
}

/**
 * Write one translation onto its block.
 * @param block - the pending block the answer belongs to.
 * @param translated - translated text from the Host.
 */
export function applyTranslation(block: PendingBlock, translated: string): void {
  block.element.setAttribute(TRANSLATION_ATTRIBUTE, translated)
  block.element.setAttribute(SOURCE_ATTRIBUTE, block.text)
}

/**
 * Remove every translation under a subtree.
 * @param root - subtree to clear; usually the whole document.
 */
export function clearTranslations(root: ParentNode): void {
  for (const element of root.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}]`)) {
    clearBlock(element)
  }
}

/**
 * Inject the stylesheet that renders translations.
 * @returns an idempotent disposer removing the stylesheet.
 */
export function installPageStyles(): () => void {
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing !== null) return () => { existing.remove() }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
  return () => { style.remove() }
}

function clearBlock(element: Element): void {
  element.removeAttribute(TRANSLATION_ATTRIBUTE)
  element.removeAttribute(SOURCE_ATTRIBUTE)
}
