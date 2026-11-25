/**
 * Per-session client model catalog filter:
 * ensures `ModelSelect` (`conversation.input.model`) and `/model` only list models
 * belonging to the session's bound Agent (`native` hides `ext-*` providers; an
 * external agent shows only its own `ext-<agentId>` provider group).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { agentIdFromPreset, type SessionAgentId } from '../types.ts'
import { filterModelDirectoryState } from './model-filter-core.ts'

export { filterModelDirectoryState }

export interface SessionAgentRegistry {
  set(sessionId: string, agentId: SessionAgentId): void
  get(sessionId: string): SessionAgentId
  notify(sessionId: string): void
  subscribe(sessionId: string, listener: () => void): () => void
  ensureFiltered(sessionId: string): void
}

export function installSessionModelFilter(ctx: ClientContext): {
  readonly registry: SessionAgentRegistry
  readonly dispose: () => void
} {
  const explicitAgents = new Map<string, SessionAgentId>()
  const sessionListeners = new Map<string, Set<() => void>>()
  const patchedDirectories = new WeakSet<ModelDirectory>()
  const restoreCallbacks: Array<() => void> = []

  const resolveAgentForSession = (sessionId: string): SessionAgentId => {
    const explicit = explicitAgents.get(sessionId)
    if (explicit !== undefined) return explicit
    const binding = ctx.get('sessions')?.binding(sessionId as SessionId)
    const presetVal = binding?.session.projections.faceOf('agentPreset')?.getSnapshot()
    const fromPreset = agentIdFromPreset(typeof presetVal === 'string' ? presetVal : undefined)
    if (fromPreset !== undefined) return fromPreset
    return 'native'
  }

  const notify = (sessionId: string): void => {
    const listeners = sessionListeners.get(sessionId)
    if (listeners === undefined) return
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // Ignore subscriber errors during reactive notifications.
      }
    }
  }

  const wrapDirectory = (directory: ModelDirectory, sessionId: string): ModelDirectory => {
    if (patchedDirectories.has(directory)) return directory
    patchedDirectories.add(directory)

    const store = directory.store
    const origGetSnapshot = store.getSnapshot.bind(store)
    const origSubscribe = store.subscribe.bind(store)
    const origLoad = directory.load.bind(directory)

    let cachedRaw: ModelDirectoryState | undefined
    let cachedAgent: SessionAgentId | undefined
    let cachedFiltered: ModelDirectoryState | undefined

    store.getSnapshot = (): ModelDirectoryState => {
      const raw = origGetSnapshot()
      const agentId = resolveAgentForSession(sessionId)
      if (cachedRaw === raw && cachedAgent === agentId && cachedFiltered !== undefined) {
        return cachedFiltered
      }
      const next = filterModelDirectoryState(raw, agentId)
      cachedRaw = raw
      cachedAgent = agentId
      cachedFiltered = next
      return next
    }

    store.subscribe = (listener: () => void): (() => void) => {
      const unsubRaw = origSubscribe(listener)
      let set = sessionListeners.get(sessionId)
      if (set === undefined) {
        set = new Set()
        sessionListeners.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        unsubRaw()
        const currentSet = sessionListeners.get(sessionId)
        if (currentSet !== undefined) {
          currentSet.delete(listener)
          if (currentSet.size === 0) sessionListeners.delete(sessionId)
        }
      }
    }

    directory.load = async (): Promise<ModelDirectoryState> => {
      await origLoad()
      return store.getSnapshot()
    }

    restoreCallbacks.push(() => {
      store.getSnapshot = origGetSnapshot
      store.subscribe = origSubscribe
      directory.load = origLoad
    })

    // Trigger immediate re-read for any already-mounted ModelSelect subscription.
    notify(sessionId)
    return directory
  }

  const resolverScope = ctx.inject(['modelDirectories'], (scope) => {
    const resolver = scope.modelDirectories
    const origDirectoryFor = resolver.directoryFor.bind(resolver)
    resolver.directoryFor = (sessionId: SessionId): ModelDirectory => {
      const dir = origDirectoryFor(sessionId)
      return wrapDirectory(dir, String(sessionId))
    }
    scope.effect(() => () => {
      resolver.directoryFor = origDirectoryFor
    }, 'external-agents: restore modelDirectories.directoryFor')
  })

  const ensureFiltered = (sessionId: string): void => {
    const resolver = ctx.get('modelDirectories')
    if (resolver === undefined) return
    try {
      const dir = resolver.directoryFor(sessionId as SessionId)
      wrapDirectory(dir, sessionId)
    } catch {
      // Session scope may not be mounted yet; directoryFor will wrap lazily on creation.
    }
  }

  const registry: SessionAgentRegistry = {
    set(sessionId, agentId) {
      if (explicitAgents.get(sessionId) === agentId) return
      explicitAgents.set(sessionId, agentId)
      ensureFiltered(sessionId)
      notify(sessionId)
    },
    get: resolveAgentForSession,
    notify,
    subscribe(sessionId, listener) {
      let set = sessionListeners.get(sessionId)
      if (set === undefined) {
        set = new Set()
        sessionListeners.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        const currentSet = sessionListeners.get(sessionId)
        if (currentSet !== undefined) {
          currentSet.delete(listener)
          if (currentSet.size === 0) sessionListeners.delete(sessionId)
        }
      }
    },
    ensureFiltered,
  }

  return {
    registry,
    dispose: () => {
      resolverScope.dispose()
      for (const restore of restoreCallbacks.splice(0)) restore()
      sessionListeners.clear()
      explicitAgents.clear()
    },
  }
}
