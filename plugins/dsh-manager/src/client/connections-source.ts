/** Connections config-page state: the list source, form actions, and test results. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionAddInput, ConnectionUpdateInput, ConnectionView } from '../connections/wire-types.ts'
import type { ConnectivityResult } from '../connections/wire-types.ts'

/** Whole-page snapshot the connections source publishes. */export interface ConnectionsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a list read has succeeded; a failed read keeps the last one. */
  readonly connections?: readonly ConnectionView[]
  /** The most recent connectivity test, keyed by connection id. */
  readonly lastTest?: { readonly id: string; readonly result: ConnectivityResult }
  /** The host's own failure message from the last rejected form action; absent after a success. */
  readonly actionError?: string | undefined
  /** Set while a form action (add/remove/test) is in flight. */
  readonly busy?: boolean
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface ConnectionsRemote {
  connectionList: () => Promise<{ ok: boolean; value?: { readonly connections: readonly ConnectionView[] }; error?: unknown }>
  connectionAdd: (input: ConnectionAddInput) => Promise<{ ok: boolean; value?: ConnectionView; error?: unknown }>
  connectionUpdate: (input: ConnectionUpdateInput) => Promise<{ ok: boolean; value?: ConnectionView; error?: unknown }>
  connectionTest: (id: string) => Promise<{ ok: boolean; value?: ConnectivityResult; error?: unknown }>
  connectionRemove: (id: string) => Promise<{ ok: boolean; error?: unknown }>
  connectionDeleteInfo: (id: string) => Promise<{ ok: boolean; value?: { sources: number; mappings: number }; error?: unknown }>
}

/** Props injected through the connections slots. */
export interface ConnectionsInjected {
  readonly hooks: { readonly connections: HostObservable<ConnectionsSnapshot> }
  /** Add one connection; resolves to the created view or `undefined` on failure. */
  readonly onAdd: (input: ConnectionAddInput) => Promise<ConnectionView | undefined>
  /** Edit one connection's facts, credential, or enabled flag. */
  readonly onUpdate: (input: ConnectionUpdateInput) => Promise<ConnectionView | undefined>
  /** Run a connectivity test; the result lands in the snapshot's lastTest. */
  readonly onTest: (id: string) => Promise<ConnectivityResult | undefined>
  /** How many Source instances and mappings a removal would affect. */
  readonly onDeleteInfo: (id: string) => Promise<{ sources: number; mappings: number }>
  /** Remove one connection. */
  readonly onConnectionRemove: (id: string) => Promise<void>
  /** Re-read the list after a failure. */
  readonly onConnectionsRetry: () => void
}

/** Extract the host's failure message for rendering; transport errors fall back to their string form. */
function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.code === 'string') return record.code
  }
  return String(error)
}

/**
 * Create the connections source: the list follows subscribers, actions fold
 * their outcomes into the snapshot, and connection resets re-read.
 * @param deps - remote reads and the reset event subscription.
 * @returns the injected connections face.
 */
export function createConnectionsSource(deps: {
  list: () => Promise<{ ok: boolean; value?: { readonly connections: readonly ConnectionView[] }; error?: unknown }>
  add: ConnectionsRemote['connectionAdd']
  update: ConnectionsRemote['connectionUpdate']
  test: ConnectionsRemote['connectionTest']
  remove: ConnectionsRemote['connectionRemove']
  deleteInfo: ConnectionsRemote['connectionDeleteInfo']
  subscribeReset: (listener: () => void) => () => void
}): ConnectionsInjected {
  let snapshot: ConnectionsSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  const publish = (next: ConnectionsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let connections: readonly ConnectionView[] | undefined
    try {
      const result = await deps.list()
      connections = result.ok ? result.value?.connections : undefined
    } catch {
      connections = undefined
    }
    if (connections === undefined) {
      publish({ status: 'error', ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }) })
      return
    }
    publish({ status: 'ready', connections, ...(snapshot.lastTest === undefined ? {} : { lastTest: snapshot.lastTest }) })
  }
  const refresh = (): Promise<void> => read()
  const invalidate = (): void => { void refresh() }
  return {
    hooks: {
      connections: {
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
    async onAdd(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.add(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onUpdate(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.update(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onDeleteInfo(id) {
      try {
        const result = await deps.deleteInfo(id)
        return result.ok && result.value !== undefined ? result.value : { sources: 0, mappings: 0 }
      } catch {
        return { sources: 0, mappings: 0 }
      }
    },
    async onTest(id) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.test(id)
        const verdict = result.ok ? result.value : undefined
        if (verdict !== undefined) {
          publish({ ...snapshot, lastTest: { id, result: verdict } })
        }
        return verdict
      } catch {
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onConnectionRemove(id) {
      publish({ ...snapshot, busy: true })
      try {
        await deps.remove(id)
        await refresh()
      } catch {
        // The card stays; the failure shows through a re-read error state.
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    onConnectionsRetry: invalidate,
  }
}
