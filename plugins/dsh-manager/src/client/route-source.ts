/** The route-rule config state: the list source and its rule form actions. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RouteInput, RouteRuleView, RouteUpdateInput } from '../route/wire-types.ts'

/** Whole-section snapshot the route source publishes. */
export interface RouteSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a list read has succeeded; a failed read keeps the last one. */
  readonly rules?: readonly RouteRuleView[]
  /** The host's own failure message from the last rejected form action; absent after a success. */
  readonly actionError?: string | undefined
  /** Set while a form action (add/update/remove) is in flight. */
  readonly busy?: boolean
}

/** Props injected through the route slots. */
export interface RouteInjected {
  readonly hooks: { readonly route: HostObservable<RouteSnapshot> }
  /** Add one rule; resolves to the created view or `undefined` on failure. */
  readonly onRuleAdd: (input: RouteInput) => Promise<RouteRuleView | undefined>
  /** Edit one rule's facts or enabled flag. */
  readonly onRuleUpdate: (input: RouteUpdateInput) => Promise<RouteRuleView | undefined>
  /** Remove one rule. */
  readonly onRuleRemove: (ruleId: string) => Promise<void>
  /** Which rules reference a pipeline, as condition strings. */
  readonly onRuleReferencesOfPipeline: (pipelineId: string) => Promise<readonly string[]>
  /** Re-read the list after a failure. */
  readonly onRouteRetry: () => void
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
 * Create the route source: the list follows subscribers, and the form
 * actions fold their outcomes into the snapshot.
 * @param deps - remote reads and writes.
 * @returns the injected route face.
 */
export function createRouteSource(deps: {
  list: () => Promise<{ ok: boolean; value?: { readonly rules: readonly RouteRuleView[] }; error?: unknown }>
  add: (input: RouteInput) => Promise<{ ok: boolean; value?: { readonly rule: RouteRuleView }; error?: unknown }>
  update: (input: RouteUpdateInput) => Promise<{ ok: boolean; value?: { readonly rule: RouteRuleView }; error?: unknown }>
  remove: (ruleId: string) => Promise<{ ok: boolean; error?: unknown }>
  referencesOfPipeline: (pipelineId: string) => Promise<{ ok: boolean; value?: { readonly rules: readonly string[] }; error?: unknown }>
  subscribeReset?: (listener: () => void) => () => void
}): RouteInjected & { readonly invalidate: () => void } {
  let snapshot: RouteSnapshot = { status: 'loading' }
  let disposeReset: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: RouteSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let rules: readonly RouteRuleView[] | undefined
    try {
      const result = await deps.list()
      rules = result.ok ? result.value?.rules : undefined
    } catch {
      rules = undefined
    }
    if (rules === undefined) {
      publish({ status: 'error', ...(snapshot.rules === undefined ? {} : { rules: snapshot.rules }) })
      return
    }
    publish({ status: 'ready', rules })
  }
  const refresh = (): Promise<void> => read()
  const invalidate = (): void => {
    if (listeners.size > 0) void refresh()
  }
  return {
    invalidate,
    hooks: {
      route: {
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
    async onRuleAdd(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.add(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.rule
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onRuleUpdate(input) {
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.update(input)
        if (!result.ok || result.value === undefined) {
          publish({ ...snapshot, actionError: errorText(result.error) })
          return undefined
        }
        await refresh()
        publish({ ...snapshot, actionError: undefined })
        return result.value.rule
      } catch (error) {
        publish({ ...snapshot, actionError: errorText(error) })
        return undefined
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onRuleRemove(ruleId) {
      publish({ ...snapshot, busy: true })
      try {
        await deps.remove(ruleId)
        await refresh()
      } catch {
        // The card stays; the failure shows through a re-read error state.
      } finally {
        publish({ ...snapshot, busy: false })
      }
    },
    async onRuleReferencesOfPipeline(pipelineId) {
      try {
        const result = await deps.referencesOfPipeline(pipelineId)
        return result.ok && result.value !== undefined ? result.value.rules : []
      } catch {
        return []
      }
    },
    onRouteRetry: () => { void refresh() },
  }
}
