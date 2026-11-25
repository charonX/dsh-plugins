/**
 * Intercepts `agent/pre-step` for sessions bound to a third-party agent, drives
 * the external CLI/ACP turn, projects native DSH streaming frames + durable
 * `tool/call` / `tool/result` / `assistant/message` / `step/*` session events,
 * and closes the ReactLoopAgent turn cleanly without invoking DSH's own LLM or tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent, type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  boundContextSummary,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type AssistantStreamRecord,
  type ContentBlock,
  type LlmAttemptId,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { estimateTokensFromText, resolveFallbackContextWindow } from './context-windows.ts'
import {
  agentIdFromPreset,
  agentIdFromProvider,
  type ExternalAgentId,
} from './types.ts'
import type {
  ExternalAgentAdapter,
  ExternalAsyncEvent,
  ExternalImageInput,
  ExternalMcpServerConfig,
  ExternalPermissionPolicy,
  ExternalTurnEvent,
  ExternalTurnOutcome,
  ExternalUsageReport,
} from './adapters/index.ts'
import type { ExternalSessionStore } from './session-store.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'external-wakeup': {
      readonly kind: 'external-wakeup'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

const IMMEDIATE_TASK_TOOL_RE = /^(?:agent|task|subagent|invoke_subagent|swarm|schedule)$/iu

interface BackgroundToolMeta {
  readonly callId: string
  readonly name: string
  readonly toolName?: string
  readonly title?: string
  readonly arguments: string
  readonly startedAt: number
}

interface BgCoordinator {
  unsubscribe?: () => void
  wakeupQueued: boolean
  pendingWakeupAfterRun: boolean
  readonly backgroundMeta: Map<string, BackgroundToolMeta>
}

function taskLabelForTool(name: string, toolName?: string, subagentType?: string): string {
  if (subagentType !== undefined && subagentType !== '') return subagentType
  const raw = (toolName ?? name).trim()
  if (raw === 'run_command') return 'Command'
  if (raw === 'schedule') return 'Timer'
  if (raw !== '') return raw
  return 'Task'
}

function taskDescriptionForTool(name: string, argumentsJson: string, title?: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>
    for (const key of ['description', 'toolSummary', 'ToolSummary', 'CommandLine', 'command', 'Prompt', 'title']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  } catch {
    // Ignore non-JSON args.
  }
  return title !== undefined && title !== '' ? title : name
}

function taskSubagentTypeForTool(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>
    if (typeof parsed.subagent_type === 'string' && parsed.subagent_type !== '') {
      return parsed.subagent_type
    }
  } catch {
    // Ignore non-JSON args.
  }
  return undefined
}

function createWakeupUserMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: '' }],
    source: {
      kind: 'external-wakeup',
      form: 'notice',
      summary: boundContextSummary('Background task update'),
    },
  })
}

interface AgentStreamCounter {
  attempt: number
  revision: number
}

class LiveExternalAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private readonly attemptId: LlmAttemptId
  private index = 0
  private started = false
  private ended = false
  private currentTextIndex: number | undefined
  private currentThinkingIndex: number | undefined
  private nextBlockIndex = 0

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly turn: number,
    private readonly step: number,
    private readonly counters: AgentStreamCounter,
  ) {
    this.attemptId = brandString<LlmAttemptId>(`${agent.id}:${++counters.attempt}`)
  }

  private emitFrame(frame: AssistantStreamFrame): void {
    emitAgentEvent(this.ctx, this.agent, 'agent/assistant-stream', { frame })
  }

  ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.emitFrame({
      type: 'start',
      attemptId: this.attemptId,
      revision: ++this.counters.revision,
      turn: this.turn,
      step: this.step,
    })
  }

  pushChunk(chunk: StreamChunk): void {
    this.ensureStarted()
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emitFrame({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.counters.revision,
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  pushThinkingDelta(delta: string): void {
    if (delta === '') return
    if (this.currentThinkingIndex === undefined) {
      this.closeOpenTextBlock()
      const idx = this.nextBlockIndex++
      this.currentThinkingIndex = idx
      this.pushChunk({ type: 'block-start', index: idx, blockType: 'reasoning' })
    }
    this.pushChunk({ type: 'reasoning-delta', index: this.currentThinkingIndex, text: delta })
  }

  pushTextDelta(delta: string): void {
    if (delta === '') return
    if (this.currentTextIndex === undefined) {
      this.closeOpenThinkingBlock()
      const idx = this.nextBlockIndex++
      this.currentTextIndex = idx
      this.pushChunk({ type: 'block-start', index: idx, blockType: 'text' })
    }
    this.pushChunk({ type: 'text-delta', index: this.currentTextIndex, text: delta })
  }

  private closeOpenThinkingBlock(): void {
    if (this.currentThinkingIndex === undefined) return
    const idx = this.currentThinkingIndex
    this.currentThinkingIndex = undefined
    const existing = this.assembler.interruptedBlocks().find((_, pos) => pos === idx)
    const text = existing?.type === 'reasoning' ? existing.text : ''
    this.pushChunk({ type: 'block-end', index: idx, block: { type: 'reasoning', text } })
  }

  private closeOpenTextBlock(): void {
    if (this.currentTextIndex === undefined) return
    const idx = this.currentTextIndex
    this.currentTextIndex = undefined
    const existing = this.assembler.interruptedBlocks().find((_, pos) => pos === idx)
    const text = existing?.type === 'text' ? existing.text : ''
    this.pushChunk({ type: 'block-end', index: idx, block: { type: 'text', text } })
  }

  closeNarrativeBlocks(): void {
    this.closeOpenThinkingBlock()
    this.closeOpenTextBlock()
  }

  hasAnyOutput(): boolean {
    return this.started
  }

  isEnded(): boolean {
    return this.ended
  }

  blocksForPersistence(): ContentBlock[] {
    this.closeNarrativeBlocks()
    return this.assembler.interruptedBlocks()
  }

  finishAndAppendMessage(
    provider: string,
    model: string,
    extraToolBlocks: readonly ContentBlock[] = [],
    interrupted = false,
    usage?: TokenUsage,
  ): SessionSeq {
    this.closeNarrativeBlocks()
    const blocks: ContentBlock[] = [...this.blocksForPersistence(), ...extraToolBlocks]
    if (usage !== undefined && this.started) {
      this.pushChunk({ type: 'usage', usage })
    }
    if (this.started) {
      this.pushChunk({
        type: 'finish',
        reason: extraToolBlocks.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
      })
    }
    const message = createAssistantMessage({
      content: blocks,
      source: { provider, model },
    })
    const seq = this.agent.session.append('assistant/message', {
      turn: this.turn,
      step: this.step,
      message,
      stream: [...this.accumulator.snapshot()] as AssistantStreamRecord[],
      ...(usage === undefined ? {} : { usage }),
      ...(interrupted ? { interrupted: true as const } : {}),
    }, { surfaceOp: 'append' }).seq
    const wasStarted = this.started
    const wasEnded = this.ended
    this.ended = true
    if (wasStarted && !wasEnded) {
      this.emitFrame({
        type: 'end',
        attemptId: this.attemptId,
        revision: this.counters.revision,
        index: this.index,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq },
      })
    }
    return seq
  }

  abandonIfStarted(): void {
    if (!this.started || this.ended) return
    this.ended = true
    this.emitFrame({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.counters.revision,
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }
}

export function extractUserPrompt(messages: readonly UserMessage[]): string {
  const sections: string[] = []
  for (const message of messages) {
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(block.text)
      } else if (block.type === 'image') {
        parts.push(`[image attachment: ${block.attachment.mediaType}]`)
      } else if (block.type === 'file') {
        parts.push(`[file attachment: ${block.attachment.name}]`)
      }
    }
    const text = parts.join('\n').trim()
    if (text !== '') sections.push(text)
  }
  return sections.join('\n\n')
}

export async function extractUserTurnPayload(
  messages: readonly UserMessage[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<{ readonly prompt: string; readonly images: readonly ExternalImageInput[] }> {
  const sections: string[] = []
  const images: ExternalImageInput[] = []
  for (const message of messages) {
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(block.text)
      } else if (block.type === 'image') {
        if (attachments !== undefined) {
          try {
            const stored = await attachments.readImage(block.attachment, signal)
            const hostPath = attachments.imageHostPath(block.attachment)
            images.push({
              mediaType: stored.ref.mediaType,
              base64: Buffer.from(stored.data).toString('base64'),
              ...(hostPath === undefined ? {} : { hostPath }),
              ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
              width: stored.ref.width,
              height: stored.ref.height,
            })
            continue
          } catch {
            // Fall through to text placeholder if attachment bytes cannot be read.
          }
        }
        parts.push(`[image attachment: ${block.attachment.mediaType}]`)
      } else if (block.type === 'file') {
        const hostPath = attachments?.fileHostPath(block.attachment)
        parts.push(
          hostPath !== undefined
            ? `[file attachment: ${block.attachment.name} (${hostPath})]`
            : `[file attachment: ${block.attachment.name}]`,
        )
      }
    }
    const text = parts.join('\n').trim()
    if (text !== '') sections.push(text)
  }
  return {
    prompt: sections.join('\n\n'),
    images,
  }
}

export interface TurnDriverDeps {
  readonly ctx: Context
  readonly adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter>
  readonly store: ExternalSessionStore
  readonly getSubprocess: () => SubprocessRuntime | undefined
  readonly getPermissionPolicy: () => ExternalPermissionPolicy
  readonly resolvePresetForSession: (agent: Agent) => string | null
  readonly getModelContextWindow?: (agentId: ExternalAgentId, model: string) => number | undefined
  readonly resolveMcpServers?: (dshSessionId: string) => Promise<readonly ExternalMcpServerConfig[]>
}

/**
 * Resolve which external agent (if any) owns this session:
 * explicit store binding takes priority, then `AgentPreset` binding (`ext-*`),
 * and finally an unpresetted `ext-*` model selection (for automated/headless tasks).
 */
export function resolveSessionExternalAgent(
  agent: Agent,
  store: ExternalSessionStore,
  resolvePresetForSession: (agent: Agent) => string | null,
  modelProvider?: string,
): ExternalAgentId | undefined {
  const binding = store.get(agent.id)
  if (binding !== undefined) {
    return binding.agentId === 'native' ? undefined : binding.agentId
  }
  const preset = resolvePresetForSession(agent)
  const fromPreset = agentIdFromPreset(preset)
  if (fromPreset !== undefined) return fromPreset
  if (preset === null) {
    const fromModel = agentIdFromProvider(modelProvider)
    if (fromModel !== undefined) {
      store.setAgent(agent.id, fromModel)
      return fromModel
    }
  }
  return undefined
}

export function installExternalTurnDriver(deps: TurnDriverDeps): () => void {
  const countersByAgent = new WeakMap<Agent, AgentStreamCounter>()
  const coordinators = new Map<string, BgCoordinator>()
  const settledExternalTurns = new WeakMap<Agent, Set<number>>()
  const guardedAgents = new WeakSet<Agent>()
  const guardDisposers = new Set<() => void>()

  const markTurnSettled = (agent: Agent, turn: number): void => {
    let turns = settledExternalTurns.get(agent)
    if (turns === undefined) {
      turns = new Set<number>()
      settledExternalTurns.set(agent, turns)
    }
    turns.add(turn)
  }

  const installOuterGuard = (agent: Agent): void => {
    if (guardedAgents.has(agent) || typeof agent.ctx?.on !== 'function') return
    guardedAgents.add(agent)
    // Register after preset setup (`agent/created`) with `prepend: true` so
    // preset `agent/pre-step` wrappers (`time-context`, `tool-skill`, etc.)
    // cannot re-populate `decision.messages` after `external-agents` already
    // finished the turn and trigger a stray DSH `llm.stream()` on `ext-*`.
    const disposeGuard = agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const turns = settledExternalTurns.get(payload.agent)
      if (decision.kind === 'enter' && turns?.has(payload.turn)) {
        turns.delete(payload.turn)
        return { kind: 'enter', messages: [] }
      }
      return decision
    }, { prepend: true })
    guardDisposers.add(disposeGuard)
  }

  for (const existing of deps.ctx.agents?.list?.() ?? []) {
    installOuterGuard(existing)
  }

  const disposeCreatedObserver = deps.ctx.on('agent/created', ({ agent }) => {
    installOuterGuard(agent)
  }, { global: true })

  const getCounter = (agent: Agent): AgentStreamCounter => {
    let entry = countersByAgent.get(agent)
    if (entry === undefined) {
      entry = { attempt: 0, revision: 0 }
      countersByAgent.set(agent, entry)
    }
    return entry
  }

  const getCoordinator = (sessionId: string): BgCoordinator => {
    let coord = coordinators.get(sessionId)
    if (coord === undefined) {
      coord = {
        wakeupQueued: false,
        pendingWakeupAfterRun: false,
        backgroundMeta: new Map(),
      }
      coordinators.set(sessionId, coord)
    }
    return coord
  }

  const scheduleWakeupIfReady = (agent: Agent, coord: BgCoordinator): void => {
    if (coord.wakeupQueued || deps.store.isRunning(agent.id)) return
    coord.wakeupQueued = true
    coord.pendingWakeupAfterRun = false
    try {
      agent.followup(createWakeupUserMessage())
    } catch {
      coord.wakeupQueued = false
    }
  }

  const ensureSubscribed = (agent: Agent, adapter: ExternalAgentAdapter, coord: BgCoordinator): void => {
    if (coord.unsubscribe !== undefined || adapter.subscribeBackground === undefined) return
    coord.unsubscribe = adapter.subscribeBackground(agent.id, (asyncEvt: ExternalAsyncEvent) => {
      if (asyncEvt.type === 'tool_progress') {
        deps.store.updateTask(agent.id, asyncEvt.callId, {
          ...(asyncEvt.title === undefined ? {} : { lastToolName: asyncEvt.title }),
          ...(asyncEvt.summary === undefined ? {} : { summary: asyncEvt.summary }),
        })
        return
      }
      if (asyncEvt.type === 'tool_result') {
        deps.store.updateTask(agent.id, asyncEvt.callId, {
          status: asyncEvt.isError ? 'failed' : 'completed',
          ...(asyncEvt.content !== '' ? { summary: asyncEvt.content.slice(0, 160) } : {}),
        })
        return
      }
      if (asyncEvt.type === 'wakeup_ready') {
        coord.pendingWakeupAfterRun = true
        scheduleWakeupIfReady(agent, coord)
        return
      }
      if (asyncEvt.type === 'process_exit') {
        for (const task of deps.store.getTasks(agent.id)) {
          if (task.status === 'running') {
            deps.store.updateTask(agent.id, task.taskId, {
              status: 'stopped',
              ...(asyncEvt.reason === undefined ? {} : { summary: asyncEvt.reason }),
            })
          }
        }
        deps.store.setBackgroundActive(agent.id, false)
        coord.backgroundMeta.clear()
      }
    })
  }

  const disposeAgentObserver = deps.ctx.on('agent/disposed', ({ agent }) => {
    const coord = coordinators.get(agent.id)
    if (coord !== undefined) {
      coord.unsubscribe?.()
      coord.backgroundMeta.clear()
      coordinators.delete(agent.id)
    }
  }, { global: true })

  const disposePreStep = deps.ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages, turn, signal, modelSelection } = payload
    const externalAgentId = resolveSessionExternalAgent(
      agent,
      deps.store,
      deps.resolvePresetForSession,
      modelSelection.provider,
    )

    // Guard native sessions from accidentally calling an `ext-*` placeholder model adapter.
    if (externalAgentId === undefined) {
      const modelAgent = agentIdFromProvider(modelSelection.provider)
      if (modelAgent !== undefined) {
        throw new Error(
          `Session is using DSH Native agent; model "${modelSelection.provider}/${modelSelection.model}" belongs to ${modelAgent}. Select a native model to continue.`,
        )
      }
      return next()
    }

    // Validate model compatibility when explicitly switched in an external session.
    const modelAgent = agentIdFromProvider(modelSelection.provider)
    if (modelAgent !== undefined && modelAgent !== externalAgentId) {
      throw new Error(
        `Session is locked to "${externalAgentId}" and cannot use "${modelSelection.provider}/${modelSelection.model}". Switch to a model under ext-${externalAgentId}.`,
      )
    }

    const adapter = deps.adapters.get(externalAgentId)
    if (adapter === undefined) {
      throw new Error(`External agent adapter "${externalAgentId}" is not registered`)
    }
    const subprocess = deps.getSubprocess()
    if (subprocess === undefined) {
      throw new Error('Subprocess runtime service is unavailable for external agents')
    }

    const realMessages = messages.filter(m => m.source.kind !== 'external-wakeup')
    const hasWakeupMarker = messages.some(m => m.source.kind === 'external-wakeup')

    const attachments = deps.ctx.get('attachments') as AttachmentStore | undefined
    const payloadData = await extractUserTurnPayload(realMessages, attachments, signal)
    const promptText = payloadData.prompt
    const promptImages = payloadData.images
    const isWakeupOnlyTurn = hasWakeupMarker && promptText === '' && promptImages.length === 0
    if (promptText === '' && promptImages.length === 0 && !isWakeupOnlyTurn) {
      // Nothing user-visible to dispatch; let the loop end the turn cleanly.
      markTurnSettled(agent, turn)
      return { kind: 'enter', messages: [] }
    }

    const coord = getCoordinator(agent.id)
    if (hasWakeupMarker) {
      coord.wakeupQueued = false
    }
    ensureSubscribed(agent, adapter, coord)

    const priorBinding = deps.store.get(agent.id)
    const releaseLock = deps.store.acquireRun(agent.id, priorBinding?.externalSessionId)
    const counters = getCounter(agent)
    const providerLabel = `ext-${externalAgentId}`
    const effectiveModel = modelAgent === externalAgentId ? modelSelection.model : 'default'
    const cwd = agent.session.header.cwd ?? process.cwd()

    let step = 1
    let stepOpen = false
    let attempt = new LiveExternalAttempt(deps.ctx, agent, turn, step, counters)
    let stepHasTools = false
    const pendingToolCalls = new Map<string, BackgroundToolMeta>()
    const toolStepByCallId = new Map<string, number>()
    const syntheticTaskCalls = new Map<string, string>()
    let fallbackText = ''
    let streamedNarrativeText = ''
    let latestUsage: ExternalUsageReport | undefined
    let latestContextWindow: number | undefined
    let latestContextUsed: number | undefined
    let lastAppendedContextWindow = agent.session.requestContext()?.contextWindow

    const syncRequestContextIfNeeded = (contextWindow: number | undefined): void => {
      if (contextWindow === undefined || contextWindow <= 0) return
      if (lastAppendedContextWindow === contextWindow) return
      lastAppendedContextWindow = contextWindow
      agent.session.append('request/context', {
        provider: providerLabel,
        model: effectiveModel,
        contextWindow,
      })
    }

    const upsertBackgroundTaskFromMeta = (meta: BackgroundToolMeta): void => {
      const subagentType = taskSubagentTypeForTool(meta.arguments)
      const label = taskLabelForTool(meta.name, meta.toolName, subagentType)
      const description = taskDescriptionForTool(meta.name, meta.arguments, meta.title)
      deps.store.upsertTask(agent.id, {
        taskId: meta.callId,
        toolUseId: meta.callId,
        label,
        description,
        ...(subagentType === undefined ? {} : { subagentType }),
        status: 'running',
        startedAt: meta.startedAt,
        updatedAt: Date.now(),
      })
    }

    const promoteOpenToolsToTasks = (excludeCallId?: string): void => {
      for (const [openId, meta] of pendingToolCalls) {
        if (openId === excludeCallId) continue
        if (deps.store.getTasks(agent.id).some(t => t.taskId === openId || t.toolUseId === openId)) continue
        upsertBackgroundTaskFromMeta(meta)
      }
    }

    const buildFinalUsage = (): TokenUsage => {
      if (latestUsage !== undefined) {
        const input = latestUsage.inputTokens > 0
          ? latestUsage.inputTokens
          : (latestContextUsed ?? 0)
        return {
          inputTokens: input,
          outputTokens: latestUsage.outputTokens,
          ...(latestUsage.cacheReadTokens === undefined ? {} : { cacheReadTokens: latestUsage.cacheReadTokens }),
          ...(latestUsage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: latestUsage.cacheWriteTokens }),
          ...(latestUsage.reasoningTokens === undefined ? {} : { reasoningTokens: latestUsage.reasoningTokens }),
        }
      }
      if (latestContextUsed !== undefined) {
        return {
          inputTokens: latestContextUsed,
          outputTokens: estimateTokensFromText(fallbackText),
        }
      }
      return {
        inputTokens: estimateTokensFromText(promptText) + promptImages.length * 256,
        outputTokens: estimateTokensFromText(fallbackText),
      }
    }

    const openStep = (nextStep: number): void => {
      step = nextStep
      stepOpen = true
      stepHasTools = false
      attempt = new LiveExternalAttempt(deps.ctx, agent, turn, step, counters)
    }

    const advanceToNextStep = (): void => {
      agent.session.append('step/end', { turn, step })
      stepOpen = false
      openStep(step + 1)
      agent.session.append('step/start', { turn, step })
      stepOpen = true
    }

    const ensureOpenNarrativeAttempt = (): void => {
      if (pendingToolCalls.size > 0) {
        promoteOpenToolsToTasks()
      }
      if (attempt.isEnded()) {
        advanceToNextStep()
      }
    }

    const ensureStepForToolStart = (): void => {
      if (attempt.isEnded() && pendingToolCalls.size === 0) {
        advanceToNextStep()
      }
    }

    const handleTurnEvent = async (event: ExternalTurnEvent): Promise<void> => {
      if (event.type === 'session') {
        deps.store.recordExternalSessionId(agent.id, externalAgentId, event.externalSessionId)
        return
      }
      if (event.type === 'usage') {
        if (event.contextWindow !== undefined) {
          latestContextWindow = event.contextWindow
          syncRequestContextIfNeeded(event.contextWindow)
        }
        if (event.contextUsedTokens !== undefined) {
          latestContextUsed = event.contextUsedTokens
        }
        const cacheRead = event.cacheReadTokens ?? latestUsage?.cacheReadTokens
        const cacheWrite = event.cacheWriteTokens ?? latestUsage?.cacheWriteTokens
        const reasoning = event.reasoningTokens ?? latestUsage?.reasoningTokens
        latestUsage = {
          inputTokens: event.inputTokens || latestUsage?.inputTokens || 0,
          outputTokens: event.outputTokens || latestUsage?.outputTokens || 0,
          ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
          ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
          ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
          ...(latestContextWindow === undefined ? {} : { contextWindow: latestContextWindow }),
          ...(latestContextUsed === undefined ? {} : { contextUsedTokens: latestContextUsed }),
        }
        return
      }
      if (event.type === 'task_started') {
        const now = Date.now()
        deps.store.upsertTask(agent.id, {
          taskId: event.taskId,
          ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
          label: event.subagentType ?? 'Subagent',
          description: event.description,
          ...(event.subagentType === undefined ? {} : { subagentType: event.subagentType }),
          status: 'running',
          startedAt: now,
          updatedAt: now,
        })
        if (event.toolUseId === undefined || !pendingToolCalls.has(event.toolUseId)) {
          ensureStepForToolStart()
          const syntheticId = `ext-task-${event.taskId}`
          syntheticTaskCalls.set(event.taskId, syntheticId)
          const brandedCallId = brandString<ToolCallId>(syntheticId)
          const argsJson = JSON.stringify({
            description: event.description,
            ...(event.subagentType === undefined ? {} : { subagent_type: event.subagentType }),
          })
          pendingToolCalls.set(syntheticId, {
            callId: syntheticId,
            name: 'subagent',
            toolName: 'subagent',
            arguments: argsJson,
            startedAt: now,
          })
          toolStepByCallId.set(syntheticId, step)
          if (!stepHasTools) {
            stepHasTools = true
            const toolBlock: ContentBlock = {
              type: 'tool-call',
              id: brandedCallId,
              name: 'subagent',
              arguments: argsJson,
            }
            attempt.finishAndAppendMessage(providerLabel, effectiveModel, [toolBlock], false)
          }
          agent.session.append('tool/call', {
            turn,
            step,
            callId: brandedCallId,
            name: 'subagent',
            arguments: argsJson,
          })
        }
        return
      }
      if (event.type === 'task_progress') {
        deps.store.updateTask(agent.id, event.taskId, {
          ...(event.description === undefined ? {} : { description: event.description }),
          ...(event.subagentType === undefined ? {} : { subagentType: event.subagentType }),
          ...(event.lastToolName === undefined ? {} : { lastToolName: event.lastToolName }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
          ...(event.toolUses === undefined ? {} : { toolUses: event.toolUses }),
        })
        return
      }
      if (event.type === 'task_completed') {
        deps.store.updateTask(agent.id, event.taskId, {
          status: event.status,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
          ...(event.toolUses === undefined ? {} : { toolUses: event.toolUses }),
        })
        const syntheticId = syntheticTaskCalls.get(event.taskId)
        if (syntheticId !== undefined) {
          syntheticTaskCalls.delete(event.taskId)
          if (pendingToolCalls.delete(syntheticId)) {
            const callStep = toolStepByCallId.get(syntheticId) ?? step
            toolStepByCallId.delete(syntheticId)
            const brandedCallId = brandString<ToolCallId>(syntheticId)
            const isError = event.status === 'failed'
            agent.session.append('tool/result', {
              turn,
              step: callStep,
              message: createToolResultMessage({
                callId: brandedCallId,
                content: event.summary ? [{ type: 'text', text: event.summary }] : [],
                isError,
              }),
              ...(isError ? { error: { name: 'ExternalTaskError', code: 'EXTERNAL_TASK_ERROR', reason: (event.summary ?? 'Task failed').slice(0, 200) } } : {}),
            }, { surfaceOp: 'append' })
          }
        }
        return
      }
      if (event.type === 'tool_progress') {
        deps.store.updateTask(agent.id, event.callId, {
          ...(event.title === undefined ? {} : { lastToolName: event.title }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        })
        return
      }
      if (event.type === 'thinking_delta') {
        ensureOpenNarrativeAttempt()
        attempt.pushThinkingDelta(event.delta)
        return
      }
      if (event.type === 'text_delta') {
        ensureOpenNarrativeAttempt()
        streamedNarrativeText += event.delta
        attempt.pushTextDelta(event.delta)
        return
      }
      if (event.type === 'text') {
        ensureOpenNarrativeAttempt()
        streamedNarrativeText += event.text
        attempt.pushTextDelta(event.text)
        return
      }
      if (event.type === 'tool_start') {
        ensureStepForToolStart()
        promoteOpenToolsToTasks(event.callId)
        const now = Date.now()
        const meta: BackgroundToolMeta = {
          callId: event.callId,
          name: event.name,
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          ...(event.title === undefined ? {} : { title: event.title }),
          arguments: event.arguments,
          startedAt: now,
        }
        const brandedCallId = brandString<ToolCallId>(event.callId)
        pendingToolCalls.set(event.callId, meta)
        toolStepByCallId.set(event.callId, step)
        if (IMMEDIATE_TASK_TOOL_RE.test(event.toolName ?? event.name)) {
          upsertBackgroundTaskFromMeta(meta)
        }
        if (!stepHasTools) {
          stepHasTools = true
          const toolBlock: ContentBlock = {
            type: 'tool-call',
            id: brandedCallId,
            name: event.name,
            arguments: event.arguments,
          }
          attempt.finishAndAppendMessage(providerLabel, effectiveModel, [toolBlock], false)
          agent.session.append('tool/call', {
            turn,
            step,
            callId: brandedCallId,
            name: event.name,
            arguments: event.arguments,
          })
        } else {
          agent.session.append('tool/call', {
            turn,
            step,
            callId: brandedCallId,
            name: event.name,
            arguments: event.arguments,
          })
        }
        return
      }
      if (event.type === 'tool_result') {
        const bgMeta = coord.backgroundMeta.get(event.callId)
        if (bgMeta !== undefined) {
          coord.backgroundMeta.delete(event.callId)
        }
        deps.store.updateTask(agent.id, event.callId, {
          status: event.isError ? 'failed' : 'completed',
          ...(event.content !== '' ? { summary: event.content.slice(0, 160) } : {}),
        })

        if (pendingToolCalls.delete(event.callId)) {
          const callStep = toolStepByCallId.get(event.callId) ?? step
          toolStepByCallId.delete(event.callId)
          const brandedCallId = brandString<ToolCallId>(event.callId)
          agent.session.append('tool/result', {
            turn,
            step: callStep,
            message: createToolResultMessage({
              callId: brandedCallId,
              content: event.content === '' ? [] : [{ type: 'text', text: event.content }],
              isError: event.isError,
            }),
            ...(event.isError ? { error: { name: 'ExternalToolError', code: 'EXTERNAL_TOOL_ERROR', reason: event.content.slice(0, 200) } } : {}),
          }, { surfaceOp: 'append' })
          return
        }

        // Background task completed in a subsequent turn: emit a paired completion tool card in the active turn.
        if (bgMeta !== undefined) {
          ensureStepForToolStart()
          const resultCallId = brandString<ToolCallId>(`${event.callId}:bg-result`)
          const resultName = bgMeta.title ?? bgMeta.name
          if (!stepHasTools) {
            stepHasTools = true
            const toolBlock: ContentBlock = {
              type: 'tool-call',
              id: resultCallId,
              name: resultName,
              arguments: bgMeta.arguments,
            }
            attempt.finishAndAppendMessage(providerLabel, effectiveModel, [toolBlock], false)
          }
          agent.session.append('tool/call', {
            turn,
            step,
            callId: resultCallId,
            name: resultName,
            arguments: bgMeta.arguments,
          })
          agent.session.append('tool/result', {
            turn,
            step,
            message: createToolResultMessage({
              callId: resultCallId,
              content: event.content === '' ? [] : [{ type: 'text', text: event.content }],
              isError: event.isError,
            }),
            ...(event.isError ? { error: { name: 'ExternalToolError', code: 'EXTERNAL_TOOL_ERROR', reason: event.content.slice(0, 200) } } : {}),
          }, { surfaceOp: 'append' })
        }
      }
    }

    let isWakeupRun = false
    try {
      agent.session.append('step/start', { turn, step })
      stepOpen = true
      if (!isWakeupOnlyTurn) {
        for (const message of realMessages) {
          agent.session.append('user/message', message, { surfaceOp: 'append' })
        }
      }

      const initialWindow = deps.getModelContextWindow?.(externalAgentId, effectiveModel)
        ?? resolveFallbackContextWindow(externalAgentId, effectiveModel)
      syncRequestContextIfNeeded(initialWindow)

      const effectivePermissionMode = priorBinding?.permissionMode ?? adapter.defaultPermissionMode
      let outcome: ExternalTurnOutcome
      if (isWakeupOnlyTurn && adapter.drainWakeupTurn !== undefined) {
        isWakeupRun = true
        outcome = await adapter.drainWakeupTurn(agent.id, signal, handleTurnEvent)
      } else {
        coord.pendingWakeupAfterRun = false
        const mcpServers = deps.resolveMcpServers ? await deps.resolveMcpServers(agent.id) : []
        outcome = await adapter.runTurn(subprocess, {
          prompt: promptText,
          ...(promptImages.length > 0 ? { images: promptImages } : {}),
          cwd,
          dshSessionId: agent.id,
          model: effectiveModel,
          ...(modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: modelSelection.reasoningEffort }),
          ...(priorBinding?.externalSessionId === undefined ? {} : { externalSessionId: priorBinding.externalSessionId }),
          ...(effectivePermissionMode === undefined ? {} : { permissionMode: effectivePermissionMode }),
          permissionPolicy: deps.getPermissionPolicy(),
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          signal,
          onEvent: handleTurnEvent,
        })
      }

      fallbackText = outcome.finalText
      if (outcome.externalSessionId !== undefined) {
        deps.store.recordExternalSessionId(agent.id, externalAgentId, outcome.externalSessionId)
      }

      const persistentPendingSet = new Set(outcome.pendingToolCallIds ?? [])
      for (const [rawId, meta] of pendingToolCalls) {
        const brandedCallId = brandString<ToolCallId>(rawId)
        const callStep = toolStepByCallId.get(rawId) ?? step
        toolStepByCallId.delete(rawId)
        const isBackgrounded = persistentPendingSet.has(rawId)
        if (isBackgrounded) {
          coord.backgroundMeta.set(rawId, meta)
          upsertBackgroundTaskFromMeta(meta)
        }
        agent.session.append('tool/result', {
          turn,
          step: callStep,
          message: createToolResultMessage({
            callId: brandedCallId,
            content: [{
              type: 'text',
              text: isBackgrounded
                ? 'Running in background (output will follow when completed).'
                : 'Completed without explicit tool output.',
            }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
      }
      pendingToolCalls.clear()
      deps.store.setBackgroundActive(agent.id, persistentPendingSet.size > 0)

      const finalUsage = buildFinalUsage()

      if (stepHasTools) {
        agent.session.append('step/end', { turn, step })
        stepOpen = false
        if (streamedNarrativeText !== '' || fallbackText.trim() !== '') {
          openStep(step + 1)
          agent.session.append('step/start', { turn, step })
          stepOpen = true
          if (streamedNarrativeText === '' && fallbackText.trim() !== '') {
            attempt.pushTextDelta(fallbackText)
          }
          attempt.finishAndAppendMessage(providerLabel, effectiveModel, [], false, finalUsage)
          agent.session.append('step/end', { turn, step })
          stepOpen = false
        }
      } else {
        if (!attempt.hasAnyOutput() && fallbackText.trim() !== '') {
          attempt.pushTextDelta(fallbackText)
        }
        if (isWakeupRun && !attempt.hasAnyOutput() && fallbackText.trim() === '') {
          agent.session.append('step/end', { turn, step })
          stepOpen = false
        } else {
          attempt.finishAndAppendMessage(providerLabel, effectiveModel, [], false, finalUsage)
          agent.session.append('step/end', { turn, step })
          stepOpen = false
        }
      }

      markTurnSettled(agent, turn)
      return { kind: 'enter', messages: [] }
    } catch (error) {
      if (signal.aborted) {
        coord.backgroundMeta.clear()
        coord.pendingWakeupAfterRun = false
        deps.store.clearBackgroundState(agent.id)
        void adapter.closeSession?.(agent.id).catch(() => {})
      }
      for (const [rawId] of pendingToolCalls) {
        const brandedCallId = brandString<ToolCallId>(rawId)
        const callStep = toolStepByCallId.get(rawId) ?? step
        toolStepByCallId.delete(rawId)
        try {
          agent.session.append('tool/result', {
            turn,
            step: callStep,
            message: createToolResultMessage({
              callId: brandedCallId,
              content: [],
              isError: true,
            }),
            error: {
              name: signal.aborted ? 'Interrupted' : 'ExternalAgentError',
              code: signal.aborted ? 'interrupted' : 'EXTERNAL_AGENT_ERROR',
            },
          }, { surfaceOp: 'append' })
        } catch {
          // Best-effort cleanup.
        }
      }
      pendingToolCalls.clear()

      if (stepOpen && !stepHasTools && attempt.hasAnyOutput()) {
        try {
          attempt.finishAndAppendMessage(providerLabel, effectiveModel, [], signal.aborted)
        } catch {
          attempt.abandonIfStarted()
        }
      } else {
        attempt.abandonIfStarted()
      }
      if (stepOpen) {
        try {
          agent.session.append('step/end', { turn, step })
        } catch {
          // Best-effort step closure before ReactLoopAgent logs turn/end.
        }
      }
      throw error
    } finally {
      releaseLock()
      if (coord.pendingWakeupAfterRun && !deps.store.isRunning(agent.id)) {
        scheduleWakeupIfReady(agent, coord)
      }
    }
  }, { global: true, prepend: true })

  return () => {
    disposePreStep()
    disposeCreatedObserver()
    disposeAgentObserver()
    for (const disposeGuard of guardDisposers) disposeGuard()
    guardDisposers.clear()
    for (const coord of coordinators.values()) {
      coord.unsubscribe?.()
      coord.backgroundMeta.clear()
    }
    coordinators.clear()
  }
}
