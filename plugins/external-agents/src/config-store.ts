/**
 * Durable global plugin configuration for `@charonx/dsh-external-agents`:
 * default session agent, per-CLI default model & reasoning effort, and
 * user-defined custom models merged with optional `cordis.patch.yml` seeds.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DSH_HOME_DIR_NAME, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import {
  EXTERNAL_AGENT_IDS,
  type AgentModelOption,
  type ExternalAgentId,
  type ExternalAgentSettings,
  type ExternalAgentsConfigSnapshot,
  type SessionAgentId,
  type UpdateExternalAgentsConfigInput,
} from './types.ts'

interface PersistedConfigFile {
  readonly version: 1
  readonly defaultAgent?: SessionAgentId
  readonly agents?: Partial<Record<ExternalAgentId, ExternalAgentSettings>>
}

function isExternalAgentId(value: unknown): value is ExternalAgentId {
  return typeof value === 'string' && (EXTERNAL_AGENT_IDS as readonly string[]).includes(value)
}

function isSessionAgentId(value: unknown): value is SessionAgentId {
  return value === 'native' || isExternalAgentId(value)
}

function normalizeCustomModels(list: readonly AgentModelOption[] | undefined): readonly AgentModelOption[] | undefined {
  if (!Array.isArray(list)) return undefined
  const seen = new Set<string>()
  const out: AgentModelOption[] = []
  for (const item of list) {
    if (item == null || typeof item.id !== 'string') continue
    const id = item.id.trim()
    if (id === '' || id === 'default' || seen.has(id)) continue
    seen.add(id)
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : id
    out.push({ id, name })
  }
  return out.length > 0 ? out : undefined
}

function normalizeAgentSettings(raw: ExternalAgentSettings | undefined): ExternalAgentSettings | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim() !== ''
    ? raw.defaultModel.trim()
    : undefined
  const defaultReasoningEffort = typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.trim() !== ''
    ? raw.defaultReasoningEffort.trim()
    : undefined
  const customModels = normalizeCustomModels(raw.customModels)
  if (defaultModel === undefined && defaultReasoningEffort === undefined && customModels === undefined) {
    return undefined
  }
  return {
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    ...(customModels === undefined ? {} : { customModels }),
  }
}

export class ExternalAgentConfigStore {
  private defaultAgent: SessionAgentId = 'native'
  private readonly agents = new Map<ExternalAgentId, ExternalAgentSettings>()
  private readonly seedCustomModels = new Map<ExternalAgentId, readonly AgentModelOption[]>()

  constructor(
    private readonly filePath: string = ExternalAgentConfigStore.defaultFilePath(),
    seedCustomModels: Record<string, readonly AgentModelOption[]> = {},
  ) {
    for (const id of EXTERNAL_AGENT_IDS) {
      const normalized = normalizeCustomModels(seedCustomModels[id])
      if (normalized !== undefined) {
        this.seedCustomModels.set(id, normalized)
      }
    }
    this.load()
  }

  static defaultFilePath(sessionsStoreFile?: string): string {
    if (sessionsStoreFile !== undefined && sessionsStoreFile !== '') {
      return join(dirname(sessionsStoreFile), 'config.json')
    }
    const homeDir = process.env[DSH_HOME_ENV] || join(homedir(), DSH_HOME_DIR_NAME)
    return join(homeDir, 'external-agents', 'config.json')
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedConfigFile>
      if (raw.version !== 1) return
      if (isSessionAgentId(raw.defaultAgent)) {
        this.defaultAgent = raw.defaultAgent
      }
      if (raw.agents != null && typeof raw.agents === 'object') {
        for (const id of EXTERNAL_AGENT_IDS) {
          const normalized = normalizeAgentSettings(raw.agents[id])
          if (normalized !== undefined) {
            this.agents.set(id, normalized)
          }
        }
      }
    } catch {
      // Corrupt config file starts clean rather than blocking host startup.
    }
  }

  private save(): void {
    const agentsPayload: Partial<Record<ExternalAgentId, ExternalAgentSettings>> = {}
    for (const id of EXTERNAL_AGENT_IDS) {
      const entry = this.agents.get(id)
      if (entry !== undefined) {
        agentsPayload[id] = entry
      }
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: PersistedConfigFile = {
      version: 1,
      defaultAgent: this.defaultAgent,
      agents: agentsPayload,
    }
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.filePath)
  }

  getDefaultAgent(): SessionAgentId {
    return this.defaultAgent
  }

  getAgentSettings(agentId: ExternalAgentId): ExternalAgentSettings {
    return this.agents.get(agentId) ?? {}
  }

  getCustomModels(agentId: ExternalAgentId): readonly AgentModelOption[] {
    const seed = this.seedCustomModels.get(agentId) ?? []
    const configured = this.agents.get(agentId)?.customModels ?? []
    if (seed.length === 0) return configured
    if (configured.length === 0) return seed
    const seen = new Set<string>()
    const merged: AgentModelOption[] = []
    for (const item of [...configured, ...seed]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
    return merged
  }

  getSnapshot(): ExternalAgentsConfigSnapshot {
    const agents: Partial<Record<ExternalAgentId, ExternalAgentSettings>> = {}
    for (const id of EXTERNAL_AGENT_IDS) {
      const entry = this.agents.get(id)
      if (entry !== undefined) {
        agents[id] = entry
      }
    }
    return {
      defaultAgent: this.defaultAgent,
      agents,
    }
  }

  update(input: UpdateExternalAgentsConfigInput): ExternalAgentsConfigSnapshot {
    let changed = false
    if (input.defaultAgent !== undefined && isSessionAgentId(input.defaultAgent)) {
      if (this.defaultAgent !== input.defaultAgent) {
        this.defaultAgent = input.defaultAgent
        changed = true
      }
    }
    if (input.agentId !== undefined && isExternalAgentId(input.agentId) && input.settings !== undefined) {
      const normalized = normalizeAgentSettings(input.settings)
      if (normalized === undefined) {
        if (this.agents.delete(input.agentId)) changed = true
      } else {
        this.agents.set(input.agentId, normalized)
        changed = true
      }
    }
    if (changed) {
      this.save()
    }
    return this.getSnapshot()
  }
}
