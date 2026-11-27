/** The steward status feed: the polled busy/backlog/mode snapshot and the activity ring. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { StewardPromptView, StewardStatusView } from '../evals/wire-types.ts'

/** The steward status snapshot the source publishes; a failed read keeps the error state. */
export interface StewardSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly steward?: StewardStatusView
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface StewardDependencies {
  readonly status: () => Promise<{ ok: boolean; value?: StewardStatusView; error?: unknown }>
  readonly readPrompt?: (promptId: string) => Promise<{ ok: boolean; value?: { readonly prompt?: StewardPromptView } | undefined }>
  /** Poll cadence in millis; 0 disables. */
  readonly pollMs?: number
}

/** Props injected through the steward slot. */
export interface StewardInjected {
  readonly hooks: { readonly steward: HostObservable<StewardSnapshot> }
  /** Re-read the status after a failure. */
  readonly onStewardRetry: () => void
  /** Load the rendered turn prompt for a recent activity entry. */
  readonly onStewardPrompt?: (promptId: string) => Promise<StewardPromptView | undefined>
}

/**
 * Create the steward status source: the host status polls on a cadence and a
 * failed read flips the snapshot to the error state.
 * @param deps - the remote read and the poll cadence.
 * @returns the injected steward face.
 */
export function createStewardSource(deps: StewardDependencies): StewardInjected {
  let snapshot: StewardSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  const publish = (next: StewardSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let steward: StewardStatusView | undefined
    try {
      const result = await deps.status()
      steward = result.ok ? result.value : undefined
    } catch {
      steward = undefined
    }
    if (steward === undefined) {
      publish({ status: 'error' })
      return
    }
    publish({ status: 'ready', steward })
  }
  const subscribe = (): void => {
    const handles: (() => void)[] = []
    if (deps.pollMs !== undefined && deps.pollMs > 0) {
      const timer = setInterval(() => { void read() }, deps.pollMs)
      handles.push(() => { clearInterval(timer) })
    }
    disposers = handles
    void read()
  }
  return {
    hooks: {
      steward: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) subscribe()
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
          }
        },
      },
    },
    onStewardRetry: () => { void read() },
    ...(deps.readPrompt === undefined ? {} : {
      onStewardPrompt: async (promptId: string): Promise<StewardPromptView | undefined> => {
        const result = await deps.readPrompt!(promptId)
        return result.ok ? result.value?.prompt : undefined
      },
    }),
  }
}
