/**
 * External agent CLI probe catalog and quota cache.
 *
 * External agents no longer register fake `ext-*` LLM providers in `ctx.llm`;
 * this catalog serves `ExternalAgentsService` (for composer switcher, custom
 * single-popover model/effort picker, settings page, and `dsh-manager` flow
 * slash-command enrichment).
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  EXTERNAL_AGENT_IDS,
  type AgentCommandOption,
  type AgentDescriptor,
  type AgentQuotaSnapshot,
  type ExternalAgentId,
} from './types.ts'
import type { ExternalAgentAdapter, ExternalProbeResult } from './adapters/index.ts'
import type { ExternalQuotaStore } from './quota-store.ts'

function fallbackQuotaFor(id: ExternalAgentId, probe: ExternalProbeResult): AgentQuotaSnapshot {
  if (id === 'pi') {
    return {
      status: 'unsupported',
      source: 'unsupported',
      note: 'Pi Agent CLI does not expose subscription quota.',
    }
  }
  if (!probe.available) {
    return {
      status: 'unavailable',
      source: id === 'agy' ? 'active_cli' : 'passive_stream',
    }
  }
  if (id === 'agy') {
    return {
      status: 'unavailable',
      source: 'active_cli',
    }
  }
  return {
    status: 'unavailable',
    source: 'passive_stream',
  }
}

export class ExternalAgentCatalog {
  private static readonly COMMAND_CACHE_TTL_MS = 15_000

  private readonly probes = new Map<ExternalAgentId, ExternalProbeResult>()
  private readonly cwdCommands = new Map<string, { readonly commands: readonly AgentCommandOption[]; readonly fetchedAt: number }>()
  private readonly inFlightCwdCommands = new Map<string, Promise<readonly AgentCommandOption[]>>()
  private readonly listeners = new Set<(id?: ExternalAgentId) => void>()
  private inFlightRefresh: Promise<void> | undefined
  private lastRefreshedAt = 0

  constructor(
    private readonly adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter>,
    private readonly readSubprocess: () => SubprocessRuntime | undefined,
    private readonly quotaStore?: ExternalQuotaStore,
  ) {}

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
      if (id === 'agy' && result.available && adapter.probeQuota !== undefined && this.quotaStore?.get('agy') === undefined) {
        const quota = await adapter.probeQuota(subprocess, signal).catch(() => undefined)
        if (quota !== undefined && quota.status === 'ok') {
          this.quotaStore?.set('agy', quota)
        }
      }
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

  /**
   * Probe and cache slash commands for `(id, cwd)` so workspace-local skills
   * (e.g. `.claude/skills`, `.agents/skills`) are discovered in the session's
   * actual directory instead of `homedir()`.
   */
  async getCommandsForCwd(
    id: ExternalAgentId,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentCommandOption[]> {
    const targetCwd = cwd.trim()
    if (targetCwd === '') return this.getProbe(id).commands ?? []
    const adapter = this.adapters.get(id)
    if (adapter?.probeCommands === undefined) {
      return this.getProbe(id).commands ?? []
    }
    const cacheKey = `${id}\0${targetCwd}`
    const cached = this.cwdCommands.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.fetchedAt < ExternalAgentCatalog.COMMAND_CACHE_TTL_MS) {
      return cached.commands
    }
    const existing = this.inFlightCwdCommands.get(cacheKey)
    if (existing !== undefined) return existing
    const subprocess = this.readSubprocess()
    if (subprocess === undefined) {
      return this.getProbe(id).commands ?? []
    }
    const probeCommands = adapter.probeCommands.bind(adapter)
    const run = probeCommands(subprocess, targetCwd, signal)
      .then((commands) => {
        const globalCommands = this.getProbe(id).commands ?? []
        if (commands.length === 0 && globalCommands.length > 0) {
          return globalCommands
        }
        this.cwdCommands.set(cacheKey, { commands, fetchedAt: Date.now() })
        return commands
      })
      .catch(() => this.getProbe(id).commands ?? [])
      .finally(() => {
        if (this.inFlightCwdCommands.get(cacheKey) === run) {
          this.inFlightCwdCommands.delete(cacheKey)
        }
      })
    this.inFlightCwdCommands.set(cacheKey, run)
    return run
  }

  async refreshQuota(id?: ExternalAgentId, signal?: AbortSignal): Promise<void> {
    const subprocess = this.readSubprocess()
    if (subprocess === undefined) return
    const targets = id === undefined ? EXTERNAL_AGENT_IDS : [id]
    await Promise.all(targets.map(async (agentId) => {
      const adapter = this.adapters.get(agentId)
      if (adapter === undefined) return
      const probe = await this.refreshOne(agentId, signal)
      if (agentId === 'pi') {
        this.quotaStore?.set(agentId, fallbackQuotaFor(agentId, probe))
        this.notify(agentId)
        return
      }
      if (!probe.available) {
        // Keep previously observed passive quota on transient unavailable? No, report unavailable only if none cached.
        if (this.quotaStore?.get(agentId) === undefined) {
          this.quotaStore?.set(agentId, fallbackQuotaFor(agentId, probe))
        }
        this.notify(agentId)
        return
      }
      if (adapter.probeQuota !== undefined) {
        const quota = await adapter.probeQuota(subprocess, signal).catch((): AgentQuotaSnapshot => ({
          status: 'error',
          source: agentId === 'agy' ? 'active_cli' : 'passive_stream',
          observedAt: new Date().toISOString(),
          note: 'Quota probe failed',
        }))
        // For passive CLIs, do not overwrite a previously captured `ok` snapshot with `unavailable`.
        if (quota.source === 'passive_stream' && quota.status !== 'ok' && this.quotaStore?.get(agentId)?.status === 'ok') {
          this.notify(agentId)
          return
        }
        this.quotaStore?.set(agentId, quota)
      }
      this.notify(agentId)
    }))
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
      const storedQuota = this.quotaStore?.get(id)
      const effectiveQuota = id === 'pi'
        ? fallbackQuotaFor(id, probe)
        : (storedQuota ?? fallbackQuotaFor(id, probe))
      return {
        id,
        label: adapter.label,
        command: adapter.command,
        available: probe.available,
        ...(probe.executablePath === undefined ? {} : { executablePath: probe.executablePath }),
        ...(probe.version === undefined ? {} : { version: probe.version }),
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        defaultModel: probe.defaultModel,
        models: probe.models,
        ...(probe.reasoning === undefined ? {} : { reasoning: probe.reasoning }),
        ...(probe.defaultPermissionMode === undefined ? {} : { defaultPermissionMode: probe.defaultPermissionMode }),
        permissionModes: probe.permissionModes,
        commands: probe.commands ?? [],
        ...(probe.authStatus === undefined ? {} : { authStatus: probe.authStatus }),
        quota: effectiveQuota,
      }
    })
    return [native, ...externals]
  }
}
