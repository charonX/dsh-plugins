/**
 * Host entry point for `@charonx/dsh-external-agents`:
 * provides the `externalAgents` TypertRemoteService, manages durable per-CLI
 * configuration & subscription quota snapshots, attaches the `agent/pre-step`
 * external turn driver, and shares the same adapters with `ctx.subagents` and
 * `dsh-manager` flow catalogs without registering fake LLM providers or presets.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import type LlmService from '@deepseek-ai/dsh-llm'
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
  type ExternalAgentsConfigSnapshot,
  type ExternalModelSelection,
  type SavedModelSelection,
  type SelectSessionAgentInput,
  type SelectSessionModelInput,
  type SelectSessionPermissionInput,
  type SessionAgentId,
  type SessionAgentState,
  type UpdateExternalAgentsConfigInput,
  type WorkspaceGitStatus,
} from './types.ts'
import { createAdapterMap, type ExternalAgentAdapter, type ExternalPermissionPolicy } from './adapters/index.ts'
import { ExternalAgentConfigStore } from './config-store.ts'
import { inspectWorkspaceGitStatus } from './git-status.ts'
import { ExternalAgentCatalog } from './llm-providers.ts'
import { HostToolsMcpBridge } from './mcp-bridge.ts'
import { ExternalQuotaStore } from './quota-store.ts'
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
  configFile?: string | undefined
  quotaFile?: string | undefined
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
  registerAgentPresets: z.boolean().default(false),
  registerSubagents: z.boolean().default(true),
  customModels: z.dict(z.array(modelOptionSchema)).default({}),
  storeFile: z.string(),
  configFile: z.string(),
  quotaFile: z.string(),
}) as unknown as z<Config>

export class ExternalAgentsService extends TypertRemoteService {
  static inject = ['agents']
  static Config: z<Config> = Config

  private catalog!: ExternalAgentCatalog
  private store!: ExternalSessionStore
  private configStore!: ExternalAgentConfigStore
  private quotaStore!: ExternalQuotaStore
  private adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter> = new Map()
  private readonly cfg: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'externalAgents', { namespace: 'externalAgents' })
    this.cfg = config
  }

  protected async [Service.init](): Promise<void> {
    const permissionPolicy: ExternalPermissionPolicy = this.cfg.permissionPolicy ?? 'allow'
    const registerPresetsFlag = this.cfg.registerAgentPresets ?? false
    const registerSubagentsFlag = this.cfg.registerSubagents ?? true

    this.store = new ExternalSessionStore(this.cfg.storeFile)
    this.configStore = new ExternalAgentConfigStore(
      this.cfg.configFile ?? ExternalAgentConfigStore.defaultFilePath(this.cfg.storeFile),
      this.cfg.customModels ?? {},
    )
    this.quotaStore = new ExternalQuotaStore(
      this.cfg.quotaFile ?? ExternalQuotaStore.defaultFilePath(this.cfg.storeFile),
    )

    const adapters = createAdapterMap(id => this.configStore.getCustomModels(id))
    this.adapters = adapters

    const getSubprocess = (): SubprocessRuntime | undefined => this.ctx.get('subprocess') as SubprocessRuntime | undefined
    this.catalog = new ExternalAgentCatalog(adapters, getSubprocess, this.quotaStore)

    // Probe available external CLIs asynchronously so host startup stays non-blocking.
    void this.catalog.refreshAll().catch(() => {})

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
      getDefaultModel: agentId => this.configStore.getAgentSettings(agentId).defaultModel,
      getDefaultReasoningEffort: agentId => this.configStore.getAgentSettings(agentId).defaultReasoningEffort,
      getModelContextWindow: (agentId, model) => this.catalog.getProbe(agentId).modelContextWindows?.[model],
      resolveMcpServers: async (sessionId) => {
        const srv = await mcpBridge.resolveServerForSession(sessionId)
        return srv === undefined ? [] : [srv]
      },
      onQuotaUpdate: (agentId, snapshot) => {
        this.quotaStore.set(agentId, snapshot)
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

    const applyDefaultAgentToBlankSession = async (agent: Agent): Promise<void> => {
      const boundary = this.agentsSvc.turnBoundaryOf(agent.session)
      if (boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null) return
      if (this.store.get(agent.id) !== undefined) return

      const presetId = this.presetSvc()?.presetForSession(agent.session) ?? null
      if (agentIdFromPreset(presetId) !== undefined) return

      const configuredDefault = this.configStore.getDefaultAgent()
      if (configuredDefault === 'native') return

      const cached = this.catalog.getProbe(configuredDefault)
      const probe = cached.available ? cached : await this.catalog.refreshOne(configuredDefault).catch(() => cached)
      if (!probe.available) return
      if (this.store.get(agent.id) !== undefined) return

      const settings = this.configStore.getAgentSettings(configuredDefault)
      this.store.setAgent(agent.id, configuredDefault, {
        model: settings.defaultModel ?? probe.defaultModel,
        ...(settings.defaultReasoningEffort === undefined ? {} : { reasoningEffort: settings.defaultReasoningEffort }),
        ...(probe.defaultPermissionMode === undefined ? {} : { permissionMode: probe.defaultPermissionMode }),
      })
    }

    const disposeCreatedSync = this.ctx.on('agent/created', ({ agent }) => {
      queueMicrotask(() => {
        void applyDefaultAgentToBlankSession(agent).catch(() => {})
      })
    }, { global: true })
    this.ctx.effect(() => disposeCreatedSync, 'external-agents: agent/created default agent sync')
  }

  private get agentsSvc(): AgentRegistry {
    return this.ctx.agents
  }

  private presetSvc(): AgentPresetRegistry | undefined {
    return this.ctx.get('agentPresets') as AgentPresetRegistry | undefined
  }

  private llmSvc(): LlmService | undefined {
    return this.ctx.get('llm') as LlmService | undefined
  }

  private async resolveFallbackNativeModel(): Promise<SavedModelSelection | undefined> {
    const remembered = this.store.getLastNativeModel()
    if (remembered !== undefined) return remembered
    const llm = this.llmSvc()
    if (llm === undefined) return undefined
    const providers = llm.listProviders().filter(p => !p.id.startsWith('ext-'))
    const preferredOrder = ['deepseek-account', 'deepseek-official']
    providers.sort((a, b) => {
      const ai = preferredOrder.indexOf(a.id)
      const bi = preferredOrder.indexOf(b.id)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
    for (const provider of providers) {
      const models = await llm.listModels(provider.id).catch(() => [])
      const first = models[0]
      if (first !== undefined) {
        return { provider: provider.id, model: first.id }
      }
    }
    return undefined
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
      const legacyProvider = live.model.current()?.provider
      const fromModel = agentIdFromProvider(legacyProvider)
      if (fromModel !== undefined) return fromModel
    }
    return 'native'
  }

  private readState(sessionId: string): SessionAgentState {
    const live = this.agentsSvc.get(brandString<SessionId>(sessionId))
    const binding = this.store.get(sessionId)
    const agentId = this.readSessionAgentId(sessionId)
    const probe = agentId === 'native' ? undefined : this.catalog.getProbe(agentId)
    const settings = agentId === 'native' ? undefined : this.configStore.getAgentSettings(agentId)
    const defaultPerm = probe?.defaultPermissionMode
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

    let selectedExternalModel: ExternalModelSelection | undefined
    if (agentId !== 'native') {
      const legacyModel = currentModel !== undefined && currentModel.provider === providerIdForAgent(agentId)
        ? currentModel
        : undefined
      const effModel = (binding?.agentId === agentId ? binding.model : undefined)
        ?? legacyModel?.model
        ?? settings?.defaultModel
        ?? probe?.defaultModel
        ?? 'default'
      const effEffort = binding?.agentId === agentId && binding.reasoningEffort !== undefined
        ? (binding.reasoningEffort === null ? undefined : binding.reasoningEffort)
        : (legacyModel?.reasoningEffort !== undefined
            ? String(legacyModel.reasoningEffort)
            : (settings?.defaultReasoningEffort ?? probe?.reasoning?.defaultEffort))
      selectedExternalModel = {
        model: effModel,
        ...(effEffort === undefined ? {} : { reasoningEffort: effEffort }),
      }
    }

    const activeTasks = this.store.getTasks(sessionId)
    return {
      sessionId,
      agentId,
      locked: live === undefined ? false : this.isSessionLocked(live),
      running: this.store.isRunning(sessionId),
      ...(binding?.externalSessionId === undefined ? {} : { externalSessionId: binding.externalSessionId }),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      ...(selectedExternalModel === undefined ? {} : { selectedExternalModel }),
      ...(effectivePerm === undefined ? {} : { permissionMode: effectivePerm }),
      ...(activeTasks.length === 0 ? {} : { activeTasks }),
    }
  }

  @Remote('getCatalog')
  async getCatalog(): Promise<{ readonly agents: readonly AgentDescriptor[] }> {
    await this.catalog.refreshAll().catch(() => {})
    return { agents: this.catalog.descriptors() }
  }

  @Remote('getConfig')
  async getConfig(): Promise<ExternalAgentsConfigSnapshot> {
    return this.configStore.getSnapshot()
  }

  @Remote('updateConfig')
  async updateConfig(input: UpdateExternalAgentsConfigInput): Promise<ExternalAgentsConfigSnapshot> {
    const next = this.configStore.update(input)
    if (input.agentId !== undefined && input.settings?.customModels !== undefined) {
      await this.catalog.refreshOne(input.agentId).catch(() => {})
    }
    return next
  }

  @Remote('refreshQuota')
  async refreshQuota(input?: { readonly agentId?: ExternalAgentId }): Promise<{ readonly agents: readonly AgentDescriptor[] }> {
    await this.catalog.refreshQuota(input?.agentId).catch(() => {})
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
      if (currentModel !== undefined && agentIdFromProvider(currentModel.provider) !== undefined) {
        const fallback = rememberedNative ?? await this.resolveFallbackNativeModel()
        if (fallback !== undefined) {
          live.model.select({
            provider: fallback.provider,
            model: fallback.model,
            ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort as never }),
          })
        }
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

    const settings = this.configStore.getAgentSettings(input.agentId)
    const initialModel = settings.defaultModel ?? probe.defaultModel
    const initialEffort = settings.defaultReasoningEffort ?? probe.reasoning?.defaultEffort

    this.store.setAgent(input.sessionId, input.agentId, {
      ...(rememberedNative === undefined ? {} : { nativeFallbackModel: rememberedNative }),
      model: initialModel,
      ...(initialEffort === undefined ? {} : { reasoningEffort: initialEffort }),
      ...(probe.defaultPermissionMode === undefined ? {} : { permissionMode: probe.defaultPermissionMode }),
    })

    return this.readState(input.sessionId)
  }

  @Remote('selectSessionModel')
  async selectSessionModel(input: SelectSessionModelInput): Promise<SessionAgentState> {
    const agentId = this.readSessionAgentId(input.sessionId)
    if (agentId === 'native') {
      throw new RemoteError('agent-preset/invalid', 'Native DSH sessions use the native DSH model selector.', {
        agentPreset: 'native',
        reason: 'Native DSH sessions use the native DSH model selector.',
      })
    }
    const probe = this.catalog.getProbe(agentId)
    if (input.reasoningEffort !== undefined && input.reasoningEffort !== null && input.reasoningEffort !== '') {
      const efforts = probe.reasoning?.efforts ?? []
      if (efforts.length > 0 && !efforts.some(item => item.id === input.reasoningEffort)) {
        throw new RemoteError('agent-preset/invalid', `Invalid reasoning effort "${input.reasoningEffort}" for ${agentId}.`, {
          agentPreset: presetIdForAgent(agentId),
          reason: `Invalid reasoning effort "${input.reasoningEffort}"`,
        })
      }
    }
    const normalizedModel = input.model?.trim()
    const normalizedEffort = input.reasoningEffort === '' ? null : input.reasoningEffort
    this.store.setModelSelection(input.sessionId, agentId, {
      ...(normalizedModel === undefined || normalizedModel === '' ? {} : { model: normalizedModel }),
      ...(normalizedEffort === undefined ? {} : { reasoningEffort: normalizedEffort }),
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
