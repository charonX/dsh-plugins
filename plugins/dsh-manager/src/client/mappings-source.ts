/** Project-mapping config-page state: the mapping list, project options, and errors. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MappingSetInput, MappingView, ProjectRef } from '../mappings/wire-types.ts'
import type { ConnectionView } from '../connections/wire-types.ts'

/** Whole-page snapshot the mappings source publishes. */
export interface MappingsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a read has succeeded; a failed read keeps the last one. */
  readonly mappings?: readonly MappingView[]
  /** The harness projects the picker offers. */
  readonly projects?: readonly ProjectRef[]
  /** The connections the mapping can attach to. */
  readonly connections?: readonly ConnectionView[]
  /** The failure of the last write, rendered as an explicit error. */
  readonly lastError?: string
  /** Set while a write is in flight. */
  readonly busy?: boolean
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface MappingsRemote {
  projectList: () => Promise<{ ok: boolean; value?: { readonly projects: readonly ProjectRef[] }; error?: unknown }>
  mappingList: () => Promise<{ ok: boolean; value?: { readonly mappings: readonly MappingView[] }; error?: unknown }>
  mappingSet: (input: MappingSetInput) => Promise<{ ok: boolean; value?: MappingView; error?: unknown }>
  mappingRemove: (input: { id: string }) => Promise<{ ok: boolean; error?: unknown }>
  connectionList: () => Promise<{ ok: boolean; value?: { readonly connections: readonly ConnectionView[] }; error?: unknown }>
}

/** Props injected through the mappings slots. */
export interface MappingsInjected {
  readonly hooks: { readonly mappings: HostObservable<MappingsSnapshot> }
  /** Create or overwrite one mapping; rejects into lastError on failure. */
  readonly onSet: (input: MappingSetInput) => Promise<MappingView | undefined>
  /** Remove one mapping. */
  readonly onMappingRemove: (id: string) => Promise<void>
  /** Re-read everything after a failure. */
  readonly onMappingsRetry: () => void
}

/** Extract a RemoteError message-ish code for rendering; transport errors fall back. */
function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown }
    if (typeof record.code === 'string') return record.code
    if (typeof record.message === 'string') return record.message
  }
  return 'unknown'
}

/**
 * Create the mappings source: reads fold the project, connection, and
 * mapping lists into one snapshot; writes surface an explicit error text.
 * @param deps - remote reads and the reset event subscription.
 * @returns the injected mappings face.
 */
export function createMappingsSource(deps: {
  projects: MappingsRemote['projectList']
  mappings: MappingsRemote['mappingList']
  connections: MappingsRemote['connectionList']
  set: MappingsRemote['mappingSet']
  remove: MappingsRemote['mappingRemove']
  subscribeReset: (listener: () => void) => () => void
}): MappingsInjected {
  let snapshot: MappingsSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  const publish = (next: MappingsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let mappings: readonly MappingView[] | undefined
    let projects: readonly ProjectRef[] | undefined
    let connections: readonly ConnectionView[] | undefined
    try {
      const [mappingResult, projectResult, connectionResult] = await Promise.all([
        deps.mappings(), deps.projects(), deps.connections(),
      ])
      mappings = mappingResult.ok ? mappingResult.value?.mappings : undefined
      projects = projectResult.ok ? projectResult.value?.projects : undefined
      connections = connectionResult.ok ? connectionResult.value?.connections : undefined
    } catch {
      // any thrown transport failure lands in the error state below
    }
    if (mappings === undefined || projects === undefined || connections === undefined) {
      publish({
        status: 'error',
        ...(snapshot.mappings === undefined ? {} : { mappings: snapshot.mappings }),
        ...(snapshot.projects === undefined ? {} : { projects: snapshot.projects }),
        ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }),
      })
      return
    }
    publish({ status: 'ready', mappings, projects, connections, ...(snapshot.busy === undefined ? {} : { busy: snapshot.busy }) })
  }
  const invalidate = (): void => { void read() }
  return {
    hooks: {
      mappings: {
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
    async onSet(input) {
      const { lastError: _cleared, ...rest } = snapshot
      publish({ ...rest, busy: true })
      try {
        const result = await deps.set(input)
        if (!result.ok) {
          publish({ ...snapshot, busy: false, lastError: errorText(result.error) })
          return undefined
        }
        await read()
        return result.value
      } catch (error) {
        publish({ ...snapshot, busy: false, lastError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onMappingRemove(id) {
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
    onMappingsRetry: invalidate,
  }
}
