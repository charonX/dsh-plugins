/**
 * Antigravity (`agy`) adapter over ACP stdio (`agy acp --stdio`), with real-time
 * session/model probing, session/load resumption, persistent pooled connections
 * for background tasks & reactive wakeups, and tool_call / tool_call_update projection.
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
  type ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentCommandOption, AgentModelOption, AgentReasoning } from '../types.ts'
import {
  nonNegativeInt,
  normalizeCommandList,
  normalizeModelList,
  positiveInt,
  probeAgentVersion,
  resolveAgentExecutable,
  stringifyToolPayload,
  type ExternalAgentAdapter,
  type ExternalAsyncEvent,
  type ExternalImageInput,
  type ExternalPermissionPolicy,
  type ExternalProbeResult,
  type ExternalTurnEvent,
  type ExternalTurnOutcome,
  type ExternalTurnRequest,
} from './base.ts'

const DEFAULT_AGY_MODELS: readonly AgentModelOption[] = [
  { id: 'default', name: 'Default (Antigravity default)' },
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
]

/** Fallback effort levels matching `agy --effort`; ACP `thought_level` options override them. */
export const AGY_REASONING: AgentReasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra High' },
    { id: 'max', name: 'Max' },
  ],
}

/** ACP config option ids that carry the session's thinking level across agent versions. */
const THOUGHT_LEVEL_CONFIG_IDS = ['thought_level', 'reasoning_effort', 'effort', 'thinking'] as const

const DEFAULT_IDLE_TTL_MS = 60_000
const DEFAULT_POST_BG_IDLE_TTL_MS = 15_000
const DEFAULT_WAKEUP_GRACE_MS = 20_000
const DEFAULT_WAKEUP_QUIESCENCE_MS = 2_500

export interface AgyAdapterOptions {
  /** Idle TTL before closing a pooled ACP subprocess when no background tasks remain. */
  readonly idleTtlMs?: number
  /** Idle TTL after a background wakeup turn settles with no open tasks. */
  readonly postBgIdleTtlMs?: number
  /** How long to wait after all background tools finish for ACP reactive wakeup text before falling back. */
  readonly wakeupGraceMs?: number
  /** Quiet window after wakeup output chunks before marking a reactive wakeup turn complete. */
  readonly wakeupQuiescenceMs?: number
}

function acpBlockText(content: AcpContentBlock | undefined): string {
  if (content === undefined) return ''
  return content.type === 'text' ? content.text : ''
}

function extractAcpToolContent(content: readonly ToolCallContent[] | undefined, rawOutput: unknown): string {
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

function extractAcpToolStartEvent(
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

function extractModelsFromSessionResponse(response: unknown): readonly AgentModelOption[] {
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

/** Extract Antigravity ACP `session/new` `configOptions` thinking levels when advertised. */
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

/** Extract ACP `usage_update` / `state_update.usage` / `PromptResponse.usage` into a usage event. */
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
  const usageObj = rec.sessionUpdate === 'state_update'
    ? (typeof rec.usage === 'object' && rec.usage !== null ? rec.usage as Record<string, unknown> : undefined)
    : rec
  if (usageObj === undefined) return undefined
  const inputTokens = nonNegativeInt(usageObj.inputTokens ?? usageObj.input_tokens)
  const outputTokens = nonNegativeInt(usageObj.outputTokens ?? usageObj.output_tokens)
  const reasoningTokens = nonNegativeInt(usageObj.thoughtTokens ?? usageObj.reasoningTokens)
  const cacheReadTokens = nonNegativeInt(usageObj.cachedReadTokens ?? usageObj.cacheReadTokens)
  const cacheWriteTokens = nonNegativeInt(usageObj.cachedWriteTokens ?? usageObj.cacheWriteTokens)
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && reasoningTokens === undefined
    && cacheReadTokens === undefined
    && cacheWriteTokens === undefined
  ) {
    return undefined
  }
  return {
    type: 'usage',
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    isTurnTotal: true,
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

/** Extract Antigravity ACP `available_commands_update` command descriptors. */
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

async function closeSubprocess(handle: SubprocessHandle): Promise<void> {
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

export const AGY_PERMISSION_MODES = [
  { id: 'accept-edits', name: 'Accept Edits', description: 'Approve workspace file edits automatically' },
  { id: 'auto', name: 'Auto', description: 'Approve safe commands and edits; block risky operations' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning without workspace modifications' },
  { id: 'default', name: 'Default', description: 'Default mode (deny unapproved operations in unattended runs)' },
  { id: 'bypass', name: 'Bypass Permissions', description: 'Skip all permission prompts' },
] as const

interface WakeupWaiter {
  onEvent: (event: ExternalTurnEvent) => void | Promise<void>
  sawProseAfterLastTool: boolean
  finalText: string
  settle: () => void
  reject: (error: unknown) => void
}

interface PooledAgySession {
  readonly dshSessionId: string
  readonly cwd: string
  readonly mode: string
  readonly mcpSignature: string
  readonly child: SubprocessHandle
  readonly connection: ReturnType<ReturnType<typeof createAcpClientApp>['connect']>
  readonly supportsImage: boolean
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
}

export class AgyAdapter implements ExternalAgentAdapter {
  readonly id = 'agy' as const
  readonly label = 'Antigravity'
  readonly command = 'agy'
  readonly permissionModes = AGY_PERMISSION_MODES
  readonly reasoning = AGY_REASONING
  readonly defaultPermissionMode = 'accept-edits'

  private readonly idleTtlMs: number
  private readonly postBgIdleTtlMs: number
  private readonly wakeupGraceMs: number
  private readonly wakeupQuiescenceMs: number
  private readonly pool = new Map<string, PooledAgySession>()
  private readonly asyncListeners = new Map<string, Set<(event: ExternalAsyncEvent) => void>>()

  constructor(
    private readonly configuredModels: readonly AgentModelOption[] = [],
    options: AgyAdapterOptions = {},
  ) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.postBgIdleTtlMs = options.postBgIdleTtlMs ?? DEFAULT_POST_BG_IDLE_TTL_MS
    this.wakeupGraceMs = options.wakeupGraceMs ?? DEFAULT_WAKEUP_GRACE_MS
    this.wakeupQuiescenceMs = options.wakeupQuiescenceMs ?? DEFAULT_WAKEUP_QUIESCENCE_MS
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

  private clearIdleTimer(session: PooledAgySession): void {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer)
      session.idleTimer = undefined
    }
  }

  private clearWakeupTimers(session: PooledAgySession): void {
    if (session.wakeupGraceTimer !== undefined) {
      clearTimeout(session.wakeupGraceTimer)
      session.wakeupGraceTimer = undefined
    }
    if (session.wakeupQuiescenceTimer !== undefined) {
      clearTimeout(session.wakeupQuiescenceTimer)
      session.wakeupQuiescenceTimer = undefined
    }
  }

  private scheduleIdleClose(session: PooledAgySession, delayMs: number): void {
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

  private refreshWakeupQuiescence(session: PooledAgySession): void {
    if (session.closed || session.closing || session.inPrompt) return
    const waiter = session.activeWakeup
    if (waiter === undefined) return
    if (session.wakeupQuiescenceTimer !== undefined) {
      clearTimeout(session.wakeupQuiescenceTimer)
      session.wakeupQuiescenceTimer = undefined
    }
    // Keep Turn 2 open while a newly opened synchronous tool has not emitted follow-up prose yet.
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

  private async disposePooledSession(session: PooledAgySession): Promise<void> {
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

  async probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult> {
    let executablePath: string
    try {
      executablePath = await resolveAgentExecutable(subprocess, this.command, signal)
    } catch (error) {
      return {
        available: false,
        command: this.command,
        reason: error instanceof Error ? error.message : String(error),
        models: normalizeModelList(this.configuredModels.length > 0 ? this.configuredModels : DEFAULT_AGY_MODELS),
        defaultModel: 'default',
        reasoning: AGY_REASONING,
        defaultPermissionMode: this.defaultPermissionMode,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }

    const version = await probeAgentVersion(subprocess, executablePath)
    let discovered: {
      readonly models: readonly AgentModelOption[]
      readonly reasoning?: AgentReasoning
      readonly commands: readonly AgentCommandOption[]
    } = {
      models: [],
      commands: [],
    }
    try {
      discovered = await this.probeAcpCatalog(subprocess, executablePath, signal)
    } catch {
      // Fall back cleanly to defaults if ACP catalog query cannot connect offline.
    }
    const merged = normalizeModelList([
      ...this.configuredModels,
      ...(discovered.models.length > 0 ? discovered.models : DEFAULT_AGY_MODELS),
    ])
    return {
      available: true,
      command: this.command,
      executablePath,
      ...(version === undefined ? {} : { version }),
      models: merged,
      defaultModel: 'default',
      reasoning: discovered.reasoning ?? AGY_REASONING,
      defaultPermissionMode: this.defaultPermissionMode,
      permissionModes: this.permissionModes,
      commands: discovered.commands,
    }
  }

  private async probeAcpCatalog(
    subprocess: SubprocessRuntime,
    executablePath: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly models: readonly AgentModelOption[]
    readonly reasoning?: AgentReasoning
    readonly commands: readonly AgentCommandOption[]
  }> {
    const child = subprocess.spawn({
      argv: [executablePath, 'acp', '--stdio'],
      cwd: homedir(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
      graceMs: 1_500,
      ...(signal === undefined ? {} : { signal }),
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      await closeSubprocess(child)
      return { models: [], commands: [] }
    }
    let commands: readonly AgentCommandOption[] = []
    let resolveCommands: (() => void) | undefined
    const commandsReady = new Promise<void>((resolve) => {
      resolveCommands = resolve
    })
    const app = createAcpClientApp({ name: 'dsh-external-agents-probe' })
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
            cwd: homedir(),
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
    } catch {
      return { models: [], commands: [] }
    } finally {
      await closeSubprocess(child)
    }
  }

  private async handleParsedUpdateEvents(
    session: PooledAgySession,
    events: readonly ExternalTurnEvent[],
  ): Promise<void> {
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
          waiter.sawProseAfterLastTool = false
        }
        await waiter.onEvent(evt)
        this.refreshWakeupQuiescence(session)
        continue
      }

      // Between turns (background execution or awaiting reactive wakeup): buffer for Turn 2 and notify live subscribers.
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
    session: PooledAgySession,
    update: Record<string, unknown>,
  ): readonly ExternalTurnEvent[] {
    const kind = update.sessionUpdate
    const out: ExternalTurnEvent[] = []
    if (kind === 'agent_thought_chunk') {
      const text = acpBlockText(update.content as AcpContentBlock | undefined)
      if (text !== '') out.push({ type: 'thinking_delta', delta: text })
    } else if (kind === 'agent_message_chunk') {
      const text = acpBlockText(update.content as AcpContentBlock | undefined)
      if (text !== '') out.push({ type: 'text_delta', delta: text })
    } else if (kind === 'tool_call') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      if (callId !== '' && !session.startedToolIds.has(callId)) {
        session.startedToolIds.add(callId)
        out.push(extractAcpToolStartEvent(callId, update))
      }
    } else if (kind === 'tool_call_update') {
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
    } else {
      const usageEvt = extractAcpUsageEvent(update)
      if (usageEvt !== undefined) out.push(usageEvt)
    }
    return out
  }

  private async createSessionConnection(
    subprocess: SubprocessRuntime,
    request: ExternalTurnRequest,
    mode: string,
    dshSessionId: string,
  ): Promise<PooledAgySession> {
    const executablePath = await resolveAgentExecutable(subprocess, this.command, request.signal)
    const args = ['acp', '--stdio']
    if (mode === 'bypass') {
      args.push('--dangerously-skip-permissions')
    }
    const child = subprocess.spawn({
      argv: [executablePath, ...args],
      cwd: request.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 100_000 } },
      graceMs: 3_000,
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      await closeSubprocess(child)
      throw new Error('agy acp subprocess did not expose stdio pipes')
    }

    const rawMcpServers = request.mcpServers ?? []
    const mcpServers: AcpMcpServer[] = rawMcpServers.map(server => ({
      type: 'http' as const,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
    }))
    const mcpSignature = rawMcpServers.map(s => `${s.name}@${s.url}`).join(',')

    const session: PooledAgySession = {
      dshSessionId,
      cwd: request.cwd,
      mode,
      mcpSignature,
      child,
      connection: undefined as never,
      supportsImage: true,
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

    const app = createAcpClientApp({ name: 'dsh-external-agents' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (session.ignoringLoadReplay) return
        const events = this.extractEventsFromUpdate(session, params.update as unknown as Record<string, unknown>)
        if (events.length === 0) return
        session.notifyQueue = session.notifyQueue
          .then(() => this.handleParsedUpdateEvents(session, events))
          .catch(() => {})
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const allowKind = params.toolCall.kind
        const rawToolName = typeof (params.toolCall as { readonly name?: unknown }).name === 'string'
          ? (params.toolCall as { readonly name: string }).name
          : ''
        const toolTitle = typeof params.toolCall.title === 'string' ? params.toolCall.title : ''
        const isDshManagerMcp = rawToolName.startsWith('mcp_dsh-manager_') || toolTitle.startsWith('mcp_dsh-manager_')
        const isReadOnlyManagerMcp = isDshManagerMcp && (
          rawToolName.endsWith('board_summary')
          || toolTitle.endsWith('board_summary')
          || rawToolName.endsWith('team_config_get')
          || toolTitle.endsWith('team_config_get')
        )
        const shouldAllow = mode === 'bypass'
          || mode === 'auto'
          || (mode === 'accept-edits' && (
            allowKind === 'edit' || allowKind === 'read' || allowKind === 'search' || allowKind === 'think' || isDshManagerMcp
          ))
          || (mode === 'plan' && (allowKind === 'read' || allowKind === 'search' || allowKind === 'think' || isReadOnlyManagerMcp))
        if (shouldAllow && session.permissionPolicy !== 'reject') {
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
    }).catch(() => {})

    try {
      const initResponse = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      ;(session as { supportsImage: boolean }).supportsImage =
        (initResponse as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } })
          ?.agentCapabilities?.promptCapabilities?.image !== false

      let activeSessionId: string | undefined
      if (request.externalSessionId !== undefined && request.externalSessionId !== '') {
        session.ignoringLoadReplay = true
        try {
          await connection.agent.request(methods.agent.session.load, {
            sessionId: request.externalSessionId,
            cwd: request.cwd,
            mcpServers,
          })
          activeSessionId = request.externalSessionId
        } catch {
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
        activeSessionId = created.sessionId
      }

      session.externalSessionId = activeSessionId
      return session
    } catch (error) {
      await this.disposePooledSession(session)
      throw error
    }
  }

  async runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome> {
    const mode = request.permissionMode ?? (request.permissionPolicy === 'allow' ? this.defaultPermissionMode : 'default')
    const pooledKey = request.dshSessionId
    const isPersistent = pooledKey !== undefined && pooledKey !== ''

    const expectedMcpSignature = (request.mcpServers ?? []).map(s => `${s.name}@${s.url}`).join(',')

    let session: PooledAgySession | undefined
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

    // Flush any buffered async completion events that finished just before this manual follow-up.
    if (session.asyncBuffer.length > 0) {
      const buffered = session.asyncBuffer
      session.asyncBuffer = []
      for (const evt of buffered) {
        await request.onEvent(evt)
      }
    }

    let finalText = ''
    session.inPrompt = true
    session.activeSink = async (evt) => {
      if (evt.type === 'text_delta') finalText += evt.delta
      else if (evt.type === 'text') finalText += evt.text
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

      if (mode !== 'bypass' && session.lastModeApplied !== mode) {
        await session.connection.agent.request(methods.agent.session.setMode, {
          sessionId: session.externalSessionId,
          modeId: mode,
        }).catch(() => {})
        session.lastModeApplied = mode
      }

      if (
        request.model !== undefined
        && request.model !== ''
        && request.model !== 'default'
        && session.lastModelApplied !== request.model
      ) {
        await session.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.externalSessionId,
          configId: 'model',
          value: request.model,
        }).catch(() => {})
        session.lastModelApplied = request.model
      }

      if (
        request.reasoningEffort !== undefined
        && request.reasoningEffort !== ''
        && session.lastReasoningApplied !== request.reasoningEffort
      ) {
        await session.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.externalSessionId,
          configId: 'thought_level',
          value: request.reasoningEffort,
        }).catch(() => {})
        session.lastReasoningApplied = request.reasoningEffort
      }

      const promptBlocks = buildAcpPromptBlocks(request.prompt, request.images, session.supportsImage)
      const promptResult = await session.connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.externalSessionId,
        prompt: promptBlocks,
      })

      await session.notifyQueue

      const responseUsage = extractAcpUsageEvent((promptResult as { usage?: unknown }).usage)
      if (responseUsage !== undefined) {
        await request.onEvent(responseUsage)
      }

      if (request.signal.aborted || promptResult.stopReason === 'cancelled') {
        throw request.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (promptResult.stopReason === 'refusal') {
        throw new Error('Antigravity refused to complete the request')
      }

      const pendingToolCallIds = isPersistent ? [...session.inFlightTools] : undefined
      return {
        externalSessionId: session.externalSessionId,
        finalText,
        ...(pendingToolCallIds !== undefined && pendingToolCallIds.length > 0 ? { pendingToolCallIds } : {}),
      }
    } catch (error) {
      if (isPersistent) {
        await this.closeSession(pooledKey)
      }
      throw error
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      session.inPrompt = false
      session.activeSink = undefined
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
      return { finalText: '' }
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
