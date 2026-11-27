/**
 * Shared ACP (Agent Client Protocol) transport, connection pool, session
 * lifecycle, usage normalization, interim narration isolation, permission
 * routing, and resume-rejection detection for ACP-backed CLI adapters.
 */
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type McpServer as AcpMcpServer,
  type RequestPermissionRequest,
  type ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  AgentCommandOption,
  AgentModelOption,
  AgentPermissionOption,
  AgentReasoning,
  ExternalAgentId,
} from '../types.ts'
import {
  ExternalResumeRejectedError,
  buildExternalSubprocessEnv,
  explainExecFormatError,
  isExecFormatError,
  nonNegativeInt,
  normalizeCommandList,
  positiveInt,
  resolveAgentExecutable,
  stringifyToolPayload,
  type ExternalAgentAdapter,
  type ExternalAsyncEvent,
  type ExternalImageInput,
  type ExternalMcpServerConfig,
  type ExternalPermissionPolicy,
  type ExternalProbeResult,
  type ExternalTurnEvent,
  type ExternalTurnOutcome,
  type ExternalTurnRequest,
  type ExternalUsageReport,
} from './base.ts'

/** ACP config option ids that carry the session's thinking level across agent versions. */
const THOUGHT_LEVEL_CONFIG_IDS = ['thought_level', 'reasoning_effort', 'effort', 'thinking'] as const

const DEFAULT_IDLE_TTL_MS = 60_000
const DEFAULT_POST_BG_IDLE_TTL_MS = 15_000
const DEFAULT_WAKEUP_GRACE_MS = 20_000
const DEFAULT_WAKEUP_QUIESCENCE_MS = 2_500

const BENIGN_ACP_UPDATE_KINDS = new Set([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'usage_update',
  'state_update',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'plan',
])

const READ_ONLY_TOOL_SEGMENT_RE = /(?:^|_)(?:get|list|read|search|query|summary|status|inspect|describe|fetch|show|find|view|check)(?:$|_)/iu
const MUTATING_TOOL_SEGMENT_RE = /(?:^|_)(?:create|write|edit|update|upsert|delete|remove|drop|replace|set|put|post|patch|approve|reject|answer|run|exec|kill|cancel|push|merge)(?:$|_)/iu

/**
 * Matches request-shape complaints ("invalid session params: ...", "unknown
 * session capability ...") so they are stripped before checking whether an ACP
 * runtime explicitly rejected the stored session id.
 */
const ACP_SESSION_REQUEST_COMPLAINT_RE = /(no such|unknown|invalid|expired|unrecogni[sz]ed|nonexistent|missing)\s+(session|conversation|thread)\s+(params?|parameters?|request|requests|config|configuration|option|options|capability|capabilities|mode|setup)/giu

const ACP_SESSION_NOT_FOUND_LITERALS = [
  'session not found',
  'unknown session',
  'no such session',
  'session does not exist',
  "session doesn't exist",
  'session no longer exists',
  'invalid session id',
  'invalid session identifier',
  'conversation not found',
  'unknown conversation',
  'no such conversation',
  'thread not found',
  'unknown thread',
] as const

const ACP_SESSION_UNUSABLE_RE = new RegExp(
  '(no such|unknown|invalid|expired|unrecogni[sz]ed|nonexistent|missing)\\s+(session|conversation|thread)'
  + '|no\\s+(session|conversation|thread)\\s+found'
  + '|(session|conversation|thread)(\\s+(id|identifier))?(\\s+"?[\\w-]+"?)?\\s+(is\\s+)?(not found|does not exist|doesn\'t exist|no longer exists|expired|invalid|unknown|unrecogni[sz]ed)',
  'iu',
)

export interface AcpSessionBaseOptions {
  /** Idle TTL before closing a pooled ACP subprocess when no background tasks remain. */
  readonly idleTtlMs?: number
  /** Idle TTL after a background wakeup turn settles with no open tasks. */
  readonly postBgIdleTtlMs?: number
  /** How long to wait after all background tools finish for ACP reactive wakeup text before falling back. */
  readonly wakeupGraceMs?: number
  /** Quiet window after wakeup output chunks before marking a reactive wakeup turn complete. */
  readonly wakeupQuiescenceMs?: number
  /** ACP client name reported in `initialize` (defaults to `dsh-external-agents`). */
  readonly clientName?: string
}

export function acpBlockText(content: AcpContentBlock | undefined): string {
  if (content === undefined) return ''
  return content.type === 'text' ? content.text : ''
}

export function extractAcpToolContent(content: readonly ToolCallContent[] | undefined, rawOutput: unknown): string {
  if (Array.isArray(content) && content.length > 0) {
    const parts: string[] = []
    for (const item of content) {
      if (item.type === 'content') {
        const text = acpBlockText(item.content)
        if (text !== '') parts.push(text)
      } else if (item.type === 'diff') {
        parts.push(`diff ${item.path}`)
      } else if (item.type === 'terminal') {
        parts.push(`terminal:${item.terminalId}`)
      }
    }
    const joined = parts.join('\n').trim()
    if (joined !== '') return joined
  }
  return stringifyToolPayload(rawOutput)
}

export function extractAcpToolStartEvent(
  callId: string,
  rawUpdate: Record<string, unknown>,
): Extract<ExternalTurnEvent, { readonly type: 'tool_start' }> {
  const toolName = typeof rawUpdate.name === 'string' && rawUpdate.name.trim() !== ''
    ? rawUpdate.name.trim()
    : undefined
  const title = typeof rawUpdate.title === 'string' && rawUpdate.title.trim() !== ''
    ? rawUpdate.title
    : undefined
  const kind = typeof rawUpdate.kind === 'string' && rawUpdate.kind.trim() !== ''
    ? rawUpdate.kind
    : undefined
  const name = title ?? kind ?? toolName ?? 'tool'
  const rawArgs = rawUpdate.rawInput ?? rawUpdate.args ?? { title: rawUpdate.title, kind: rawUpdate.kind }
  return {
    type: 'tool_start',
    callId,
    name,
    arguments: JSON.stringify(rawArgs),
    ...(toolName === undefined ? {} : { toolName }),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
  }
}

export function extractModelsFromSessionResponse(response: unknown): readonly AgentModelOption[] {
  if (typeof response !== 'object' || response === null) return []
  const rec = response as Record<string, unknown>
  const discovered: AgentModelOption[] = []
  if (Array.isArray(rec.configOptions)) {
    for (const opt of rec.configOptions) {
      if (typeof opt !== 'object' || opt === null) continue
      const configOpt = opt as Record<string, unknown>
      if (configOpt.id === 'model' && Array.isArray(configOpt.options)) {
        for (const item of configOpt.options) {
          if (typeof item !== 'object' || item === null) continue
          const entry = item as Record<string, unknown>
          if (typeof entry.value === 'string') {
            discovered.push({
              id: entry.value,
              name: typeof entry.name === 'string' ? entry.name : entry.value,
            })
          }
        }
      }
    }
  }
  if (discovered.length === 0 && typeof rec.models === 'object' && rec.models !== null) {
    const modelsObj = rec.models as Record<string, unknown>
    if (Array.isArray(modelsObj.availableModels)) {
      for (const item of modelsObj.availableModels) {
        if (typeof item !== 'object' || item === null) continue
        const entry = item as Record<string, unknown>
        if (typeof entry.modelId === 'string') {
          discovered.push({
            id: entry.modelId,
            name: typeof entry.name === 'string' ? entry.name : entry.modelId,
          })
        }
      }
    }
  }
  return discovered
}

/** Extract ACP `session/new` `configOptions` thinking levels when advertised. */
export function extractReasoningFromSessionResponse(response: unknown): AgentReasoning | undefined {
  if (typeof response !== 'object' || response === null) return undefined
  const rec = response as Record<string, unknown>
  if (!Array.isArray(rec.configOptions)) return undefined
  for (const opt of rec.configOptions) {
    if (typeof opt !== 'object' || opt === null) continue
    const configOpt = opt as Record<string, unknown>
    if (typeof configOpt.id !== 'string'
      || !(THOUGHT_LEVEL_CONFIG_IDS as readonly string[]).includes(configOpt.id)
      || !Array.isArray(configOpt.options)) continue
    const efforts: AgentReasoning['efforts'][number][] = []
    for (const item of configOpt.options) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.value !== 'string' || entry.value === '') continue
      const description = typeof entry.description === 'string' && entry.description !== ''
        ? entry.description
        : undefined
      efforts.push({
        id: entry.value,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.value,
        ...(description === undefined ? {} : { description }),
      })
    }
    if (efforts.length > 0) return { efforts }
  }
  return undefined
}

function parseUsageObject(usageObj: Record<string, unknown>): Extract<ExternalTurnEvent, { readonly type: 'usage' }> | undefined {
  const rawInputTokens = nonNegativeInt(usageObj.inputTokens ?? usageObj.input_tokens)
  const outputTokens = nonNegativeInt(usageObj.outputTokens ?? usageObj.output_tokens)
  const reasoningTokens = nonNegativeInt(usageObj.thoughtTokens ?? usageObj.reasoningTokens ?? usageObj.thought_tokens)
  const cacheReadTokens = nonNegativeInt(
    usageObj.cachedReadTokens
    ?? usageObj.cacheReadTokens
    ?? usageObj.cached_input_tokens
    ?? usageObj.cache_read_tokens
    ?? usageObj.cache_read_input_tokens,
  )
  const cacheWriteTokens = nonNegativeInt(
    usageObj.cachedWriteTokens
    ?? usageObj.cacheWriteTokens
    ?? usageObj.cache_write_tokens
    ?? usageObj.cache_creation_input_tokens,
  )
  const totalTokens = nonNegativeInt(usageObj.totalTokens ?? usageObj.total_tokens)
  if (
    rawInputTokens === undefined
    && outputTokens === undefined
    && reasoningTokens === undefined
    && cacheReadTokens === undefined
    && cacheWriteTokens === undefined
  ) {
    return undefined
  }
  let inputTokens = rawInputTokens ?? 0
  if (
    totalTokens !== undefined
    && totalTokens > 0
    && cacheReadTokens !== undefined
    && cacheReadTokens > 0
    && cacheReadTokens <= inputTokens
    && totalTokens === inputTokens + (outputTokens ?? 0)
  ) {
    inputTokens -= cacheReadTokens
  }
  return {
    type: 'usage',
    inputTokens,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    isTurnTotal: true,
  }
}

/** Extract ACP `usage_update` / `state_update.usage` / `PromptResponse.usage` / `_meta.usage` into a usage event. */
export function extractAcpUsageEvent(
  payload: unknown,
): Extract<ExternalTurnEvent, { readonly type: 'usage' }> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const rec = payload as Record<string, unknown>
  if (rec.sessionUpdate === 'usage_update') {
    const used = nonNegativeInt(rec.used)
    const size = positiveInt(rec.size)
    if (used === undefined && size === undefined) return undefined
    return {
      type: 'usage',
      inputTokens: used ?? 0,
      outputTokens: 0,
      ...(used === undefined ? {} : { contextUsedTokens: used }),
      ...(size === undefined ? {} : { contextWindow: size }),
    }
  }
  if (rec.sessionUpdate === 'state_update') {
    const usageObj = typeof rec.usage === 'object' && rec.usage !== null
      ? rec.usage as Record<string, unknown>
      : undefined
    return usageObj === undefined ? undefined : parseUsageObject(usageObj)
  }
  const direct = parseUsageObject(rec)
  if (direct !== undefined) return direct
  if (typeof rec._meta === 'object' && rec._meta !== null) {
    const meta = rec._meta as Record<string, unknown>
    const nested = typeof meta.usage === 'object' && meta.usage !== null
      ? parseUsageObject(meta.usage as Record<string, unknown>)
      : undefined
    return nested ?? parseUsageObject(meta)
  }
  return undefined
}

/**
 * Reconciles cumulative `usage_update` snapshots with terminal `PromptResponse`
 * usage via per-bucket maxima so equivalent reports are never double-counted.
 */
export class AcpUsageAccumulator {
  private inputTokens: number | undefined
  private outputTokens: number | undefined
  private cacheReadTokens: number | undefined
  private cacheWriteTokens: number | undefined
  private reasoningTokens: number | undefined
  private contextWindow: number | undefined
  private contextUsedTokens: number | undefined

  merge(report: ExternalUsageReport): ExternalUsageReport {
    if (report.contextWindow !== undefined && (this.contextWindow === undefined || report.contextWindow > this.contextWindow)) {
      this.contextWindow = report.contextWindow
    }
    if (report.contextUsedTokens !== undefined && (this.contextUsedTokens === undefined || report.contextUsedTokens > this.contextUsedTokens)) {
      this.contextUsedTokens = report.contextUsedTokens
    }
    if (report.isTurnTotal === true) {
      if (this.inputTokens === undefined || report.inputTokens > this.inputTokens) {
        this.inputTokens = report.inputTokens
      }
      if (this.outputTokens === undefined || report.outputTokens > this.outputTokens) {
        this.outputTokens = report.outputTokens
      }
      if (report.cacheReadTokens !== undefined && (this.cacheReadTokens === undefined || report.cacheReadTokens > this.cacheReadTokens)) {
        this.cacheReadTokens = report.cacheReadTokens
      }
      if (report.cacheWriteTokens !== undefined && (this.cacheWriteTokens === undefined || report.cacheWriteTokens > this.cacheWriteTokens)) {
        this.cacheWriteTokens = report.cacheWriteTokens
      }
      if (report.reasoningTokens !== undefined && (this.reasoningTokens === undefined || report.reasoningTokens > this.reasoningTokens)) {
        this.reasoningTokens = report.reasoningTokens
      }
    }
    return {
      inputTokens: this.inputTokens ?? report.inputTokens,
      outputTokens: this.outputTokens ?? report.outputTokens,
      ...(this.cacheReadTokens === undefined ? {} : { cacheReadTokens: this.cacheReadTokens }),
      ...(this.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: this.cacheWriteTokens }),
      ...(this.reasoningTokens === undefined ? {} : { reasoningTokens: this.reasoningTokens }),
      ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
      ...(this.contextUsedTokens === undefined ? {} : { contextUsedTokens: this.contextUsedTokens }),
      ...(report.isTurnTotal === undefined ? {} : { isTurnTotal: report.isTurnTotal }),
    }
  }
}

/** Build ACP `session/prompt` content blocks with text and optional images. */
export function buildAcpPromptBlocks(
  prompt: string,
  images: readonly ExternalImageInput[] = [],
  supportsImage = true,
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  let effectiveText = prompt
  if (!supportsImage && images.length > 0) {
    const paths = images
      .map((img, idx) => img.hostPath ? `- Image ${idx + 1}: ${img.hostPath}` : `- Image ${idx + 1}: (${img.mediaType})`)
      .join('\n')
    effectiveText = effectiveText.trim() === '' ? paths : `${effectiveText}\n\nAttached images:\n${paths}`
  }
  if (effectiveText !== '' || images.length === 0) {
    blocks.push({ type: 'text', text: effectiveText })
  }
  if (supportsImage) {
    for (const img of images) {
      blocks.push({
        type: 'image',
        data: img.base64,
        mimeType: img.mediaType,
        ...(img.hostPath === undefined ? {} : { uri: pathToFileURL(img.hostPath).href }),
      })
    }
  }
  return blocks
}

/** Extract ACP `available_commands_update` command descriptors. */
export function extractAcpAvailableCommands(update: unknown): readonly AgentCommandOption[] {
  if (typeof update !== 'object' || update === null) return []
  const rec = update as Record<string, unknown>
  if (rec.sessionUpdate !== 'available_commands_update' || !Array.isArray(rec.availableCommands)) return []
  const commands: AgentCommandOption[] = []
  for (const item of rec.availableCommands) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || entry.name.trim() === '') continue
    const description = typeof entry.description === 'string' ? entry.description : undefined
    const inputObj = typeof entry.input === 'object' && entry.input !== null
      ? entry.input as Record<string, unknown>
      : undefined
    const argumentHint = typeof inputObj?.hint === 'string' ? inputObj.hint : undefined
    commands.push({
      name: entry.name,
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
      source: 'acp',
    })
  }
  return normalizeCommandList(commands)
}

export async function closeSubprocess(handle: SubprocessHandle): Promise<void> {
  try {
    handle.stdin?.end()
  } catch {
    // Ignore close errors.
  }
  const settled = await Promise.race([
    handle.done.then(() => true, () => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_500)),
  ])
  if (!settled) {
    try {
      await handle.terminate()
    } catch {
      // Ignore termination failures.
    }
  }
}

export function formatAcpError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const rec = error as { readonly message?: unknown; readonly code?: unknown; readonly data?: unknown }
    const parts: string[] = []
    if (typeof rec.message === 'string' && rec.message !== '') parts.push(rec.message)
    if (typeof rec.code === 'number' || typeof rec.code === 'string') parts.push(`code=${String(rec.code)}`)
    if (typeof rec.data === 'string' && rec.data !== '') parts.push(rec.data)
    else if (rec.data !== undefined) {
      try {
        parts.push(JSON.stringify(rec.data))
      } catch {
        // Ignore unserializable data.
      }
    }
    if (parts.length > 0) return parts.join(' ')
  }
  return String(error)
}

function extractAcpErrorText(error: unknown): { readonly code?: number; readonly text: string } {
  if (typeof error !== 'object' || error === null) {
    return { text: String(error ?? '') }
  }
  const rec = error as {
    readonly code?: unknown
    readonly message?: unknown
    readonly data?: unknown
    readonly cause?: unknown
  }
  const code = typeof rec.code === 'number' ? rec.code : undefined
  const parts: string[] = []
  if (typeof rec.message === 'string') parts.push(rec.message)
  if (typeof rec.data === 'string') {
    parts.push(rec.data)
  } else if (rec.data !== undefined) {
    try {
      parts.push(JSON.stringify(rec.data))
    } catch {
      // Ignore unserializable error data.
    }
  }
  if (rec.cause !== undefined) {
    const nested = extractAcpErrorText(rec.cause)
    if (nested.text !== '') parts.push(nested.text)
    const resolvedCode = code ?? nested.code
    return {
      ...(resolvedCode === undefined ? {} : { code: resolvedCode }),
      text: parts.join(' ').trim(),
    }
  }
  return { ...(code === undefined ? {} : { code }), text: parts.join(' ').trim() }
}

/**
 * Positive-evidence check for whether a `session/load` or `session/resume` error
 * means the runtime explicitly rejected the stored `externalSessionId`.
 * Transient network, auth, MCP, or request-malformation errors return `false`.
 */
export function isAcpResumeRejectedError(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const { text } = extractAcpErrorText(error)
  if (text === '') return false
  const cleaned = text.toLowerCase().replace(ACP_SESSION_REQUEST_COMPLAINT_RE, ' ')
  if (ACP_SESSION_NOT_FOUND_LITERALS.some(lit => cleaned.includes(lit))) {
    return true
  }
  return ACP_SESSION_UNUSABLE_RE.test(cleaned)
}

function isAcpMethodNotFoundError(error: unknown): boolean {
  const { code, text } = extractAcpErrorText(error)
  if (code === -32601) return true
  return /\bmethod not found\b/i.test(text)
}

export interface AcpMcpPermissionMatch {
  readonly isBridgedMcp: boolean
  readonly isReadOnlyBridgedMcp: boolean
  readonly matchedServer?: string
}

function stripServerPrefix(identifier: string, serverName: string): string | undefined {
  const normalizedName = serverName.replace(/[^A-Za-z0-9_]/g, '_')
  const prefixes = [
    `mcp_${serverName}_`,
    `mcp__${serverName}__`,
    `${serverName}:`,
    `${serverName}/`,
    ...(normalizedName !== serverName
      ? [
          `mcp_${normalizedName}_`,
          `mcp__${normalizedName}__`,
          `${normalizedName}:`,
          `${normalizedName}/`,
        ]
      : []),
  ]
  for (const prefix of prefixes) {
    if (identifier.startsWith(prefix)) {
      return identifier.slice(prefix.length)
    }
  }
  return undefined
}

function isLikelyReadOnlyToolName(bareToolName: string): boolean {
  if (bareToolName === '') return false
  return READ_ONLY_TOOL_SEGMENT_RE.test(bareToolName) && !MUTATING_TOOL_SEGMENT_RE.test(bareToolName)
}

/**
 * Match an ACP `session/request_permission` tool call dynamically against the
 * session's active `mcpServers` without hardcoding server-specific prefixes.
 */
export function classifyAcpMcpPermission(
  toolCall: RequestPermissionRequest['toolCall'],
  mcpServers: readonly ExternalMcpServerConfig[],
): AcpMcpPermissionMatch {
  if (mcpServers.length === 0) {
    return { isBridgedMcp: false, isReadOnlyBridgedMcp: false }
  }
  const rawToolName = typeof (toolCall as { readonly name?: unknown }).name === 'string'
    ? (toolCall as { readonly name: string }).name.trim()
    : ''
  const toolTitle = typeof toolCall.title === 'string' ? toolCall.title.trim() : ''
  const candidates = [rawToolName, toolTitle].filter(s => s !== '')
  if (candidates.length === 0) {
    return { isBridgedMcp: false, isReadOnlyBridgedMcp: false }
  }

  for (const srv of mcpServers) {
    for (const candidate of candidates) {
      const stripped = stripServerPrefix(candidate, srv.name)
      const matchedSpec = (srv.tools ?? []).find(t =>
        candidate === t.name
        || stripped === t.name
        || candidate.endsWith(`_${t.name}`)
        || candidate.endsWith(`:${t.name}`)
        || candidate.endsWith(`/${t.name}`),
      )
      if (stripped !== undefined || matchedSpec !== undefined) {
        const bareName = matchedSpec?.name ?? stripped ?? candidate
        const isReadOnly = matchedSpec?.readOnly !== undefined
          ? matchedSpec.readOnly
          : isLikelyReadOnlyToolName(bareName)
        return {
          isBridgedMcp: true,
          isReadOnlyBridgedMcp: isReadOnly,
          matchedServer: srv.name,
        }
      }
    }
  }

  return { isBridgedMcp: false, isReadOnlyBridgedMcp: false }
}

interface WakeupWaiter {
  onEvent: (event: ExternalTurnEvent) => void | Promise<void>
  sawProseAfterLastTool: boolean
  finalText: string
  settle: () => void
  reject: (error: unknown) => void
}

export interface PooledAcpSession {
  readonly dshSessionId: string
  readonly cwd: string
  readonly mode: string
  readonly mcpSignature: string
  readonly executablePath: string
  readonly child: SubprocessHandle
  readonly connection: ReturnType<ReturnType<typeof createAcpClientApp>['connect']>
  readonly supportsImage: boolean
  readonly advertisedModelIds: ReadonlySet<string>
  mcpServers: readonly ExternalMcpServerConfig[]
  externalSessionId: string
  permissionPolicy: ExternalPermissionPolicy
  lastModeApplied?: string
  lastModelApplied?: string
  lastReasoningApplied?: string
  ignoringLoadReplay: boolean
  closed: boolean
  closing: boolean
  inPrompt: boolean
  activeSink?: ((event: ExternalTurnEvent) => void | Promise<void>) | undefined
  onUnknownUpdate?: (() => void) | undefined
  onPermissionActivity?: (() => void) | undefined
  notifyQueue: Promise<void>
  readonly startedToolIds: Set<string>
  readonly finishedToolIds: Set<string>
  readonly inFlightTools: Set<string>
  asyncBuffer: ExternalTurnEvent[]
  wakeupSignaled: boolean
  activeWakeup?: WakeupWaiter | undefined
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  wakeupGraceTimer?: ReturnType<typeof setTimeout> | undefined
  wakeupQuiescenceTimer?: ReturnType<typeof setTimeout> | undefined
  spawnError?: unknown
}

export abstract class AcpSessionBase implements ExternalAgentAdapter {
  abstract readonly id: ExternalAgentId
  abstract readonly label: string
  abstract readonly command: string
  abstract readonly permissionModes: readonly AgentPermissionOption[]
  readonly reasoning?: AgentReasoning
  readonly defaultPermissionMode?: string

  protected readonly idleTtlMs: number
  protected readonly postBgIdleTtlMs: number
  protected readonly wakeupGraceMs: number
  protected readonly wakeupQuiescenceMs: number
  protected readonly clientName: string
  private readonly pool = new Map<string, PooledAcpSession>()
  private readonly asyncListeners = new Map<string, Set<(event: ExternalAsyncEvent) => void>>()

  constructor(options: AcpSessionBaseOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.postBgIdleTtlMs = options.postBgIdleTtlMs ?? DEFAULT_POST_BG_IDLE_TTL_MS
    this.wakeupGraceMs = options.wakeupGraceMs ?? DEFAULT_WAKEUP_GRACE_MS
    this.wakeupQuiescenceMs = options.wakeupQuiescenceMs ?? DEFAULT_WAKEUP_QUIESCENCE_MS
    this.clientName = options.clientName ?? 'dsh-external-agents'
  }

  abstract probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult>

  protected buildAcpSpawnArgs(_request: ExternalTurnRequest, _mode: string): string[] {
    return ['acp']
  }

  protected buildProbeSpawnArgs(): string[] {
    return ['acp']
  }

  protected resolveTurnMode(request: ExternalTurnRequest): string {
    return request.permissionMode ?? (request.permissionPolicy === 'allow' ? (this.defaultPermissionMode ?? 'default') : 'default')
  }

  protected shouldBypassSetMode(_mode: string): boolean {
    return false
  }

  protected validateRequestedModel(session: PooledAcpSession, model: string | undefined): void {
    if (model === undefined || model === '' || model === 'default') return
    if (session.advertisedModelIds.size > 0 && !session.advertisedModelIds.has(model)) {
      throw new Error(
        `Unknown model "${model}" for ${this.label} (available: ${[...session.advertisedModelIds].join(', ')})`,
      )
    }
  }

  protected async applyTurnConfiguration(
    session: PooledAcpSession,
    request: ExternalTurnRequest,
    mode: string,
  ): Promise<void> {
    this.validateRequestedModel(session, request.model)

    if (!this.shouldBypassSetMode(mode) && session.lastModeApplied !== mode) {
      try {
        await session.connection.agent.request(methods.agent.session.setMode, {
          sessionId: session.externalSessionId,
          modeId: mode,
        })
      } catch (error) {
        throw new Error(`ACP session/set_mode("${mode}") failed: ${formatAcpError(error)}`, { cause: error })
      }
      session.lastModeApplied = mode
    }

    if (
      request.model !== undefined
      && request.model !== ''
      && request.model !== 'default'
      && session.lastModelApplied !== request.model
    ) {
      try {
        await session.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.externalSessionId,
          configId: 'model',
          value: request.model,
        })
      } catch (error) {
        throw new Error(
          `ACP session/set_config_option("model", "${request.model}") failed: ${formatAcpError(error)}`,
          { cause: error },
        )
      }
      session.lastModelApplied = request.model
    }

    if (
      request.reasoningEffort !== undefined
      && request.reasoningEffort !== ''
      && session.lastReasoningApplied !== request.reasoningEffort
    ) {
      try {
        await session.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.externalSessionId,
          configId: 'thought_level',
          value: request.reasoningEffort,
        })
      } catch (error) {
        throw new Error(
          `ACP session/set_config_option("thought_level", "${request.reasoningEffort}") failed: ${formatAcpError(error)}`,
          { cause: error },
        )
      }
      session.lastReasoningApplied = request.reasoningEffort
    }
  }

  protected shouldAllowPermission(
    params: RequestPermissionRequest,
    session: PooledAcpSession,
  ): boolean {
    if (session.permissionPolicy === 'reject') return false
    const mode = session.mode
    if (mode === 'bypass' || mode === 'auto') return true
    const allowKind = params.toolCall.kind
    const mcpMatch = classifyAcpMcpPermission(params.toolCall, session.mcpServers)
    if (mode === 'accept-edits' || mode === 'agent') {
      return allowKind === 'edit'
        || allowKind === 'read'
        || allowKind === 'search'
        || allowKind === 'think'
        || mcpMatch.isBridgedMcp
    }
    if (mode === 'plan') {
      return allowKind === 'read'
        || allowKind === 'search'
        || allowKind === 'think'
        || mcpMatch.isReadOnlyBridgedMcp
    }
    return false
  }

  subscribeBackground(dshSessionId: string, listener: (event: ExternalAsyncEvent) => void): () => void {
    let set = this.asyncListeners.get(dshSessionId)
    if (set === undefined) {
      set = new Set()
      this.asyncListeners.set(dshSessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.asyncListeners.delete(dshSessionId)
      }
    }
  }

  consumeBufferedAsyncEvents(dshSessionId: string): readonly ExternalTurnEvent[] {
    const session = this.pool.get(dshSessionId)
    if (session === undefined || session.asyncBuffer.length === 0) return []
    const drained = session.asyncBuffer
    session.asyncBuffer = []
    this.clearWakeupTimers(session)
    session.wakeupSignaled = false
    return drained
  }

  async closeSession(dshSessionId: string): Promise<void> {
    const session = this.pool.get(dshSessionId)
    if (session === undefined) return
    this.pool.delete(dshSessionId)
    await this.disposePooledSession(session)
  }

  async dispose(): Promise<void> {
    const entries = [...this.pool.values()]
    this.pool.clear()
    await Promise.allSettled(entries.map(session => this.disposePooledSession(session)))
  }

  private emitAsync(dshSessionId: string, event: ExternalAsyncEvent): void {
    const listeners = this.asyncListeners.get(dshSessionId)
    if (listeners === undefined) return
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // Ignore subscriber errors inside notification dispatch.
      }
    }
  }

  private clearIdleTimer(session: PooledAcpSession): void {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer)
      session.idleTimer = undefined
    }
  }

  private clearWakeupTimers(session: PooledAcpSession): void {
    if (session.wakeupGraceTimer !== undefined) {
      clearTimeout(session.wakeupGraceTimer)
      session.wakeupGraceTimer = undefined
    }
    if (session.wakeupQuiescenceTimer !== undefined) {
      clearTimeout(session.wakeupQuiescenceTimer)
      session.wakeupQuiescenceTimer = undefined
    }
  }

  private scheduleIdleClose(session: PooledAcpSession, delayMs: number): void {
    this.clearIdleTimer(session)
    if (session.closed || session.closing || session.inPrompt || session.activeWakeup !== undefined) return
    if (session.inFlightTools.size > 0 || session.asyncBuffer.length > 0 || session.wakeupSignaled) return
    if (delayMs <= 0) {
      void this.closeSession(session.dshSessionId)
      return
    }
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined
      if (this.pool.get(session.dshSessionId) === session && !session.inPrompt && session.inFlightTools.size === 0) {
        void this.closeSession(session.dshSessionId)
      }
    }, delayMs)
    session.idleTimer.unref?.()
  }

  private refreshWakeupQuiescence(session: PooledAcpSession): void {
    if (session.closed || session.closing || session.inPrompt) return
    const waiter = session.activeWakeup
    if (waiter === undefined) return
    if (session.wakeupQuiescenceTimer !== undefined) {
      clearTimeout(session.wakeupQuiescenceTimer)
      session.wakeupQuiescenceTimer = undefined
    }
    if (session.inFlightTools.size > 0 && !waiter.sawProseAfterLastTool) return
    const delayMs = session.inFlightTools.size > 0
      ? Math.max(this.wakeupQuiescenceMs, 3_500)
      : this.wakeupQuiescenceMs
    session.wakeupQuiescenceTimer = setTimeout(() => {
      session.wakeupQuiescenceTimer = undefined
      if (session.activeWakeup === waiter) {
        waiter.settle()
      }
    }, delayMs)
    session.wakeupQuiescenceTimer.unref?.()
  }

  private async disposePooledSession(session: PooledAcpSession): Promise<void> {
    if (session.closing) {
      await session.child.done.catch(() => {})
      return
    }
    session.closing = true
    session.closed = true
    this.clearIdleTimer(session)
    this.clearWakeupTimers(session)
    if (session.activeWakeup !== undefined) {
      session.activeWakeup.settle()
      session.activeWakeup = undefined
    }
    await closeSubprocess(session.child)
  }

  protected async probeAcpCatalog(
    subprocess: SubprocessRuntime,
    executablePath: string,
    cwd: string = homedir(),
    signal?: AbortSignal,
  ): Promise<{
    readonly models: readonly AgentModelOption[]
    readonly reasoning?: AgentReasoning
    readonly commands: readonly AgentCommandOption[]
  }> {
    const child = subprocess.spawn({
      argv: [executablePath, ...this.buildProbeSpawnArgs()],
      cwd,
      env: buildExternalSubprocessEnv(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
      graceMs: 1_500,
      ...(signal === undefined ? {} : { signal }),
    })
    let spawnError: unknown
    void child.done.catch((err) => {
      spawnError = err
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      await closeSubprocess(child)
      if (isExecFormatError(spawnError)) {
        throw explainExecFormatError(spawnError, executablePath)
      }
      return { models: [], commands: [] }
    }
    let commands: readonly AgentCommandOption[] = []
    let resolveCommands: (() => void) | undefined
    const commandsReady = new Promise<void>((resolve) => {
      resolveCommands = resolve
    })
    const app = createAcpClientApp({ name: `${this.clientName}-probe` })
      .onNotification(methods.client.session.update, async ({ params }) => {
        const extracted = extractAcpAvailableCommands(params.update)
        if (extracted.length > 0) {
          commands = extracted
          resolveCommands?.()
        }
      })
      .onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: 'cancelled' } }))
    const conn = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ))
    try {
      const timeoutSignal = AbortSignal.timeout(5_000)
      const created = await Promise.race([
        (async () => {
          await conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          })
          return await conn.agent.request(methods.agent.session.new, {
            cwd,
            mcpServers: [],
          })
        })(),
        new Promise<never>((_, reject) => {
          timeoutSignal.addEventListener('abort', () => reject(new Error('ACP probe timeout')), { once: true })
        }),
      ])
      if (commands.length === 0) {
        await Promise.race([
          commandsReady,
          new Promise<void>(resolve => setTimeout(resolve, 600)),
        ])
      }
      const extractedModels = extractModelsFromSessionResponse(created)
      const extractedReasoning = extractReasoningFromSessionResponse(created)
      const sid = typeof (created as { sessionId?: unknown }).sessionId === 'string'
        ? (created as { sessionId: string }).sessionId
        : undefined
      if (sid !== undefined) {
        await conn.agent.request('session/close' as never, { sessionId: sid } as never).catch(() => {})
      }
      return {
        models: extractedModels,
        ...(extractedReasoning === undefined ? {} : { reasoning: extractedReasoning }),
        commands,
      }
    } catch (error) {
      const execErr = isExecFormatError(spawnError) ? spawnError : error
      if (isExecFormatError(execErr)) {
        throw explainExecFormatError(execErr, executablePath)
      }
      return { models: [], commands: [] }
    } finally {
      await closeSubprocess(child)
    }
  }

  private async handleParsedUpdateEvents(
    session: PooledAcpSession,
    events: readonly ExternalTurnEvent[],
    hasUnknownShape = false,
  ): Promise<void> {
    if (hasUnknownShape) {
      session.onUnknownUpdate?.()
    }
    if (events.length === 0) return
    this.clearIdleTimer(session)

    for (const evt of events) {
      if (evt.type === 'tool_start') {
        session.inFlightTools.add(evt.callId)
      } else if (evt.type === 'tool_result') {
        session.inFlightTools.delete(evt.callId)
      }

      if (session.inPrompt && session.activeSink !== undefined) {
        await session.activeSink(evt)
        continue
      }

      if (session.activeWakeup !== undefined) {
        const waiter = session.activeWakeup
        if (evt.type === 'text_delta') {
          waiter.finalText += evt.delta
          waiter.sawProseAfterLastTool = true
        } else if (evt.type === 'text') {
          waiter.finalText += evt.text
          waiter.sawProseAfterLastTool = true
        } else if (evt.type === 'tool_start') {
          waiter.finalText = ''
          waiter.sawProseAfterLastTool = false
        }
        await waiter.onEvent(evt)
        this.refreshWakeupQuiescence(session)
        continue
      }

      session.asyncBuffer.push(evt)
      this.emitAsync(session.dshSessionId, evt)

      if (
        evt.type === 'thinking_delta'
        || evt.type === 'text_delta'
        || evt.type === 'text'
        || evt.type === 'tool_start'
      ) {
        if (session.wakeupGraceTimer !== undefined) {
          clearTimeout(session.wakeupGraceTimer)
          session.wakeupGraceTimer = undefined
        }
        if (!session.wakeupSignaled) {
          session.wakeupSignaled = true
          this.emitAsync(session.dshSessionId, { type: 'wakeup_ready' })
        }
      } else if (evt.type === 'tool_result' && session.inFlightTools.size === 0 && !session.wakeupSignaled) {
        if (session.wakeupGraceTimer === undefined) {
          session.wakeupGraceTimer = setTimeout(() => {
            session.wakeupGraceTimer = undefined
            if (!session.closed && !session.inPrompt && !session.wakeupSignaled) {
              session.wakeupSignaled = true
              this.emitAsync(session.dshSessionId, { type: 'wakeup_ready' })
            }
          }, this.wakeupGraceMs)
          session.wakeupGraceTimer.unref?.()
        }
      }
    }
  }

  private extractEventsFromUpdate(
    session: PooledAcpSession,
    update: Record<string, unknown>,
  ): { readonly events: readonly ExternalTurnEvent[]; readonly hasUnknownShape: boolean } {
    const kind = update.sessionUpdate
    const out: ExternalTurnEvent[] = []
    if (kind === 'agent_thought_chunk') {
      const content = update.content as AcpContentBlock | undefined
      const text = acpBlockText(content)
      if (text !== '') out.push({ type: 'thinking_delta', delta: text })
      const hasUnknownShape = content !== undefined && content.type !== 'text'
      return { events: out, hasUnknownShape }
    }
    if (kind === 'agent_message_chunk') {
      const content = update.content as AcpContentBlock | undefined
      const text = acpBlockText(content)
      if (text !== '') out.push({ type: 'text_delta', delta: text })
      const hasUnknownShape = content !== undefined && content.type !== 'text'
      return { events: out, hasUnknownShape }
    }
    if (kind === 'tool_call') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (callId !== '' && !session.startedToolIds.has(callId)) {
        session.startedToolIds.add(callId)
        out.push(extractAcpToolStartEvent(callId, update))
      }
      return { events: out, hasUnknownShape: false }
    }
    if (kind === 'tool_call_update') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (callId !== '') {
        if (!session.startedToolIds.has(callId)) {
          session.startedToolIds.add(callId)
          out.push(extractAcpToolStartEvent(callId, update))
        }
        const status = update.status
        if ((status === 'completed' || status === 'failed') && !session.finishedToolIds.has(callId)) {
          session.finishedToolIds.add(callId)
          const content = extractAcpToolContent(update.content as readonly ToolCallContent[] | undefined, update.rawOutput)
          out.push({
            type: 'tool_result',
            callId,
            content,
            isError: status === 'failed',
          })
        } else if (status === 'in_progress' || status === 'pending') {
          const summary = extractAcpToolContent(update.content as readonly ToolCallContent[] | undefined, update.rawOutput)
          out.push({
            type: 'tool_progress',
            callId,
            ...(typeof update.title === 'string' && update.title !== '' ? { title: update.title } : {}),
            ...(summary !== '' ? { summary } : {}),
          })
        }
      }
      return { events: out, hasUnknownShape: false }
    }
    const usageEvt = extractAcpUsageEvent(update)
    if (usageEvt !== undefined) {
      out.push(usageEvt)
      return { events: out, hasUnknownShape: false }
    }
    const hasUnknownShape = typeof kind !== 'string' || !BENIGN_ACP_UPDATE_KINDS.has(kind)
    return { events: out, hasUnknownShape }
  }

  private async createSessionConnection(
    subprocess: SubprocessRuntime,
    request: ExternalTurnRequest,
    mode: string,
    dshSessionId: string,
  ): Promise<PooledAcpSession> {
    const executablePath = await resolveAgentExecutable(subprocess, this.command, request.signal)
    const args = this.buildAcpSpawnArgs(request, mode)
    const child = subprocess.spawn({
      argv: [executablePath, ...args],
      cwd: request.cwd,
      env: buildExternalSubprocessEnv(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 100_000 } },
      graceMs: 3_000,
    })

    const rawMcpServers = request.mcpServers ?? []
    const mcpServers: AcpMcpServer[] = rawMcpServers.map(server => ({
      type: 'http' as const,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
    }))
    const mcpSignature = rawMcpServers.map(s => `${s.name}@${s.url}`).join(',')

    const advertisedModelIds = new Set<string>()
    const session: PooledAcpSession = {
      dshSessionId,
      cwd: request.cwd,
      mode,
      mcpSignature,
      executablePath,
      child,
      connection: undefined as never,
      supportsImage: true,
      advertisedModelIds,
      mcpServers: rawMcpServers,
      externalSessionId: '',
      permissionPolicy: request.permissionPolicy,
      ignoringLoadReplay: false,
      closed: false,
      closing: false,
      inPrompt: false,
      notifyQueue: Promise.resolve(),
      startedToolIds: new Set(),
      finishedToolIds: new Set(),
      inFlightTools: new Set(),
      asyncBuffer: [],
      wakeupSignaled: false,
    }

    if (child.stdin === undefined || child.stdout === undefined) {
      await closeSubprocess(child)
      throw new Error(`${this.command} acp subprocess did not expose stdio pipes`)
    }

    const app = createAcpClientApp({ name: this.clientName })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (session.ignoringLoadReplay) return
        const { events, hasUnknownShape } = this.extractEventsFromUpdate(
          session,
          params.update as unknown as Record<string, unknown>,
        )
        if (events.length === 0 && !hasUnknownShape) return
        session.notifyQueue = session.notifyQueue
          .then(() => this.handleParsedUpdateEvents(session, events, hasUnknownShape))
          .catch(() => {})
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        session.onPermissionActivity?.()
        if (this.shouldAllowPermission(params, session)) {
          const allowOption = params.options.find(opt => opt.kind === 'allow_once' || opt.kind === 'allow_always')
          if (allowOption !== undefined) {
            return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
          }
        }
        return { outcome: { outcome: 'cancelled' } }
      })

    const connection = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ))
    ;(session as { connection: typeof connection }).connection = connection

    void child.done.then((outcome) => {
      session.closed = true
      this.clearIdleTimer(session)
      this.clearWakeupTimers(session)
      if (this.pool.get(dshSessionId) === session) {
        this.pool.delete(dshSessionId)
      }
      if (session.activeWakeup !== undefined) {
        session.activeWakeup.settle()
        session.activeWakeup = undefined
      }
      if (!session.closing) {
        const reason = outcome.signal
          ? `terminated by signal ${outcome.signal}`
          : outcome.exitCode !== null && outcome.exitCode !== 0
            ? `exited with code ${outcome.exitCode}`
            : undefined
        this.emitAsync(dshSessionId, { type: 'process_exit', ...(reason === undefined ? {} : { reason }) })
      }
    }).catch((err) => {
      session.spawnError = err
      session.closed = true
      this.clearIdleTimer(session)
      this.clearWakeupTimers(session)
      if (this.pool.get(dshSessionId) === session) {
        this.pool.delete(dshSessionId)
      }
      if (session.activeWakeup !== undefined) {
        session.activeWakeup.reject(explainExecFormatError(err, executablePath))
        session.activeWakeup = undefined
      }
    })

    try {
      const initResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const agentCapabilities = (initResponse as {
        readonly agentCapabilities?: {
          readonly loadSession?: boolean
          readonly promptCapabilities?: { readonly image?: boolean }
        }
      })?.agentCapabilities
      ;(session as { supportsImage: boolean }).supportsImage = agentCapabilities?.promptCapabilities?.image !== false
      const supportsLoadSession = agentCapabilities?.loadSession !== false

      let activeSessionId: string | undefined
      let sessionResponse: unknown
      if (supportsLoadSession && request.externalSessionId !== undefined && request.externalSessionId !== '') {
        session.ignoringLoadReplay = true
        try {
          sessionResponse = await connection.agent.request(methods.agent.session.load, {
            sessionId: request.externalSessionId,
            cwd: request.cwd,
            mcpServers,
          })
          activeSessionId = request.externalSessionId
        } catch (loadErr) {
          if (request.signal.aborted) {
            throw request.signal.reason ?? new DOMException('Aborted', 'AbortError')
          }
          if (isAcpResumeRejectedError(loadErr)) {
            throw new ExternalResumeRejectedError(
              `${this.label} rejected resumed session "${request.externalSessionId}": ${formatAcpError(loadErr)}`,
              { cause: loadErr },
            )
          }
          if (!isAcpMethodNotFoundError(loadErr)) {
            throw new Error(
              `ACP session/load("${request.externalSessionId}") failed: ${formatAcpError(loadErr)}`,
              { cause: loadErr },
            )
          }
          activeSessionId = undefined
        } finally {
          session.ignoringLoadReplay = false
        }
      }

      if (activeSessionId === undefined) {
        const created = await connection.agent.request(methods.agent.session.new, {
          cwd: request.cwd,
          mcpServers,
        }) as { readonly sessionId: string }
        sessionResponse = created
        activeSessionId = created.sessionId
      }

      for (const model of extractModelsFromSessionResponse(sessionResponse)) {
        advertisedModelIds.add(model.id)
      }
      session.externalSessionId = activeSessionId
      return session
    } catch (error) {
      await this.disposePooledSession(session)
      if (isExecFormatError(session.spawnError)) {
        throw explainExecFormatError(session.spawnError, executablePath)
      }
      throw explainExecFormatError(error, executablePath)
    }
  }

  async runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome> {
    const mode = this.resolveTurnMode(request)
    const pooledKey = request.dshSessionId
    const isPersistent = pooledKey !== undefined && pooledKey !== ''

    const rawMcpServers = request.mcpServers ?? []
    const expectedMcpSignature = rawMcpServers.map(s => `${s.name}@${s.url}`).join(',')

    let session: PooledAcpSession | undefined
    if (isPersistent) {
      const existing = this.pool.get(pooledKey)
      if (existing !== undefined) {
        const matchesConfig = !existing.closed
          && !existing.closing
          && existing.cwd === request.cwd
          && existing.mode === mode
          && existing.mcpSignature === expectedMcpSignature
          && (
            request.externalSessionId === undefined
            || request.externalSessionId === ''
            || request.externalSessionId === existing.externalSessionId
          )
        if (matchesConfig) {
          session = existing
        } else {
          await this.closeSession(pooledKey)
        }
      }
      if (session === undefined) {
        session = await this.createSessionConnection(subprocess, request, mode, pooledKey)
        this.pool.set(pooledKey, session)
      }
    } else {
      session = await this.createSessionConnection(subprocess, request, mode, '__ephemeral__')
    }

    this.clearIdleTimer(session)
    this.clearWakeupTimers(session)
    session.wakeupSignaled = false
    session.permissionPolicy = request.permissionPolicy
    session.mcpServers = rawMcpServers

    if (session.asyncBuffer.length > 0) {
      const buffered = session.asyncBuffer
      session.asyncBuffer = []
      for (const evt of buffered) {
        await request.onEvent(evt)
      }
    }

    let deliverableText = ''
    let sawOutputText = false
    let sawThinking = false
    let sawToolOrPermission = false
    const usageAccumulator = new AcpUsageAccumulator()

    session.inPrompt = true
    session.onPermissionActivity = () => {
      sawToolOrPermission = true
    }
    session.onUnknownUpdate = () => {
      deliverableText = ''
    }
    session.activeSink = async (evt) => {
      if (evt.type === 'text_delta') {
        deliverableText += evt.delta
        sawOutputText = true
      } else if (evt.type === 'text') {
        deliverableText += evt.text
        sawOutputText = true
      } else if (evt.type === 'thinking_delta') {
        sawThinking = true
      } else if (evt.type === 'tool_start') {
        // Clear interim pre-tool narration so it can never be mistaken for the final answer.
        deliverableText = ''
        sawToolOrPermission = true
      } else if (evt.type === 'tool_result') {
        sawToolOrPermission = true
      } else if (evt.type === 'usage') {
        const merged = usageAccumulator.merge(evt)
        await request.onEvent({ type: 'usage', ...merged })
        return
      }
      await request.onEvent(evt)
    }

    const onAbort = (): void => {
      if (session === undefined) return
      if (session.externalSessionId !== '') {
        void session.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: session.externalSessionId,
        }).catch(() => {})
      }
      if (isPersistent) {
        void this.closeSession(pooledKey)
      } else {
        void this.disposePooledSession(session)
      }
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    try {
      await request.onEvent({ type: 'session', externalSessionId: session.externalSessionId })
      await this.applyTurnConfiguration(session, request, mode)

      const promptBlocks = buildAcpPromptBlocks(request.prompt, request.images, session.supportsImage)
      const promptResult = await session.connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.externalSessionId,
        prompt: promptBlocks,
      })

      await session.notifyQueue

      const responseUsage = extractAcpUsageEvent(promptResult)
      if (responseUsage !== undefined) {
        const merged = usageAccumulator.merge(responseUsage)
        await request.onEvent({ type: 'usage', ...merged })
      }

      if (request.signal.aborted || promptResult.stopReason === 'cancelled') {
        throw request.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (promptResult.stopReason === 'refusal') {
        const isResumedNoProgress =
          request.externalSessionId !== undefined
          && request.externalSessionId !== ''
          && !sawOutputText
          && !sawToolOrPermission
          && !sawThinking
        if (isResumedNoProgress) {
          throw new ExternalResumeRejectedError(
            `${this.label} refused resumed session "${request.externalSessionId}" with no activity`,
          )
        }
        throw new Error(`${this.label} refused to complete the request`)
      }

      const pendingToolCallIds = isPersistent ? [...session.inFlightTools] : undefined
      const hasEmptyCompletion =
        deliverableText.trim() === ''
        && !sawOutputText
        && !sawToolOrPermission
        && session.inFlightTools.size === 0
      if (hasEmptyCompletion) {
        const stderr = session.child.collected?.stderr?.readFrom(0).text.trim() ?? ''
        const stderrNote = stderr === '' ? '' : `: ${stderr.slice(-240)}`
        throw new Error(`${this.label} completed the turn with empty output and no tool activity${stderrNote}`)
      }

      return {
        externalSessionId: session.externalSessionId,
        finalText: deliverableText,
        terminalConfirmed: true,
        ...(pendingToolCallIds !== undefined && pendingToolCallIds.length > 0 ? { pendingToolCallIds } : {}),
      }
    } catch (error) {
      if (isPersistent) {
        await this.closeSession(pooledKey)
      }
      if (isExecFormatError(session.spawnError)) {
        throw explainExecFormatError(session.spawnError, session.executablePath)
      }
      throw explainExecFormatError(error, session.executablePath)
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      session.inPrompt = false
      session.activeSink = undefined
      session.onPermissionActivity = undefined
      session.onUnknownUpdate = undefined
      if (!isPersistent) {
        await this.disposePooledSession(session)
      } else if (!session.closed && session.inFlightTools.size === 0 && session.asyncBuffer.length === 0) {
        this.scheduleIdleClose(session, this.idleTtlMs)
      }
    }
  }

  async drainWakeupTurn(
    dshSessionId: string,
    signal: AbortSignal,
    onEvent: (event: ExternalTurnEvent) => void | Promise<void>,
  ): Promise<ExternalTurnOutcome> {
    const session = this.pool.get(dshSessionId)
    if (session === undefined || session.closed) {
      return { finalText: '', terminalConfirmed: true }
    }

    this.clearIdleTimer(session)
    this.clearWakeupTimers(session)
    session.wakeupSignaled = false

    const buffered = session.asyncBuffer
    session.asyncBuffer = []
    let sawProse = false
    let bufferedText = ''
    for (const evt of buffered) {
      if (evt.type === 'text_delta') {
        bufferedText += evt.delta
        sawProse = true
      } else if (evt.type === 'text') {
        bufferedText += evt.text
        sawProse = true
      } else if (evt.type === 'tool_start') {
        bufferedText = ''
        sawProse = false
      }
      await onEvent(evt)
    }

    let settled = false
    let settleWaiter!: () => void
    let rejectWaiter!: (error: unknown) => void
    const donePromise = new Promise<void>((resolve, reject) => {
      settleWaiter = () => {
        if (settled) return
        settled = true
        resolve()
      }
      rejectWaiter = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
    })

    const waiter: WakeupWaiter = {
      onEvent,
      sawProseAfterLastTool: sawProse,
      finalText: bufferedText,
      settle: settleWaiter,
      reject: rejectWaiter,
    }
    session.activeWakeup = waiter

    const onAbort = (): void => {
      if (session.externalSessionId !== '') {
        void session.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: session.externalSessionId,
        }).catch(() => {})
      }
      void this.closeSession(dshSessionId)
      rejectWaiter(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    this.refreshWakeupQuiescence(session)

    try {
      await donePromise
      await session.notifyQueue
      const pendingToolCallIds = [...session.inFlightTools]
      this.emitAsync(dshSessionId, { type: 'wakeup_settled' })
      return {
        externalSessionId: session.externalSessionId,
        finalText: waiter.finalText,
        terminalConfirmed: true,
        ...(pendingToolCallIds.length > 0 ? { pendingToolCallIds } : {}),
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (session.activeWakeup === waiter) {
        session.activeWakeup = undefined
      }
      if (session.wakeupQuiescenceTimer !== undefined) {
        clearTimeout(session.wakeupQuiescenceTimer)
        session.wakeupQuiescenceTimer = undefined
      }
      if (!session.closed && session.inFlightTools.size === 0 && session.asyncBuffer.length === 0) {
        this.scheduleIdleClose(session, this.postBgIdleTtlMs)
      }
    }
  }
}
