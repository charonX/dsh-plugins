/** The crew config state: the roster source and its member form actions. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { AGENT_KINDS } from '../crew/crew-core.ts'
import type { AgentKindOption, AgentKindOptionsInput, CrewInput, CrewMemberView, CrewUpdateInput, ModelProviderOptions } from '../crew/wire-types.ts'

/** Whole-section snapshot the crew source publishes. */
export interface CrewSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a list read has succeeded; a failed read keeps the last one. */
  readonly members?: readonly CrewMemberView[]
  /** The host's own failure message from the last rejected form action; absent after a success. */
  readonly actionError?: string | undefined
  /** Set while a form action (add/update/remove) is in flight. */
  readonly busy?: boolean
}

/** Props injected through the crew slots. */
export interface CrewInjected {
  readonly hooks: { readonly crew: HostObservable<CrewSnapshot> }
  /** Add one member; resolves to the created view or `undefined` on failure. */
  readonly onCrewAdd: (input: CrewInput) => Promise<CrewMemberView | undefined>
  /** Edit one member's facts or enabled flag. */
  readonly onCrewUpdate: (input: CrewUpdateInput) => Promise<CrewMemberView | undefined>
  /** Remove one member from the roster. */
  readonly onCrewRemove: (memberId: string) => Promise<void>
  /** Read the model catalog the member form's dropdowns offer; an empty list reads as free-text fallback. */
  readonly onModelOptions: () => Promise<readonly ModelProviderOptions[]>
  /** Probe locally available execution backends (`builtin`, `claude-code`, `codex`, `agy`). */
  readonly onAgentKindOptions: (refresh?: boolean) => Promise<readonly AgentKindOption[]>
  /** Re-read the roster after a failure. */
  readonly onCrewRetry: () => void
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
 * Create the crew source: the roster follows subscribers, and the form
 * actions fold their outcomes into the snapshot.
 * @param deps - remote reads and writes.
 * @returns the injected crew face.
 */
export function createCrewSource(deps: {
  list: () => Promise<{ ok: boolean; value?: { readonly members: readonly CrewMemberView[] }; error?: unknown }>
  modelOptions?: () => Promise<{ ok: boolean; value?: { readonly providers: readonly ModelProviderOptions[] }; error?: unknown }>
  agentKindOptions?: (input?: AgentKindOptionsInput) => Promise<{ ok: boolean; value?: { readonly kinds: readonly AgentKindOption[] }; error?: unknown }>
  add: (input: CrewInput) => Promise<{ ok: boolean; value?: { readonly member: CrewMemberView }; error?: unknown }>
  update: (input: CrewUpdateInput) => Promise<{ ok: boolean; value?: { readonly member: CrewMemberView }; error?: unknown }>
  remove: (memberId: string) => Promise<{ ok: boolean; error?: unknown }>
  subscribeReset?: (listener: () => void) => () => void
}): CrewInjected & { readonly invalidate: () => void } {
  let snapshot: CrewSnapshot = { status: 'loading' }
  let optionsCache: readonly ModelProviderOptions[] | undefined
  let kindOptionsCache: readonly AgentKindOption[] | undefined
  let disposeReset: (() => void) | undefined
  const fallbackKinds: readonly AgentKindOption[] = AGENT_KINDS.map(kind => ({
    kind,
    command: kind === 'claude-code' ? 'claude' : kind === 'builtin' ? '' : kind,
    available: kind === 'builtin',
  }))
  const listeners = new Set<() => void>()
  const publish = (next: CrewSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let members: readonly CrewMemberView[] | undefined
    try {
      const result = await deps.list()
      members = result.ok ? result.value?.members : undefined
    } catch {
      members = undefined
    }
    if (members === undefined) {
      publish({ status: 'error', ...(snapshot.members === undefined ? {} : { members: snapshot.members }) })
      return
    }
    publish({ status: 'ready', members })
  }
  const refresh = (): Promise<void> => read()
  const invalidate = (): void => {
    if (listeners.size > 0) void refresh()
  }
  return {
    invalidate,
    hooks: {
      crew: {
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
    async onCrewAdd(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.add(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.member
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onCrewUpdate(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.update(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.member
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onCrewRemove(memberId) {
      publish({ ...snapshot, busy: true })
      try {
        await deps.remove(memberId)
        await refresh()
      } catch {
        // The card stays; the failure shows through a re-read error state.
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    onCrewRetry: () => { void refresh() },
    async onModelOptions() {
      if (optionsCache !== undefined) return optionsCache
      if (deps.modelOptions === undefined) return []
      try {
        const result = await deps.modelOptions()
        optionsCache = result.ok ? result.value?.providers ?? [] : []
      } catch {
        optionsCache = []
      }
      return optionsCache
    },
    async onAgentKindOptions(refresh) {
      if (refresh !== true && kindOptionsCache !== undefined) return kindOptionsCache
      if (deps.agentKindOptions === undefined) return fallbackKinds
      try {
        const result = await deps.agentKindOptions(refresh === true ? { refresh: true } : undefined)
        kindOptionsCache = result.ok && result.value?.kinds !== undefined ? result.value.kinds : fallbackKinds
      } catch {
        kindOptionsCache = fallbackKinds
      }
      return kindOptionsCache
    },
  }
}
