/**
 * Shared domain types for @charonx/dsh-external-agents.
 */

export type ExternalAgentId = 'agy' | 'claude-code' | 'pi' | 'codex' | 'cursor'
export type SessionAgentId = 'native' | ExternalAgentId

export const EXTERNAL_AGENT_IDS: readonly ExternalAgentId[] = [
  'agy',
  'claude-code',
  'pi',
  'codex',
  'cursor',
] as const

/** Provider route prefix used for legacy session compatibility and assistant message provenance. */
export const EXTERNAL_PROVIDER_PREFIX = 'ext-'

/** Preset id prefix used for legacy session compatibility. */
export const EXTERNAL_PRESET_PREFIX = 'ext-'

export function providerIdForAgent(agentId: ExternalAgentId): string {
  return `${EXTERNAL_PROVIDER_PREFIX}${agentId}`
}

export function presetIdForAgent(agentId: ExternalAgentId): string {
  return `${EXTERNAL_PRESET_PREFIX}${agentId}`
}

export function agentIdFromProvider(provider: string | undefined): ExternalAgentId | undefined {
  if (typeof provider !== 'string' || !provider.startsWith(EXTERNAL_PROVIDER_PREFIX)) return undefined
  const candidate = provider.slice(EXTERNAL_PROVIDER_PREFIX.length)
  return (EXTERNAL_AGENT_IDS as readonly string[]).includes(candidate) ? (candidate as ExternalAgentId) : undefined
}

export function agentIdFromPreset(presetId: string | null | undefined): ExternalAgentId | undefined {
  if (typeof presetId !== 'string' || !presetId.startsWith(EXTERNAL_PRESET_PREFIX)) return undefined
  const candidate = presetId.slice(EXTERNAL_PRESET_PREFIX.length)
  return (EXTERNAL_AGENT_IDS as readonly string[]).includes(candidate) ? (candidate as ExternalAgentId) : undefined
}

export interface AgentModelOption {
  readonly id: string
  readonly name: string
}

/** One selectable reasoning effort the agent CLI accepts. */
export interface AgentReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/**
 * Agent-wide reasoning effort catalog. External CLIs accept one effort level
 * for the session, so levels apply to every advertised model of that agent;
 * an omitted `defaultEffort` defers to the CLI's own default.
 */
export interface AgentReasoning {
  readonly efforts: readonly AgentReasoningEffort[]
  readonly defaultEffort?: string
}

export interface AgentCommandOption {
  readonly name: string
  readonly description?: string
  readonly argumentHint?: string
  readonly source?: string
}

export interface AgentPermissionOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AgentAuthStatus {
  readonly authenticated?: boolean
  readonly method?: string
  readonly plan?: string
  readonly summary?: string
}

export type AgentQuotaWindow = '5h' | 'weekly' | 'session' | 'other'

export interface AgentQuotaBucket {
  readonly id: string
  readonly label: string
  readonly window: AgentQuotaWindow
  readonly remainingPercent?: number
  readonly usedPercent?: number
  readonly resetAt?: string
  readonly description?: string
  readonly status?: 'allowed' | 'warning' | 'rejected'
}

export interface AgentQuotaGroup {
  readonly name: string
  readonly description?: string
  readonly buckets: readonly AgentQuotaBucket[]
}

export interface AgentQuotaSnapshot {
  readonly status: 'ok' | 'unavailable' | 'unsupported' | 'error'
  readonly source: 'active_cli' | 'passive_stream' | 'unsupported'
  readonly plan?: string
  readonly observedAt?: string
  readonly note?: string
  readonly groups?: readonly AgentQuotaGroup[]
}

export interface ExternalAgentSettings {
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly customModels?: readonly AgentModelOption[]
}

export interface ExternalAgentsConfigSnapshot {
  readonly defaultAgent: SessionAgentId
  readonly agents: Partial<Record<ExternalAgentId, ExternalAgentSettings>>
}

export interface UpdateExternalAgentsConfigInput {
  readonly defaultAgent?: SessionAgentId
  readonly agentId?: ExternalAgentId
  readonly settings?: ExternalAgentSettings
}

export interface AgentDescriptor {
  readonly id: SessionAgentId
  readonly label: string
  readonly command: string
  readonly available: boolean
  readonly executablePath?: string
  readonly version?: string
  readonly reason?: string
  readonly provider?: string
  readonly presetId?: string
  readonly defaultModel?: string
  readonly models: readonly AgentModelOption[]
  readonly reasoning?: AgentReasoning
  readonly defaultPermissionMode?: string
  readonly permissionModes: readonly AgentPermissionOption[]
  readonly commands: readonly AgentCommandOption[]
  readonly authStatus?: AgentAuthStatus
  readonly quota?: AgentQuotaSnapshot
}

export interface SavedModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ExternalModelSelection {
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ExternalTaskState {
  readonly taskId: string
  readonly toolUseId?: string
  readonly label: string
  readonly description?: string
  readonly subagentType?: string
  readonly status: 'running' | 'completed' | 'failed' | 'stopped'
  readonly lastToolName?: string
  readonly summary?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly toolUses?: number
  readonly totalTokens?: number
}

export interface WorkspaceWorktreeEntry {
  readonly path: string
  readonly branch?: string
  readonly head?: string
  readonly isCurrent: boolean
  readonly isMain: boolean
}

export interface WorkspaceGitStatus {
  readonly cwd: string
  readonly isGitRepo: boolean
  readonly branch?: string
  readonly shortHead?: string
  readonly isWorktree: boolean
  readonly repoRoot?: string
  readonly mainRepoRoot?: string
  readonly dirtyCount: number
  readonly worktrees: readonly WorkspaceWorktreeEntry[]
}

export interface SessionAgentState {
  readonly sessionId: string
  readonly agentId: SessionAgentId
  readonly locked: boolean
  readonly running: boolean
  readonly externalSessionId?: string
  readonly selectedModel?: SavedModelSelection
  readonly selectedExternalModel?: ExternalModelSelection
  readonly permissionMode?: string
  readonly activeTasks?: readonly ExternalTaskState[]
}

export interface SelectSessionAgentInput {
  readonly sessionId: string
  readonly agentId: SessionAgentId
}

export interface SelectSessionPermissionInput {
  readonly sessionId: string
  readonly permissionMode: string
}

export interface SessionCommandsResult {
  readonly agentId: SessionAgentId
  readonly commands: readonly AgentCommandOption[]
}

export interface SelectSessionModelInput {
  readonly sessionId: string
  readonly model?: string
  readonly reasoningEffort?: string | null
}
