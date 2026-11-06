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
  clearTranslations,
  installPageStyles,
  pageRoot,
  pendingBlocks,
} from './pageDom.ts'
import { planPage, type PageLimits } from '../shared/page.ts'

/** Observable state of page translation. */
export interface PageState {
  /** Whether the page is currently translated (and will stay topped up). */
  readonly active: boolean
  /** Whether a sweep is in flight right now. */
  readonly running: boolean
  /** Batches finished in the current sweep. */
  readonly done: number
  /** Batches the current (or last) sweep planned. */
  readonly total: number
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
const IDLE: PageState = { active: false, running: false, done: 0, total: 0, translated: 0, error: null }

/** Coalescing window for DOM mutations, in milliseconds. */
const SETTLE_MS = 300

/** Page translation kept out of React: DOM attributes plus a stylesheet. */
export class PageTranslator {
  private state: PageState = IDLE
  private options: PageStartOptions | null = null
  private readonly listeners = new Set<() => void>()
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
    this.observer = new MutationObserver(() => { this.schedule(root) })
    // Only content changes: the plugin's own attribute writes are invisible here,
    // which is what keeps a sweep from re-triggering itself.
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
   * Batches are sent one at a time: a page costs many requests, and serializing
   * them keeps a slow route from opening a burst of concurrent streams. A sweep
   * requested while one is running is collapsed into a single follow-up, which is
   * what a streaming answer produces.
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
    try {
      const found = pendingBlocks(root)
      if (found.length === 0) {
        // An idle top-up must not look like "nothing was ever translated": keep
        // the counters, only the in-flight flag changes.
        this.update({ running: false })
        return
      }
      const pending = found.map((block, index) => ({ block, key: `p${String(index)}` }))
      const plan = planPage(pending.map(entry => ({ key: entry.key, text: entry.block.text })), options)
      const blockOf = new Map(pending.map(entry => [entry.key, entry.block]))
      const controller = new AbortController()
      this.request = controller
      this.update({ running: true, total: plan.batches.length, done: 0, error: null })
      for (const batch of plan.batches) {
        if (controller.signal.aborted) return
        const answer = await translate({ items: batch, targetLanguage: options.targetLanguage }, controller.signal)
        let applied = 0
        for (const result of answer.results) {
          for (const key of plan.blocksByRequest.get(result.id) ?? []) {
            const block = blockOf.get(key)
            if (block === undefined) continue
            applyTranslation(block, result.text)
            applied += 1
          }
        }
        this.update({ done: this.state.done + 1, translated: this.state.translated + applied })
      }
      this.update({ running: false })
    } catch (failure) {
      if (this.request?.signal.aborted === true) return
      // The translations already applied stay: retrying continues where this
      // sweep stopped, because translated blocks are not requested again.
      this.update({ running: false, active: false, error: failureText(failure) })
      this.disconnect()
    } finally {
      this.sweeping = false
      this.request = null
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
      && next.translated === this.state.translated && next.error === this.state.error) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
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
