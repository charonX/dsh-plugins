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

/** Attribute carrying placeholder text while translation is pending or in flight. */
export const PLACEHOLDER_ATTRIBUTE = 'data-dsh-tr-placeholder'

/** Attribute indicating the translation state ('active' | 'pending'). */
export const STATUS_ATTRIBUTE = 'data-dsh-tr-status'

/** Attribute marking a DOM element created and owned by the translation engine. */
export const OWNED_ATTRIBUTE = 'data-dsh-tr-owned'

/** CSS class applied to real subtitle DOM nodes. */
export const SUBTITLE_CLASS = 'dsh-translate-sub'

/** CSS class applied to real placeholder DOM nodes. */
export const PLACEHOLDER_CLASS = 'dsh-translate-placeholder'

/** Stylesheet element id, so a second install replaces instead of duplicating. */
const STYLE_ELEMENT_ID = 'dsh-immersive-translate-page'

/**
 * Stylesheet rendering real subtitle elements and placeholders.
 *
 * Distinct secondary styling with a brand accent bar, normalized font weight
 * and size, and explicit `user-select: text` so users can highlight and copy translations.
 */
const STYLE_TEXT = [
  '@keyframes dsh-tr-pulse {',
  '  0%, 100% { opacity: 0.45; }',
  '  50% { opacity: 1; }',
  '}',
  `.${PLACEHOLDER_CLASS} {`,
  '  display: block;',
  '  margin-top: 0.35em;',
  '  margin-bottom: 0.2em;',
  '  padding-left: 8px;',
  '  white-space: pre-wrap;',
  '  font-size: 0.85em;',
  '  font-weight: 400;',
  '  line-height: 1.45;',
  '  letter-spacing: normal;',
  '  text-transform: none;',
  '  user-select: text;',
  '  -webkit-user-select: text;',
  '}',
  `.${PLACEHOLDER_CLASS}[data-status="pending"] {`,
  '  border-left: 2px dashed var(--dsw-alias-border-l3, #9ca3af);',
  '  color: var(--dsw-alias-label-tertiary, #9ca3af);',
  '  opacity: 0.7;',
  '}',
  `.${PLACEHOLDER_CLASS}[data-status="active"] {`,
  '  border-left: 2px solid var(--dsw-alias-brand-primary, #2563eb);',
  '  color: var(--dsw-alias-brand-primary, #2563eb);',
  '  font-weight: 500;',
  '  animation: dsh-tr-pulse 1.2s ease-in-out infinite;',
  '}',
  `.${SUBTITLE_CLASS} {`,
  '  display: block;',
  '  margin-top: 0.35em;',
  '  margin-bottom: 0.2em;',
  '  padding-left: 8px;',
  '  border-left: 2px solid var(--dsw-alias-brand-primary, #2563eb);',
  '  white-space: pre-wrap;',
  '  color: var(--dsw-alias-label-secondary, #4b5563);',
  '  font-size: 0.9em;',
  '  font-weight: 400;',
  '  line-height: 1.45;',
  '  letter-spacing: normal;',
  '  text-transform: none;',
  '  user-select: text;',
  '  -webkit-user-select: text;',
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
    const src = element.getAttribute(SOURCE_ATTRIBUTE)
    if (src !== null) {
      // Unchanged since it was translated (or verified identical): nothing to do.
      if (src === text) continue
      clearBlock(element)
    } else if (element.getAttribute(PLACEHOLDER_ATTRIBUTE) !== null) {
      clearPlaceholder(element)
    }
    pending.push({ element, text })
  }
  return pending
}

/**
 * Find any child subtitle or placeholder node owned by this plugin.
 * @param element - block container.
 * @returns the owned element, or null if none exists.
 */
export function findOwnedSub(element: Element): HTMLElement | null {
  for (let i = 0; i < element.children.length; i += 1) {
    const child = element.children[i]
    if (child instanceof HTMLElement && child.getAttribute(OWNED_ATTRIBUTE) === 'true') {
      return child
    }
  }
  return null
}

/**
 * Determine whether an element is inside or near the visible viewport.
 * @param el - target element.
 * @param marginPx - viewport boundary margin in pixels (default 400px).
 * @returns true if the element intersects the viewport + margin box.
 */
export function isElementInViewport(el: Element, marginPx = 400): boolean {
  if (typeof window === 'undefined' || !el || typeof el.getBoundingClientRect !== 'function') {
    return true
  }
  const rect = el.getBoundingClientRect()
  const windowHeight = window.innerHeight || document.documentElement?.clientHeight || 800
  const windowWidth = window.innerWidth || document.documentElement?.clientWidth || 1200
  return (
    rect.bottom >= -marginPx &&
    rect.top <= windowHeight + marginPx &&
    rect.right >= -marginPx &&
    rect.left <= windowWidth + marginPx
  )
}

/** Status of an in-progress block placeholder. */
export type PlaceholderStatus = 'pending' | 'active'

/**
 * Mark one element with a placeholder state ('pending' or 'active').
 * Inserts or updates a real DOM node `<span class="dsh-translate-placeholder" data-dsh-tr-owned="true" translate="no">`.
 * @param element - target DOM element.
 * @param status - 'pending' for queued, 'active' for in-flight translation.
 * @param text - localized placeholder label.
 */
export function setPlaceholder(element: HTMLElement, status: PlaceholderStatus, text: string): void {
  element.setAttribute(PLACEHOLDER_ATTRIBUTE, text)
  element.setAttribute(STATUS_ATTRIBUTE, status)

  let sub = findOwnedSub(element)
  if (sub === null) {
    sub = element.ownerDocument.createElement('span')
    sub.setAttribute(OWNED_ATTRIBUTE, 'true')
    sub.setAttribute('translate', 'no')
    element.appendChild(sub)
  }
  sub.className = PLACEHOLDER_CLASS
  sub.setAttribute('data-status', status)
  sub.textContent = text
}

/**
 * Remove placeholder attributes and placeholder DOM node from one element.
 * @param element - target DOM element.
 */
export function clearPlaceholder(element: Element): void {
  element.removeAttribute(PLACEHOLDER_ATTRIBUTE)
  element.removeAttribute(STATUS_ATTRIBUTE)
  const owned = findOwnedSub(element)
  if (owned !== null && owned.classList.contains(PLACEHOLDER_CLASS)) {
    owned.remove()
  }
}

/**
 * Remove placeholder attributes and nodes from every element under root.
 * @param root - subtree root.
 */
export function clearPlaceholders(root: ParentNode): void {
  for (const element of root.querySelectorAll(`[${PLACEHOLDER_ATTRIBUTE}]`)) {
    clearPlaceholder(element)
  }
  for (const owned of root.querySelectorAll(`.${PLACEHOLDER_CLASS}[${OWNED_ATTRIBUTE}="true"]`)) {
    owned.remove()
  }
}

/**
 * Write one translation onto its block.
 * Inserts or updates a real DOM subtitle node `<span class="dsh-translate-sub" data-dsh-tr-owned="true" translate="no">`
 * with selectable text.
 * @param block - the pending block the answer belongs to.
 * @param translated - translated text from the Host.
 */
export function applyTranslation(block: PendingBlock, translated: string): void {
  clearPlaceholder(block.element)
  const cleanTr = translated.trim()
  const cleanSrc = block.text.trim()
  if (cleanTr === '' || cleanTr === cleanSrc) {
    block.element.removeAttribute(TRANSLATION_ATTRIBUTE)
    block.element.removeAttribute(SOURCE_ATTRIBUTE)
    const existing = findOwnedSub(block.element)
    existing?.remove()
    return
  }
  block.element.setAttribute(SOURCE_ATTRIBUTE, block.text)
  block.element.setAttribute(TRANSLATION_ATTRIBUTE, translated)

  let sub = findOwnedSub(block.element)
  if (sub === null) {
    sub = block.element.ownerDocument.createElement('span')
    sub.setAttribute(OWNED_ATTRIBUTE, 'true')
    sub.setAttribute('translate', 'no')
    block.element.appendChild(sub)
  }
  sub.className = SUBTITLE_CLASS
  sub.removeAttribute('data-status')
  sub.textContent = translated
}

/**
 * Remove every translation and subtitle node under a subtree.
 * @param root - subtree to clear; usually the whole document.
 */
export function clearTranslations(root: ParentNode): void {
  for (const element of root.querySelectorAll(`[${TRANSLATION_ATTRIBUTE}], [${PLACEHOLDER_ATTRIBUTE}]`)) {
    clearBlock(element)
  }
  for (const owned of root.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`)) {
    owned.remove()
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
  clearPlaceholder(element)
  const owned = findOwnedSub(element)
  owned?.remove()
}
