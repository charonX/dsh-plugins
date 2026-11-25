/** The pipeline config state: the list source and its pipeline form actions. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { PipelineInput, PipelineUpdateInput, PipelineView } from '../pipeline/wire-types.ts'

/** Whole-section snapshot the pipeline source publishes. */
export interface PipelineSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a list read has succeeded; a failed read keeps the last one. */
  readonly pipelines?: readonly PipelineView[]
  /** The host's own failure message from the last rejected form action; absent after a success. */
  readonly actionError?: string | undefined
  /** Set while a form action (add/update/remove) is in flight. */
  readonly busy?: boolean
}

/** Props injected through the pipeline slots. */
export interface PipelineInjected {
  readonly hooks: { readonly pipeline: HostObservable<PipelineSnapshot> }
  /** Add one pipeline; resolves to the created view or `undefined` on failure. */
  readonly onPipelineAdd: (input: PipelineInput) => Promise<PipelineView | undefined>
  /** Edit one pipeline's name or stages. */
  readonly onPipelineUpdate: (input: PipelineUpdateInput) => Promise<PipelineView | undefined>
  /** Remove one pipeline. */
  readonly onPipelineRemove: (pipelineId: string) => Promise<void>
  /** Which pipelines reference a crew member, as `name (stage N)` strings. */
  readonly onPipelineReferencesOf: (memberId: string) => Promise<readonly string[]>
  /** Re-read the list after a failure. */
  readonly onPipelineRetry: () => void
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
 * Create the pipeline source: the list follows subscribers, and the form
 * actions fold their outcomes into the snapshot.
 * @param deps - remote reads and writes.
 * @returns the injected pipeline face.
 */
export function createPipelineSource(deps: {
  list: () => Promise<{ ok: boolean; value?: { readonly pipelines: readonly PipelineView[] }; error?: unknown }>
  add: (input: PipelineInput) => Promise<{ ok: boolean; value?: { readonly pipeline: PipelineView }; error?: unknown }>
  update: (input: PipelineUpdateInput) => Promise<{ ok: boolean; value?: { readonly pipeline: PipelineView }; error?: unknown }>
  remove: (pipelineId: string) => Promise<{ ok: boolean; error?: unknown }>
  referencesOf: (memberId: string) => Promise<{ ok: boolean; value?: { readonly references: readonly string[] }; error?: unknown }>
  subscribeReset?: (listener: () => void) => () => void
}): PipelineInjected & { readonly invalidate: () => void } {
  let snapshot: PipelineSnapshot = { status: 'loading' }
  let disposeReset: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: PipelineSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let pipelines: readonly PipelineView[] | undefined
    try {
      const result = await deps.list()
      pipelines = result.ok ? result.value?.pipelines : undefined
    } catch {
      pipelines = undefined
    }
    if (pipelines === undefined) {
      publish({ status: 'error', ...(snapshot.pipelines === undefined ? {} : { pipelines: snapshot.pipelines }) })
      return
    }
    publish({ status: 'ready', pipelines })
  }
  const refresh = (): Promise<void> => read()
  const invalidate = (): void => {
    if (listeners.size > 0) void refresh()
  }
  return {
    invalidate,
    hooks: {
      pipeline: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposeReset = deps.subscribeReset?.(invalidate)
            void refresh()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) {
              disposeReset?.()
              disposeReset = undefined
            }
          }
        },
      },
    },
    async onPipelineAdd(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.add(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.pipeline
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onPipelineUpdate(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.update(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.pipeline
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onPipelineRemove(pipelineId) {
      publish({ ...snapshot, busy: true })
      try {
        await deps.remove(pipelineId)
        await refresh()
      } catch {
        // The card stays; the failure shows through a re-read error state.
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    onPipelineRetry: () => { void refresh() },
    async onPipelineReferencesOf(memberId) {
      try {
        const result = await deps.referencesOf(memberId)
        return result.ok && result.value !== undefined ? result.value.references : []
      } catch {
        return []
      }
    },
  }
}
