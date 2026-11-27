/**
 * Shared domain types for @charonx/dsh-external-agents.
 */

export type ExternalAgentId = 'agy' | 'claude-code' | 'pi' | 'codex'
export type SessionAgentId = 'native' | ExternalAgentId

export const EXTERNAL_AGENT_IDS: readonly ExternalAgentId[] = [
  'agy',
  'claude-code',
  'pi',
  'codex',
] as const

/** Provider route prefix used when exposing external agent models to DSH. */
export const EXTERNAL_PROVIDER_PREFIX = 'ext-'

/** Preset id prefix used when registering external agents in AgentPresetRegistry. */
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

export interface AgentDescriptor {
  readonly id: SessionAgentId
  readonly label: string
  readonly command: string
  readonly available: boolean
  readonly version?: string
  readonly reason?: string
  readonly provider?: string
  readonly presetId?: string
  readonly defaultModel?: string
  readonly models: readonly AgentModelOption[]
  readonly defaultPermissionMode?: string
  readonly permissionModes: readonly AgentPermissionOption[]
  readonly commands: readonly AgentCommandOption[]
}

export interface SavedModelSelection {
  readonly provider: string
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
