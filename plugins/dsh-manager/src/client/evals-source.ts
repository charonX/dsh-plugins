/** Eval-records page state: the joined eval rows, connections, and filters. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionView } from '../connections/wire-types.ts'
import type { DecisionAction, EvalListInput, EvalRecordView } from '../evals/wire-types.ts'

/** Whole-page snapshot the eval records source publishes. */
export interface EvalsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** The eval records matching the filters, newest first. */
  readonly evals?: readonly EvalRecordView[]
  /** The connections behind the source filter. */
  readonly connections?: readonly ConnectionView[]
  /** The active decision-type filter. */
  readonly action?: DecisionAction
  /** The active source filter. */
  readonly connectionId?: string
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface EvalsRemote {
  evalList: (input: EvalListInput) => Promise<{ ok: boolean; value?: { readonly evals: readonly EvalRecordView[] }; error?: unknown }>
  connectionList: () => Promise<{ ok: boolean; value?: { readonly connections: readonly ConnectionView[] }; error?: unknown }>
}

/** Props injected through the eval-records slots. */
export interface EvalsInjected {
  readonly hooks: { readonly evals: HostObservable<EvalsSnapshot> }
  /** Change one filter (pass `undefined` to clear it) and re-read. */
  readonly onEvalFilter: (input: EvalListInput) => void
  /** Re-read everything after a failure. */
  readonly onEvalsRetry: () => void
}

/**
 * Create the eval records source: reads fold the filtered eval list and the
 * connections into one snapshot; the filters live in the source so every
 * re-read (poll, reset, retry) carries them.
 * @param deps - remote reads, the reset event subscription, and poll cadence.
 * @returns the injected eval-records face.
 */
export function createEvalsSource(deps: {
  list: EvalsRemote['evalList']
  connections: EvalsRemote['connectionList']
  subscribeReset: (listener: () => void) => () => void
  pollMs?: number
}): EvalsInjected {
  let snapshot: EvalsSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  let epoch = 0
  let action: DecisionAction | undefined
  let connectionId: string | undefined
  const publish = (next: EvalsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (current: number): Promise<void> => {
    let evals: readonly EvalRecordView[] | undefined
    let connections: readonly ConnectionView[] | undefined
    try {
      const [listResult, connectionResult] = await Promise.all([
        deps.list({ ...(action === undefined ? {} : { action }), ...(connectionId === undefined ? {} : { connectionId }) }),
        deps.connections(),
      ])
      evals = listResult.ok ? listResult.value?.evals : undefined
      connections = connectionResult.ok ? connectionResult.value?.connections : undefined
    } catch {
      // any thrown transport failure lands in the error state below
    }
    if (current !== epoch) return
    if (evals === undefined || connections === undefined) {
      publish({
        status: 'error',
        ...(snapshot.evals === undefined ? {} : { evals: snapshot.evals }),
        ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }),
        ...(action === undefined ? {} : { action }),
        ...(connectionId === undefined ? {} : { connectionId }),
      })
      return
    }
    publish({
      status: 'ready',
      evals,
      connections,
      ...(action === undefined ? {} : { action }),
      ...(connectionId === undefined ? {} : { connectionId }),
    })
  }
  const refresh = (): Promise<void> => read(++epoch)
  const invalidate = (): void => { void refresh() }
  return {
    hooks: {
      evals: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            const handles: (() => void)[] = [deps.subscribeReset(invalidate)]
            if (deps.pollMs !== undefined && deps.pollMs > 0) {
              const timer = setInterval(invalidate, deps.pollMs)
              handles.push(() => { clearInterval(timer) })
            }
            disposers = handles
            invalidate()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
            epoch++
          }
        },
      },
    },
    onEvalFilter(input) {
      action = input.action
      connectionId = input.connectionId
      invalidate()
    },
    onEvalsRetry: () => { void refresh() },
  }
}
