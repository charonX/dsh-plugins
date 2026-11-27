/**
 * Shared client-side reactive registry for per-session agent state and catalog
 * snapshots so AgentSwitcher, ModelGate, PermissionGate, and slash commands
 * stay synchronized without patching host ModelDirectory stores.
 */
import type {
  AgentDescriptor,
  ExternalAgentId,
  ExternalAgentsConfigSnapshot,
  SelectSessionModelInput,
  SessionAgentId,
  SessionAgentState,
} from '../types.ts'

export interface ExternalAgentsClientApi {
  readonly getCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly refreshQuota: (agentId?: ExternalAgentId) => Promise<readonly AgentDescriptor[]>
  readonly getConfig: () => Promise<ExternalAgentsConfigSnapshot>
  readonly updateConfig: (input: {
    readonly defaultAgent?: SessionAgentId
    readonly agentId?: ExternalAgentId
    readonly settings?: {
      readonly defaultModel?: string
      readonly defaultReasoningEffort?: string
      readonly customModels?: readonly { readonly id: string; readonly name: string }[]
    }
  }) => Promise<ExternalAgentsConfigSnapshot>
  readonly getSessionState: (sessionId: string) => Promise<SessionAgentState>
  readonly selectSessionAgent: (sessionId: string, agentId: SessionAgentId) => Promise<SessionAgentState>
  readonly selectSessionModel: (input: SelectSessionModelInput) => Promise<SessionAgentState>
  readonly selectSessionPermission: (sessionId: string, permissionMode: string) => Promise<SessionAgentState>
}

export class ClientSessionAgentStore {
  private readonly sessionStates = new Map<string, SessionAgentState>()
  private readonly sessionListeners = new Map<string, Set<() => void>>()
  private readonly catalogListeners = new Set<() => void>()
  private cachedCatalog: readonly AgentDescriptor[] | undefined

  getCachedCatalog(): readonly AgentDescriptor[] | undefined {
    return this.cachedCatalog
  }

  setCatalog(agents: readonly AgentDescriptor[]): void {
    this.cachedCatalog = agents
    for (const listener of [...this.catalogListeners]) {
      try {
        listener()
      } catch {
        // Ignore subscriber errors.
      }
    }
  }

  subscribeCatalog(listener: () => void): () => void {
    this.catalogListeners.add(listener)
    return () => {
      this.catalogListeners.delete(listener)
    }
  }

  getAgentId(sessionId: string): SessionAgentId {
    return this.sessionStates.get(sessionId)?.agentId ?? 'native'
  }

  getSessionState(sessionId: string): SessionAgentState | undefined {
    return this.sessionStates.get(sessionId)
  }

  setSessionState(state: SessionAgentState): void {
    this.sessionStates.set(state.sessionId, state)
    this.notifySession(state.sessionId)
  }

  notifySession(sessionId: string): void {
    const listeners = this.sessionListeners.get(sessionId)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Ignore subscriber errors.
      }
    }
  }

  subscribeSession(sessionId: string, listener: () => void): () => void {
    let set = this.sessionListeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      const current = this.sessionListeners.get(sessionId)
      if (current !== undefined) {
        current.delete(listener)
        if (current.size === 0) this.sessionListeners.delete(sessionId)
      }
    }
  }

  dispose(): void {
    this.sessionListeners.clear()
    this.catalogListeners.clear()
    this.sessionStates.clear()
  }
}
