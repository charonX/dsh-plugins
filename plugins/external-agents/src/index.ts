/**
 * Host entry point for `@charonx/dsh-external-agents`:
 * provides the `externalAgents` TypertRemoteService, registers `ext-*` LLM
 * providers and AgentPresets, attaches the `agent/pre-step` external turn
 * driver, and shares the same adapters with `ctx.subagents`.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import {
  EXTERNAL_AGENT_IDS,
  agentIdFromPreset,
  agentIdFromProvider,
  presetIdForAgent,
  providerIdForAgent,
  type AgentDescriptor,
  type ExternalAgentId,
  type SavedModelSelection,
  type SelectSessionAgentInput,
  type SelectSessionPermissionInput,
  type SessionAgentId,
  type SessionAgentState,
  type WorkspaceGitStatus,
} from './types.ts'
import { createAdapterMap, type ExternalAgentAdapter, type ExternalPermissionPolicy } from './adapters/index.ts'
import { inspectWorkspaceGitStatus } from './git-status.ts'
import { ExternalAgentCatalog, registerExternalLlmProviders } from './llm-providers.ts'
import { HostToolsMcpBridge } from './mcp-bridge.ts'
import { ExternalSessionStore } from './session-store.ts'
import { registerExternalSubagents } from './subagent-bridge.ts'
import { installExternalTurnDriver } from './turn-driver.ts'

export interface ConfigModelOption {
  id: string
  name: string
}

export interface Config {
  permissionPolicy?: ExternalPermissionPolicy | undefined
  registerAgentPresets?: boolean | undefined
  registerSubagents?: boolean | undefined
  customModels?: Record<string, ConfigModelOption[]> | undefined
  storeFile?: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    externalAgents: ExternalAgentsService
  }
}

const modelOptionSchema: z<ConfigModelOption> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})

export const Config: z<Config> = z.object({
  permissionPolicy: z.union(['allow', 'reject']).default('allow'),
  registerAgentPresets: z.boolean().default(true),
  registerSubagents: z.boolean().default(true),
  customModels: z.dict(z.array(modelOptionSchema)).default({}),
  storeFile: z.string(),
}) as unknown as z<Config>

export class ExternalAgentsService extends TypertRemoteService {
  static inject = ['agents', 'llm']
  static Config: z<Config> = Config

  private catalog!: ExternalAgentCatalog
  private store!: ExternalSessionStore
  private adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter> = new Map()
  private readonly cfg: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'externalAgents', { namespace: 'externalAgents' })
    this.cfg = config
  }

  protected async [Service.init](): Promise<void> {
    const permissionPolicy: ExternalPermissionPolicy = this.cfg.permissionPolicy ?? 'allow'
    const registerPresetsFlag = this.cfg.registerAgentPresets ?? true
    const registerSubagentsFlag = this.cfg.registerSubagents ?? true
    const adapters = createAdapterMap(this.cfg.customModels ?? {})
    this.adapters = adapters
    this.store = new ExternalSessionStore(this.cfg.storeFile)
    const getSubprocess = (): SubprocessRuntime | undefined => this.ctx.get('subprocess') as SubprocessRuntime | undefined
    this.catalog = new ExternalAgentCatalog(adapters, getSubprocess)

    // Probe available external CLIs asynchronously so host startup stays non-blocking.
    void this.catalog.refreshAll().catch(() => {})

    const disposeProviders = registerExternalLlmProviders(this.ctx, adapters, this.catalog)
    this.ctx.effect(() => disposeProviders, 'external-agents: llm providers')

    if (registerSubagentsFlag) {
      const disposeSubagents = registerExternalSubagents(this.ctx, adapters, getSubprocess, () => permissionPolicy)
      this.ctx.effect(() => disposeSubagents, 'external-agents: subagent providers')
    }

    if (registerPresetsFlag) {
      const presetScope = this.ctx.inject(['agentPresets'], (presetCtx) => {
        const presets = presetCtx.agentPresets
        const presetDisposers: Array<() => Promise<void>> = []
        let disposed = false
        presetCtx.effect(() => async () => {
          disposed = true
          await Promise.allSettled(presetDisposers.map(dispose => dispose()))
        }, 'external-agents: agent presets lifecycle')

        void (async () => {
          for (const id of EXTERNAL_AGENT_IDS) {
            if (disposed) return
            const adapter = adapters.get(id)
            if (adapter === undefined) continue
            const dispose = await presets.register({
              id: presetIdForAgent(id),
              name: adapter.label,
              description: `Direct session execution via ${adapter.label} (${adapter.command})`,
              plugins: [],
            }).catch(() => undefined)
            if (dispose !== undefined) {
              if (disposed) {
                await dispose().catch(() => {})
              } else {
                presetDisposers.push(dispose)
              }
            }
          }
        })()
      })
      this.ctx.effect(() => () => { presetScope.dispose() }, 'external-agents: agent presets')
    }

    const mcpBridge = new HostToolsMcpBridge(this.ctx)
    this.ctx.effect(() => async () => {
      await mcpBridge.dispose()
    }, 'external-agents: host tools mcp bridge')

    const disposeTurnDriver = installExternalTurnDriver({
      ctx: this.ctx,
      adapters,
      store: this.store,
      getSubprocess,
      getPermissionPolicy: () => permissionPolicy,
      resolvePresetForSession: agent => this.presetSvc()?.presetForSession(agent.session) ?? null,
      getModelContextWindow: (agentId, model) => this.catalog.getProbe(agentId).modelContextWindows?.[model],
      resolveMcpServers: async (sessionId) => {
        const srv = await mcpBridge.resolveServerForSession(sessionId)
        return srv === undefined ? [] : [srv]
      },
    })
    this.ctx.effect(() => disposeTurnDriver, 'external-agents: turn driver')

    this.ctx.effect(() => async () => {
      await Promise.allSettled([...adapters.values()].map(adapter => adapter.dispose?.()))
    }, 'external-agents: persistent adapter pool')

    const disposeAgentCleanup = this.ctx.on('agent/disposed', ({ agent }) => {
      this.store.clearBackgroundState(agent.id)
      for (const adapter of adapters.values()) {
        void adapter.closeSession?.(agent.id).catch(() => {})
      }
    }, { global: true })
    this.ctx.effect(() => disposeAgentCleanup, 'external-agents: agent/disposed session cleanup')

    const resolveFallbackNativeModel = async (): Promise<SavedModelSelection | undefined> => {
      const remembered = this.store.getLastNativeModel()
      if (remembered !== undefined) return remembered
      const providers = this.ctx.llm.listProviders().filter(p => !p.id.startsWith('ext-'))
      const preferredOrder = ['deepseek-account', 'deepseek-official']
      providers.sort((a, b) => {
        const ai = preferredOrder.indexOf(a.id)
        const bi = preferredOrder.indexOf(b.id)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
      for (const provider of providers) {
        const models = await this.ctx.llm.listModels(provider.id).catch(() => [])
        const first = models[0]
        if (first !== undefined) {
          return { provider: provider.id, model: first.id }
        }
      }
      return undefined
    }

    const syncPresetSelectionToModel = async (agent: Agent, presetId: string | null): Promise<void> => {
      const externalAgentId = agentIdFromPreset(presetId)
      const current = agent.model.current()
      if (externalAgentId !== undefined) {
        if (current !== undefined && !current.provider.startsWith('ext-')) {
          this.store.rememberLastNativeModel({
            provider: current.provider,
            model: current.model,
            ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
          })
        }
        const expectedProvider = providerIdForAgent(externalAgentId)
        if (current?.provider === expectedProvider) return
        const probe = this.catalog.getProbe(externalAgentId)
        agent.model.select({
          provider: expectedProvider,
          model: probe.defaultModel,
        })
        return
      }

      const explicit = this.store.get(agent.id)
      if (explicit === undefined || explicit.agentId === 'native') {
        if (current !== undefined && !current.provider.startsWith('ext-')) {
          this.store.rememberLastNativeModel({
            provider: current.provider,
            model: current.model,
            ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
          })
        } else if (current === undefined || current.provider.startsWith('ext-')) {
          const boundary = this.agentsSvc.turnBoundaryOf(agent.session)
          if (boundary.lastTurn === 0 && boundary.openTurnStartSeq === null) {
            const fallback = await resolveFallbackNativeModel()
            if (fallback !== undefined) {
              agent.model.select({
                provider: fallback.provider,
                model: fallback.model,
                ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort as never }),
              })
            }
          }
        }
      }
    }

    const disposeCreatedSync = this.ctx.on('agent/created', ({ agent }) => {
      const presetId = this.presetSvc()?.presetForSession(agent.session) ?? null
      queueMicrotask(() => {
        void syncPresetSelectionToModel(agent, presetId).catch(() => {})
      })
    }, { global: true })
    this.ctx.effect(() => disposeCreatedSync, 'external-agents: agent/created model sync')

    const disposePresetSync = this.ctx.on('agent-preset/selected', (sessionId, presetId) => {
      const live = this.agentsSvc.get(sessionId)
      if (live === undefined) return
      // Defer past Session.append()'s publication lock before appending model/selection.
      queueMicrotask(() => {
        void syncPresetSelectionToModel(live, presetId).catch(() => {})
      })
    })
    this.ctx.effect(() => disposePresetSync, 'external-agents: preset/selected model sync')
  }

  private get agentsSvc(): AgentRegistry {
    return this.ctx.agents
  }

  private presetSvc(): AgentPresetRegistry | undefined {
    return this.ctx.get('agentPresets') as AgentPresetRegistry | undefined
  }

  private isSessionLocked(agent: Agent): boolean {
    const boundary = this.agentsSvc.turnBoundaryOf(agent.session)
    return boundary.openTurnStartSeq !== null || boundary.lastTurn > 0
  }

  private readSessionAgentId(sessionId: string): SessionAgentId {
    const explicit = this.store.get(sessionId)?.agentId
    if (explicit !== undefined) return explicit
    const live = this.agentsSvc.get(brandString<SessionId>(sessionId))
    if (live !== undefined) {
      const preset = this.presetSvc()?.presetForSession(live.session)
      const fromPreset = agentIdFromPreset(preset)
      if (fromPreset !== undefined) return fromPreset
    }
    return 'native'
  }

  private readState(sessionId: string): SessionAgentState {
    const live = this.agentsSvc.get(brandString<SessionId>(sessionId))
    const binding = this.store.get(sessionId)
    const agentId = this.readSessionAgentId(sessionId)
    const defaultPerm = agentId === 'native' ? undefined : this.catalog.getProbe(agentId).defaultPermissionMode
    const effectivePerm = agentId === 'native'
      ? undefined
      : (binding?.agentId === agentId ? (binding.permissionMode ?? defaultPerm) : defaultPerm)
    const currentModel = live?.model.current()
    const selectedModel: SavedModelSelection | undefined = currentModel === undefined
      ? undefined
      : {
          provider: currentModel.provider,
          model: currentModel.model,
          ...(currentModel.reasoningEffort === undefined ? {} : { reasoningEffort: String(currentModel.reasoningEffort) }),
        }
    const activeTasks = this.store.getTasks(sessionId)
    return {
      sessionId,
      agentId,
      locked: live === undefined ? false : this.isSessionLocked(live),
      running: this.store.isRunning(sessionId),
      ...(binding?.externalSessionId === undefined ? {} : { externalSessionId: binding.externalSessionId }),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      ...(effectivePerm === undefined ? {} : { permissionMode: effectivePerm }),
      ...(activeTasks.length === 0 ? {} : { activeTasks }),
    }
  }

  @Remote('getCatalog')
  async getCatalog(): Promise<{ readonly agents: readonly AgentDescriptor[] }> {
    await this.catalog.refreshAll().catch(() => {})
    return { agents: this.catalog.descriptors() }
  }

  @Remote('getSessionState')
  async getSessionState(sessionId: string): Promise<SessionAgentState> {
    return this.readState(sessionId)
  }

  @Remote('getWorkspaceStatus')
  async getWorkspaceStatus(sessionId: string): Promise<WorkspaceGitStatus> {
    const branded = brandString<SessionId>(sessionId)
    const live = this.agentsSvc.get(branded)
    let cwd = live?.session.header.cwd
    if (cwd !== undefined && live !== undefined) {
      const wdSnap = this.ctx.get('sessionProjections')?.snapshot?.(live.session, ['workingDirectory' as never]) as
        | { readonly values?: { readonly workingDirectory?: unknown } }
        | undefined
      const projectedCwd = wdSnap?.values?.workingDirectory
      if (typeof projectedCwd === 'string' && projectedCwd !== '') {
        cwd = projectedCwd
      }
    }
    if (cwd === undefined) {
      const sessionsSvc = this.ctx.get('sessions') as
        | { get?: (id: SessionId) => Promise<{ header?: { cwd?: string } } | undefined> }
        | undefined
      const loaded = await sessionsSvc?.get?.(branded).catch(() => undefined)
      cwd = loaded?.header?.cwd
    }
    if (cwd === undefined || cwd === '') {
      return { cwd: '', isGitRepo: false, isWorktree: false, dirtyCount: 0, worktrees: [] }
    }
    const subprocess = this.ctx.get('subprocess') as SubprocessRuntime | undefined
    return inspectWorkspaceGitStatus(cwd, subprocess)
  }

  @Remote('selectSessionAgent')
  async selectSessionAgent(input: SelectSessionAgentInput): Promise<SessionAgentState> {
    const brandedSessionId = brandString<SessionId>(input.sessionId)
    const live = this.agentsSvc.get(brandedSessionId)
    if (live === undefined) {
      throw new RemoteError('session/not-found', `Session "${input.sessionId}" is not loaded`, {
        sessionId: brandedSessionId,
      })
    }
    if (this.isSessionLocked(live)) {
      throw new RemoteError('agent-preset/locked', 'Agent cannot be switched after the first turn has started; you can only switch models.', {
        sessionId: brandedSessionId,
        agentPreset: input.agentId,
      })
    }

    const currentAgent = this.readSessionAgentId(input.sessionId)
    if (currentAgent === input.agentId) {
      return this.readState(input.sessionId)
    }

    const currentModel = live.model.current()
    const rememberedNative: SavedModelSelection | undefined =
      currentModel !== undefined && agentIdFromProvider(currentModel.provider) === undefined
        ? {
            provider: currentModel.provider,
            model: currentModel.model,
            ...(currentModel.reasoningEffort === undefined ? {} : { reasoningEffort: String(currentModel.reasoningEffort) }),
          }
        : (this.store.get(input.sessionId)?.nativeFallbackModel ?? this.store.getLastNativeModel())

    if (rememberedNative !== undefined) {
      this.store.rememberLastNativeModel(rememberedNative)
    }

    if (input.agentId === 'native') {
      this.store.clearBackgroundState(input.sessionId)
      for (const adapter of this.adapters.values()) {
        void adapter.closeSession?.(input.sessionId).catch(() => {})
      }
      this.store.setAgent(input.sessionId, 'native', {
        ...(rememberedNative === undefined ? {} : { nativeFallbackModel: rememberedNative }),
      })
      const presets = this.presetSvc()
      if (presets !== undefined) {
        const targetPreset = presets.defaultId
        if (!targetPreset.startsWith('ext-')) {
          await presets.select(live, targetPreset).catch(() => {})
        }
      }
      if (rememberedNative !== undefined) {
        live.model.select({
          provider: rememberedNative.provider,
          model: rememberedNative.model,
          ...(rememberedNative.reasoningEffort === undefined ? {} : { reasoningEffort: rememberedNative.reasoningEffort as never }),
        })
      }
      return this.readState(input.sessionId)
    }

    const cachedProbe = this.catalog.getProbe(input.agentId)
    const probe = cachedProbe.available ? cachedProbe : await this.catalog.refreshOne(input.agentId)
    if (!probe.available) {
      throw new RemoteError(
        'session/model-unavailable',
        probe.reason ?? `External agent "${input.agentId}" CLI ("${probe.command}") is not installed`,
        { provider: providerIdForAgent(input.agentId), model: probe.defaultModel },
      )
    }

    this.store.setAgent(input.sessionId, input.agentId, {
      ...(rememberedNative === undefined ? {} : { nativeFallbackModel: rememberedNative }),
      ...(probe.defaultPermissionMode === undefined ? {} : { permissionMode: probe.defaultPermissionMode }),
    })

    const presets = this.presetSvc()
    if (presets !== undefined) {
      await presets.select(live, presetIdForAgent(input.agentId)).catch(() => {})
    }

    live.model.select({
      provider: providerIdForAgent(input.agentId),
      model: probe.defaultModel,
    })

    return this.readState(input.sessionId)
  }

  @Remote('selectSessionPermission')
  async selectSessionPermission(input: SelectSessionPermissionInput): Promise<SessionAgentState> {
    const agentId = this.readSessionAgentId(input.sessionId)
    if (agentId === 'native') {
      throw new RemoteError('agent-preset/invalid', 'Native DSH sessions use DSH built-in permission presets.', {
        agentPreset: 'native',
        reason: 'Native DSH sessions use DSH built-in permission presets.',
      })
    }
    const probe = this.catalog.getProbe(agentId)
    if (probe.permissionModes.length === 0) {
      throw new RemoteError('agent-preset/invalid', `${agentId} does not support permission modes.`, {
        agentPreset: presetIdForAgent(agentId),
        reason: `${agentId} does not support permission modes.`,
      })
    }
    const valid = probe.permissionModes.some(m => m.id === input.permissionMode)
    if (!valid) {
      throw new RemoteError('agent-preset/invalid', `Invalid permission mode "${input.permissionMode}" for ${agentId}.`, {
        agentPreset: presetIdForAgent(agentId),
        reason: `Invalid permission mode "${input.permissionMode}"`,
      })
    }
    this.store.setPermissionMode(input.sessionId, agentId, input.permissionMode)
    return this.readState(input.sessionId)
  }
}

export default ExternalAgentsService
