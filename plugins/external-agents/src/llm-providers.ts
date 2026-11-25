/**
 * Registers one LlmAdapter route (`ext-<agentId>`) per external agent so its
 * available models appear cleanly in DSH's model catalog, composer ModelSelect,
 * and IM `/model` selection while sessions remain locked to their chosen agent.
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  EXTERNAL_AGENT_IDS,
  providerIdForAgent,
  type AgentDescriptor,
  type ExternalAgentId,
} from './types.ts'
import { resolveFallbackContextWindow } from './context-windows.ts'
import type { ExternalAgentAdapter, ExternalProbeResult } from './adapters/index.ts'

class ExternalCatalogAdapter extends LlmAdapter {
  constructor(
    private readonly adapter: ExternalAgentAdapter,
    private readonly readProbe: () => ExternalProbeResult,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const probe = this.readProbe()
    return {
      id: provider,
      name: probe.available ? this.adapter.label : `${this.adapter.label} (Unavailable)`,
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const probe = this.readProbe()
    return probe.models.map(item => ({
      provider,
      id: item.id,
      name: item.name,
      inputModalities: ['text', 'image'] as const,
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const probe = this.readProbe()
    const match = probe.models.find(item => item.id === model)
    const reasoning = probe.reasoning
    const contextWindow = resolveFallbackContextWindow(this.adapter.id, model, probe.modelContextWindows)
    return {
      provider,
      id: model,
      name: match?.name ?? model,
      inputModalities: ['text', 'image'] as const,
      context: { contextWindow },
      ...(reasoning === undefined
        ? {}
        : {
          reasoning: {
            efforts: reasoning.efforts.map(effort => ({
              id: brandString<ReasoningEffortId>(effort.id),
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: brandString<ReasoningEffortId>(reasoning.defaultEffort) }),
          },
        }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `External agent route "${options.provider}" must run inside a session bound to ${this.adapter.label}`,
      'UNKNOWN',
    )
    yield* []
  }
}

export class ExternalAgentCatalog {
  private readonly probes = new Map<ExternalAgentId, ExternalProbeResult>()
  private readonly listeners = new Set<(id?: ExternalAgentId) => void>()
  private inFlightRefresh: Promise<void> | undefined
  private lastRefreshedAt = 0

  constructor(
    private readonly adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter>,
    private readonly readSubprocess: () => SubprocessRuntime | undefined,
  ) {}

  /** Subscribe to probe updates so registered LLM providers refresh cached metadata. */
  onChange(listener: (id?: ExternalAgentId) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(id?: ExternalAgentId): void {
    for (const listener of this.listeners) {
      listener(id)
    }
  }

  getProbe(id: ExternalAgentId): ExternalProbeResult {
    const existing = this.probes.get(id)
    if (existing !== undefined) return existing
    const adapter = this.adapters.get(id)!
    const initial: ExternalProbeResult = {
      available: false,
      command: adapter.command,
      reason: 'not probed yet',
      models: [{ id: 'default', name: 'Default' }],
      defaultModel: 'default',
      ...(adapter.reasoning === undefined ? {} : { reasoning: adapter.reasoning }),
      ...(adapter.defaultPermissionMode === undefined ? {} : { defaultPermissionMode: adapter.defaultPermissionMode }),
      permissionModes: adapter.permissionModes,
      commands: [],
    }
    this.probes.set(id, initial)
    return initial
  }

  async refreshAll(signal?: AbortSignal, force = false): Promise<void> {
    if (this.inFlightRefresh !== undefined) return this.inFlightRefresh
    if (!force && this.lastRefreshedAt > 0 && Date.now() - this.lastRefreshedAt < 15_000) return
    const subprocess = this.readSubprocess()
    if (subprocess === undefined) return
    const run = Promise.all(EXTERNAL_AGENT_IDS.map(async (id) => {
      const adapter = this.adapters.get(id)
      if (adapter === undefined) return
      const result = await adapter.probe(subprocess, signal)
      this.probes.set(id, result)
      this.notify(id)
    })).then(() => {
      this.lastRefreshedAt = Date.now()
    })
    this.inFlightRefresh = run.finally(() => {
      if (this.inFlightRefresh === run) this.inFlightRefresh = undefined
    })
    return this.inFlightRefresh
  }

  async refreshOne(id: ExternalAgentId, signal?: AbortSignal): Promise<ExternalProbeResult> {
    const subprocess = this.readSubprocess()
    const adapter = this.adapters.get(id)
    if (adapter === undefined) throw new Error(`Unknown external agent: ${id}`)
    if (subprocess === undefined) return this.getProbe(id)
    const result = await adapter.probe(subprocess, signal)
    this.probes.set(id, result)
    this.notify(id)
    return result
  }

  descriptors(): readonly AgentDescriptor[] {
    const native: AgentDescriptor = {
      id: 'native',
      label: 'DSH Native',
      command: '',
      available: true,
      models: [],
      permissionModes: [],
      commands: [],
    }
    const externals = EXTERNAL_AGENT_IDS.map((id): AgentDescriptor => {
      const adapter = this.adapters.get(id)!
      const probe = this.getProbe(id)
      return {
        id,
        label: adapter.label,
        command: adapter.command,
        available: probe.available,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        provider: providerIdForAgent(id),
        presetId: `ext-${id}`,
        defaultModel: probe.defaultModel,
        models: probe.models,
        ...(probe.defaultPermissionMode === undefined ? {} : { defaultPermissionMode: probe.defaultPermissionMode }),
        permissionModes: probe.permissionModes,
        commands: probe.commands ?? [],
      }
    })
    return [native, ...externals]
  }
}

export function registerExternalLlmProviders(
  ctx: Context,
  adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter>,
  catalog: ExternalAgentCatalog,
): () => void {
  const registrations = new Map<
    ExternalAgentId,
    (() => void) & { replace?: (providers: string[]) => void }
  >()
  for (const id of EXTERNAL_AGENT_IDS) {
    const adapter = adapters.get(id)
    if (adapter === undefined) continue
    const provider = providerIdForAgent(id)
    const llmAdapter = new ExternalCatalogAdapter(adapter, () => catalog.getProbe(id))
    const registration = ctx.llm.registerAdapter([provider], llmAdapter)
    registrations.set(id, registration)
  }
  const unsubscribe = catalog.onChange((changedId) => {
    const ids = changedId === undefined ? EXTERNAL_AGENT_IDS : [changedId]
    for (const id of ids) {
      const registration = registrations.get(id)
      if (typeof registration?.replace !== 'function') continue
      try {
        registration.replace([providerIdForAgent(id)])
      } catch {
        // Ignore ALREADY_DISPOSED races while tearing down the plugin fiber.
      }
    }
  })
  return () => {
    unsubscribe()
    for (const dispose of registrations.values()) dispose()
  }
}
