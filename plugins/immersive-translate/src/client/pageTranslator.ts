/**
 * Whole-page translation: scan, plan, request, paint, and top up.
 *
 * One instance per page, owned by the browser half rather than by the panel, so
 * closing the panel does not throw away the translations. The panel only reads a
 * snapshot and calls `start`/`restore`; everything stateful lives here.
 *
 * @module dsh-immersive-translate/client/pageTranslator
 */

import { ApiFailure, translate } from './api.ts'
import {
  applyTranslation,
  clearPlaceholder,
  clearPlaceholders,
  clearTranslations,
  installPageStyles,
  isElementInViewport,
  pageRoot,
  pendingBlocks,
  setPlaceholder,
  type PendingBlock,
} from './pageDom.ts'
import { planPage, type PageLimits } from '../shared/page.ts'
import { zh, type MessageKey } from './locales.ts'

/**
 * Filter dirty DOM nodes so nested children are collapsed into their outermost dirty ancestor.
 * @param roots - dirty nodes observed during mutations.
 * @returns minimal set of ancestor elements.
 */
export function consolidateRoots(roots: Iterable<Node>): Element[] {
  const elements = Array.from(roots).filter((n): n is Element => n instanceof Element && n.isConnected)
  return elements.filter(el => !elements.some(other => other !== el && other.contains(el)))
}

/**
 * Yield execution to the browser main thread to avoid dropping frames (60fps).
 */
export async function yieldToMain(): Promise<void> {
  if (typeof scheduler !== 'undefined' && typeof (scheduler as { yield?: () => Promise<void> }).yield === 'function') {
    await (scheduler as { yield: () => Promise<void> }).yield()
  } else {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** Observable state of page translation. */
export interface PageState {
  /** Whether the page is currently translated (and will stay topped up). */
  readonly active: boolean
  /** Whether a sweep is in flight right now. */
  readonly running: boolean
  /** Blocks finished in the current sweep. */
  readonly done: number
  /** Total blocks the current sweep planned. */
  readonly total: number
  /** Batches finished in the current sweep. */
  readonly batchDone: number
  /** Total batches the current sweep planned. */
  readonly batchTotal: number
  /** Blocks translated since the page went active; cumulative, not per sweep. */
  readonly translated: number
  /** Last failure, already rendered as text; cleared by the next sweep. */
  readonly error: string | null
}

/** What a sweep needs from the reader's preferences and the Host limits. */
export interface PageStartOptions extends PageLimits {
  /** Destination language tag. */
  readonly targetLanguage: string
}

/** Idle snapshot; also what `restore` returns to. */
const IDLE: PageState = {
  active: false,
  running: false,
  done: 0,
  total: 0,
  batchDone: 0,
  batchTotal: 0,
  translated: 0,
  error: null,
}

/** Coalescing window for DOM mutations, in milliseconds. */
const SETTLE_MS = 300

/** Page translation kept out of React: DOM attributes plus a stylesheet. */
export class PageTranslator {
  constructor(private readonly t: (key: MessageKey) => string = (key) => zh[key] ?? key) {}

  private state: PageState = IDLE
  private options: PageStartOptions | null = null
  private readonly listeners = new Set<() => void>()
  private readonly dirtyRoots = new Set<Node>()
  private observer: MutationObserver | null = null
  private styles: (() => void) | null = null
  private request: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private sweeping = false
  private rerun = false

  /**
   * @returns the current state; stable between notifications.
   */
  readonly snapshot = (): PageState => this.state

  /**
   * Subscribe to state changes.
   * @param listener - called after every change.
   * @returns an unsubscribe function.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Start translating the page, or adopt new preferences while already active.
   * @param options - destination language and the Host's request limits.
   */
  start(options: PageStartOptions): void {
    const root = pageRoot()
    if (root === null) return
    this.options = options
    if (!this.state.active) {
      this.styles = installPageStyles()
      this.observe(root)
      this.update({ active: true, done: 0, total: 0, error: null })
    }
    void this.sweep(root)
  }

  /**
   * Stop topping the page up and remove every translation.
   *
   * Applied translations are removed even when a sweep failed, so this is always
   * the way back to the untouched page.
   */
  restore(): void {
    this.request?.abort()
    this.request = null
    this.disconnect()
    clearTranslations(document)
    this.update(IDLE)
  }

  /** Watch the page for new or changed text while translation is active. */
  private observe(root: HTMLElement): void {
    this.observer?.disconnect()
    this.observer = new MutationObserver((mutations) => {
      let hasRelevant = false
      for (const mutation of mutations) {
        // 1. Ignore mutations originating entirely within plugin's own UI or owned subtitles
        const target = mutation.target
        if (target instanceof Element) {
          if (
            target.closest('[data-dsh-translate-ui]') !== null ||
            target.closest('[data-dsh-tr-owned="true"]') !== null
          ) {
            continue
          }
        } else if (target.parentElement) {
          if (
            target.parentElement.closest('[data-dsh-translate-ui]') !== null ||
            target.parentElement.closest('[data-dsh-tr-owned="true"]') !== null
          ) {
            continue
          }
        }

        // 2. Ignore childList mutations where all added and removed nodes are plugin-owned
        if (mutation.type === 'childList') {
          let onlyOwned = true
          for (let i = 0; i < mutation.addedNodes.length; i += 1) {
            const node = mutation.addedNodes[i]
            if (!(node instanceof Element && node.getAttribute('data-dsh-tr-owned') === 'true')) {
              onlyOwned = false
              break
            }
          }
          if (onlyOwned) {
            for (let i = 0; i < mutation.removedNodes.length; i += 1) {
              const node = mutation.removedNodes[i]
              if (!(node instanceof Element && node.getAttribute('data-dsh-tr-owned') === 'true')) {
                onlyOwned = false
                break
              }
            }
          }
          if (onlyOwned && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
            continue
          }
        }

        // 3. Mark dirty root for incremental sweeping
        hasRelevant = true
        const dirtyNode = target instanceof Element ? target : target.parentElement
        if (dirtyNode !== null && dirtyNode.isConnected) {
          this.dirtyRoots.add(dirtyNode)
        }
      }

      if (hasRelevant) {
        this.schedule(root)
      }
    })
    // Only content changes: the plugin's own attribute writes are invisible here
    this.observer.observe(root, { childList: true, characterData: true, subtree: true })
  }

  /**
   * Coalesce a burst of mutations into one sweep.
   * @param root - the observed root.
   */
  private schedule(root: HTMLElement): void {
    if (this.options === null) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sweep(root)
    }, SETTLE_MS)
  }

  /**
   * Translate every block that has no current translation.
   *
   * Batches are prioritized: visible viewport blocks are requested first so
   * translations appear immediately, followed by offscreen content. If mutations
   * marked a compact set of dirty roots, only those roots are scanned.
   *
   * @param root - the observed root.
   */
  private async sweep(root: HTMLElement): Promise<void> {
    const options = this.options
    if (options === null) return
    if (this.sweeping) {
      this.rerun = true
      return
    }
    this.sweeping = true
    let controller: AbortController | null = null
    try {
      let found: PendingBlock[] = []
      if (this.dirtyRoots.size > 0 && this.dirtyRoots.size <= 25) {
        const consolidated = consolidateRoots(this.dirtyRoots)
        this.dirtyRoots.clear()
        const seenElements = new Set<HTMLElement>()
        for (const c of consolidated) {
          for (const b of pendingBlocks(c)) {
            if (!seenElements.has(b.element)) {
              seenElements.add(b.element)
              found.push(b)
            }
          }
        }
      } else {
        this.dirtyRoots.clear()
        found = pendingBlocks(root)
      }

      if (found.length === 0) {
        // An idle top-up must not look like "nothing was ever translated": keep
        // the counters, only the in-flight flag changes.
        this.update({ running: false })
        return
      }

      // Prioritize blocks in the viewport over offscreen blocks
      const inViewport: PendingBlock[] = []
      const offscreen: PendingBlock[] = []
      for (const block of found) {
        if (isElementInViewport(block.element)) {
          inViewport.push(block)
        } else {
          offscreen.push(block)
        }
      }
      const prioritized = [...inViewport, ...offscreen]
      const pending = prioritized.map((block, index) => ({ block, key: `p${String(index)}` }))
      const plan = planPage(pending.map(entry => ({ key: entry.key, text: entry.block.text })), options)
      if (plan.batches.length === 0) {
        this.update({ running: false })
        return
      }
      const blockOf = new Map(pending.map(entry => [entry.key, entry.block]))
      const totalBlocks = plan.requestOf.size
      const totalBatches = plan.batches.length
      const activeController = new AbortController()
      controller = activeController
      this.request = activeController
      this.update({
        running: true,
        total: totalBlocks,
        done: 0,
        batchTotal: totalBatches,
        batchDone: 0,
        error: null,
      })

      const pendingText = this.t('pageTranslatingPending')
      const activeText = this.t('pageTranslatingActive')

      // Mark all blocks scheduled for translation with advance placeholder
      for (const key of plan.requestOf.keys()) {
        const block = blockOf.get(key)
        if (block !== undefined) {
          setPlaceholder(block.element, 'pending', pendingText)
        }
      }

      const CONCURRENCY = 2
      let nextBatchIndex = 0
      let completedBlocks = 0
      let completedBatches = 0
      let lastBatchFailure: unknown = null

      const runWorker = async (): Promise<void> => {
        while (nextBatchIndex < plan.batches.length) {
          if (activeController.signal.aborted || !this.state.active) return
          const batchIndex = nextBatchIndex
          nextBatchIndex += 1
          const batch = plan.batches[batchIndex]!

          // Highlight blocks in the active batch with loading status
          for (const item of batch) {
            for (const key of plan.blocksByRequest.get(item.id) ?? []) {
              const block = blockOf.get(key)
              if (block !== undefined) {
                setPlaceholder(block.element, 'active', activeText)
              }
            }
          }

          let answer: Awaited<ReturnType<typeof translate>> | undefined
          try {
            const batchStart = performance.now()
            answer = await translate({ items: batch, targetLanguage: options.targetLanguage }, activeController.signal)
            const batchElapsed = Math.round(performance.now() - batchStart)
            console.log(`[immersive-translate] batch ${batchIndex + 1}/${totalBatches} (${batch.length} items) in ${batchElapsed}ms`)
          } catch (batchFailure) {
            if (activeController.signal.aborted || !this.state.active) return
            for (const item of batch) {
              for (const key of plan.blocksByRequest.get(item.id) ?? []) {
                const block = blockOf.get(key)
                if (block !== undefined) {
                  clearPlaceholder(block.element)
                }
              }
            }
            lastBatchFailure = batchFailure
            completedBatches += 1
            this.update({ batchDone: completedBatches })
            continue
          }

          if (activeController.signal.aborted || !this.state.active) {
            clearPlaceholders(root)
            return
          }

          let applied = 0
          let paintSlice = performance.now()
          for (const result of answer.results) {
            for (const key of plan.blocksByRequest.get(result.id) ?? []) {
              const block = blockOf.get(key)
              if (block === undefined) continue
              applyTranslation(block, result.text)
              applied += 1
              if (performance.now() - paintSlice > 12) {
                await yieldToMain()
                paintSlice = performance.now()
              }
            }
          }

          // Clear any batch blocks that did not receive a translation
          for (const item of batch) {
            for (const key of plan.blocksByRequest.get(item.id) ?? []) {
              const block = blockOf.get(key)
              if (block !== undefined) {
                clearPlaceholder(block.element)
              }
            }
          }

          let batchBlocksCount = 0
          for (const item of batch) {
            batchBlocksCount += (plan.blocksByRequest.get(item.id) ?? []).length
          }
          completedBlocks += batchBlocksCount
          completedBatches += 1

          this.update({
            done: completedBlocks,
            batchDone: completedBatches,
            translated: this.state.translated + applied,
          })
        }
      }

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, plan.batches.length) },
        () => runWorker(),
      )
      await Promise.all(workers)
      if (lastBatchFailure !== null) {
        if (completedBlocks === 0) {
          throw lastBatchFailure
        } else {
          this.update({ running: false, error: failureText(lastBatchFailure) })
          return
        }
      }
      this.update({ running: false })
    } catch (failure) {
      clearPlaceholders(root)
      if (isAbortError(failure, controller?.signal) || !this.state.active) return
      // The translations already applied stay: retrying continues where this
      // sweep stopped, because translated blocks are not requested again.
      this.update({ running: false, active: false, error: failureText(failure) })
      this.disconnect()
    } finally {
      this.sweeping = false
      if (this.request === controller) {
        this.request = null
      }
      if (this.rerun) {
        this.rerun = false
        void this.sweep(root)
      }
    }
  }

  /** Stop observing and remove the stylesheet. */
  private disconnect(): void {
    this.observer?.disconnect()
    this.observer = null
    this.dirtyRoots.clear()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.styles?.()
    this.styles = null
    this.options = null
  }

  /**
   * Replace part of the state and notify, skipping no-op notifications.
   * @param patch - fields to replace.
   */
  private update(patch: Partial<PageState>): void {
    const next: PageState = { ...this.state, ...patch }
    if (next.active === this.state.active && next.running === this.state.running
      && next.done === this.state.done && next.total === this.state.total
      && next.batchDone === this.state.batchDone && next.batchTotal === this.state.batchTotal
      && next.translated === this.state.translated && next.error === this.state.error) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * Whether a thrown error represents deliberate cancellation rather than an engine fault.
 * @param failure - caught rejection.
 * @param signal - optional associated AbortSignal.
 * @returns true if the failure was an abort.
 */
export function isAbortError(failure: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted === true) return true
  if (failure instanceof DOMException && failure.name === 'AbortError') return true
  if (failure instanceof Error && (failure.name === 'AbortError' || failure.message.toLowerCase().includes('abort'))) return true
  return false
}

/**
 * Render a failed sweep for the panel.
 * @param failure - anything thrown by the request.
 * @returns one line naming the code and the Host message.
 */
function failureText(failure: unknown): string {
  if (failure instanceof ApiFailure) return `${failure.code}: ${failure.message}`
  return failure instanceof Error ? failure.message : String(failure)
}
