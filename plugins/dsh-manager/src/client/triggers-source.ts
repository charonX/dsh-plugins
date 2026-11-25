/** Sources-and-triggers config-page state: sources, threads, and poll outcomes. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { PollOutcome, SourceAddInput, SourceUpdateInput, SourceView, ThreadView } from '../sources/wire-types.ts'
import type { ConnectionView } from '../connections/wire-types.ts'

/** Whole-page snapshot the triggers source publishes. */
export interface TriggersSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** The Source instances. */
  readonly sources?: readonly SourceView[]
  /** The connections a new Source can attach to. */
  readonly connections?: readonly ConnectionView[]
  /** The threads, most recently updated first. */
  readonly threads?: readonly ThreadView[]
  /** The triggers of the expanded thread, keyed by thread id. */
  readonly expanded?: { readonly threadId: string; readonly triggers: readonly { id: string; url: string; occurredAt?: number; collectedAt: number }[] }
  /** The outcome of the last poll button press. */
  readonly lastPoll?: PollOutcome & { readonly sourceId: string }
  /** Set while a write or poll is in flight. */
  readonly busy?: boolean
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface TriggersRemote {
  sourceList: () => Promise<{ ok: boolean; value?: { readonly sources: readonly SourceView[] }; error?: unknown }>
  sourceAdd: (input: SourceAddInput) => Promise<{ ok: boolean; value?: SourceView; error?: unknown }>
  sourceUpdate: (input: SourceUpdateInput) => Promise<{ ok: boolean; value?: SourceView; error?: unknown }>
  sourcePoll: (input: { id: string }) => Promise<{ ok: boolean; value?: PollOutcome; error?: unknown }>
  sourceRemove: (input: { id: string }) => Promise<{ ok: boolean; error?: unknown }>
  threadList: () => Promise<{ ok: boolean; value?: { readonly threads: readonly ThreadView[] }; error?: unknown }>
  triggerList: (input: { threadId: string }) => Promise<{ ok: boolean; value?: { readonly triggers: readonly { id: string; url: string; occurredAt?: number; collectedAt: number }[] }; error?: unknown }>
  connectionList: () => Promise<{ ok: boolean; value?: { readonly connections: readonly ConnectionView[] }; error?: unknown }>
}

/** Props injected through the triggers slots. */
export interface TriggersInjected {
  readonly hooks: { readonly triggers: HostObservable<TriggersSnapshot> }
  /** Add one Source instance; resolves to the created view or `undefined`. */
  readonly onAddSource: (input: SourceAddInput) => Promise<SourceView | undefined>
  /** Edit one Source instance. */
  readonly onUpdateSource: (input: SourceUpdateInput) => Promise<SourceView | undefined>
  /** Poll one Source instance immediately. */
  readonly onPoll: (id: string) => Promise<PollOutcome | undefined>
  /** Remove one Source instance. */
  readonly onRemoveSource: (id: string) => Promise<void>
  /** Expand one thread to show its triggers. */
  readonly onExpand: (threadId: string) => Promise<void>
  /** Collapse the expanded thread. */
  readonly onCollapse: () => void
  /** Re-read everything after a failure. */
  readonly onTriggersRetry: () => void
}

/**
 * Create the triggers source: reads fold sources, connections, and threads
 * into one snapshot; polls fold their outcome beside the source.
 * @param deps - remote reads and the reset event subscription.
 * @returns the injected triggers face.
 */
export function createTriggersSource(deps: {
  sources: TriggersRemote['sourceList']
  connections: TriggersRemote['connectionList']
  threads: TriggersRemote['threadList']
  add: TriggersRemote['sourceAdd']
  update: TriggersRemote['sourceUpdate']
  poll: TriggersRemote['sourcePoll']
  remove: TriggersRemote['sourceRemove']
  triggersOf: TriggersRemote['triggerList']
  subscribeReset: (listener: () => void) => () => void
}): TriggersInjected {
  let snapshot: TriggersSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  const publish = (next: TriggersSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let sources: readonly SourceView[] | undefined
    let connections: readonly ConnectionView[] | undefined
    let threads: readonly ThreadView[] | undefined
    try {
      const [sourceResult, connectionResult, threadResult] = await Promise.all([
        deps.sources(), deps.connections(), deps.threads(),
      ])
      sources = sourceResult.ok ? sourceResult.value?.sources : undefined
      connections = connectionResult.ok ? connectionResult.value?.connections : undefined
      threads = threadResult.ok ? threadResult.value?.threads : undefined
    } catch {
      // any thrown transport failure lands in the error state below
    }
    if (sources === undefined || connections === undefined || threads === undefined) {
      publish({
        status: 'error',
        ...(snapshot.sources === undefined ? {} : { sources: snapshot.sources }),
        ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }),
        ...(snapshot.threads === undefined ? {} : { threads: snapshot.threads }),
      })
      return
    }
    publish({ status: 'ready', sources, connections, threads, ...(snapshot.busy === undefined ? {} : { busy: snapshot.busy }) })
  }
  const invalidate = (): void => { void read() }
  return {
    hooks: {
      triggers: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposers = [deps.subscribeReset(invalidate)]
            invalidate()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
          }
        },
      },
    },
    async onAddSource(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.add(input)
        if (!result.ok || result.value === undefined) return undefined
        await read()
        return result.value
      } catch {
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onUpdateSource(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.update(input)
        if (!result.ok || result.value === undefined) return undefined
        await read()
        return result.value
      } catch {
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onPoll(id) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.poll({ id })
        const outcome = result.ok ? result.value : undefined
        await read()
        if (outcome !== undefined) {
          publish({ ...snapshot, lastPoll: { ...outcome, sourceId: id } })
        }
        return outcome
      } catch {
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onRemoveSource(id) {
      publish({ ...snapshot, busy: true })
      try {
        await deps.remove({ id })
        await read()
      } catch {
        // The row stays; a re-read error surfaces through the status.
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onExpand(threadId) {
      try {
        const result = await deps.triggersOf({ threadId })
        if (!result.ok || result.value === undefined) return
        publish({ ...snapshot, expanded: { threadId, triggers: result.value.triggers } })
      } catch {
        // The expansion simply does not open.
      }
    },
    onCollapse: () => {
      const { expanded: _collapsed, ...rest } = snapshot
      publish({ ...rest })
    },
    onTriggersRetry: invalidate,
  }
}
