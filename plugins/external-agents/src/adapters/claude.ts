/**
 * Claude Code CLI (`claude -p --output-format stream-json`) adapter.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentCommandOption, AgentModelOption, AgentReasoning } from '../types.ts'
import {
  nonNegativeInt,
  normalizeCommandList,
  normalizeModelList,
  positiveInt,
  probeAgentVersion,
  readNdjsonLines,
  resolveAgentExecutable,
  stringifyToolPayload,
  type ExternalAgentAdapter,
  type ExternalImageInput,
  type ExternalProbeResult,
  type ExternalTurnEvent,
  type ExternalTurnOutcome,
  type ExternalTurnRequest,
} from './base.ts'

const DEFAULT_CLAUDE_MODELS: readonly AgentModelOption[] = [
  { id: 'default', name: 'Default (Claude Code default)' },
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'opus', name: 'Claude Opus' },
  { id: 'haiku', name: 'Claude Haiku' },
]

/** Levels accepted by Claude Code's `--effort` flag. */
export const CLAUDE_REASONING: AgentReasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra High' },
    { id: 'max', name: 'Max' },
  ],
}

export interface ClaudeParseState {
  externalSessionId?: string
  sawStreamDeltas: boolean
  lastText: string
  resultText?: string
  errorText?: string
}

function parseAnthropicUsage(
  raw: unknown,
  contextWindow?: number,
  isTurnTotal?: boolean,
): Extract<ExternalTurnEvent, { readonly type: 'usage' }> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  const inputTokens = nonNegativeInt(rec.input_tokens ?? rec.inputTokens)
  const outputTokens = nonNegativeInt(rec.output_tokens ?? rec.outputTokens)
  const cacheReadTokens = nonNegativeInt(rec.cache_read_input_tokens ?? rec.cacheReadInputTokens)
  const cacheWriteTokens = nonNegativeInt(rec.cache_creation_input_tokens ?? rec.cacheCreationInputTokens)
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) {
    return undefined
  }
  return {
    type: 'usage',
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(isTurnTotal ? { isTurnTotal: true } : {}),
  }
}

function extractClaudeResultContextWindow(record: Record<string, unknown>): number | undefined {
  if (typeof record.modelUsage !== 'object' || record.modelUsage === null) return undefined
  for (const entry of Object.values(record.modelUsage as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const cw = positiveInt((entry as Record<string, unknown>).contextWindow)
    if (cw !== undefined) return cw
  }
  return undefined
}

function parseClaudeResultModelUsage(record: Record<string, unknown>): Extract<ExternalTurnEvent, { readonly type: 'usage' }> | undefined {
  if (typeof record.modelUsage !== 'object' || record.modelUsage === null) return undefined
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let contextWindow: number | undefined
  let sawAny = false
  for (const entry of Object.values(record.modelUsage as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const inp = nonNegativeInt(rec.inputTokens)
    const out = nonNegativeInt(rec.outputTokens)
    const cr = nonNegativeInt(rec.cacheReadInputTokens)
    const cw = nonNegativeInt(rec.cacheCreationInputTokens)
    const win = positiveInt(rec.contextWindow)
    if (win !== undefined && contextWindow === undefined) contextWindow = win
    if (inp !== undefined || out !== undefined || cr !== undefined || cw !== undefined) {
      sawAny = true
      inputTokens += inp ?? 0
      outputTokens += out ?? 0
      cacheReadTokens += cr ?? 0
      cacheWriteTokens += cw ?? 0
    }
  }
  if (!sawAny) return undefined
  return {
    type: 'usage',
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    isTurnTotal: true,
  }
}

/** Parse one Claude Code `--output-format stream-json` record. */
export function parseClaudeLine(rawLine: string, state: ClaudeParseState): readonly ExternalTurnEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  const events: ExternalTurnEvent[] = []
  const parentToolUseId = typeof record.parent_tool_use_id === 'string' && record.parent_tool_use_id !== ''
    ? record.parent_tool_use_id
    : undefined

  if (record.type === 'system') {
    if (typeof record.session_id === 'string' && record.session_id !== '') {
      state.externalSessionId = record.session_id
      events.push({ type: 'session', externalSessionId: record.session_id })
    }
    const subtype = record.subtype
    if (subtype === 'task_started' && typeof record.task_id === 'string' && record.task_id !== '') {
      if (record.ambient !== true) {
        const toolUseId = typeof record.tool_use_id === 'string' && record.tool_use_id !== '' ? record.tool_use_id : undefined
        const subagentType = typeof record.subagent_type === 'string' && record.subagent_type !== '' ? record.subagent_type : undefined
        events.push({
          type: 'task_started',
          taskId: record.task_id,
          ...(toolUseId === undefined ? {} : { toolUseId }),
          description: typeof record.description === 'string' && record.description !== '' ? record.description : 'Background task',
          ...(subagentType === undefined ? {} : { subagentType }),
          ...(typeof record.is_backgrounded === 'boolean' ? { isBackgrounded: record.is_backgrounded } : {}),
        })
      }
      return events
    }
    if (subtype === 'task_progress' && typeof record.task_id === 'string' && record.task_id !== '') {
      const toolUseId = typeof record.tool_use_id === 'string' && record.tool_use_id !== '' ? record.tool_use_id : undefined
      const subagentType = typeof record.subagent_type === 'string' && record.subagent_type !== '' ? record.subagent_type : undefined
      const lastToolName = typeof record.last_tool_name === 'string' && record.last_tool_name !== '' ? record.last_tool_name : undefined
      const summary = typeof record.summary === 'string' && record.summary !== '' ? record.summary : undefined
      const description = typeof record.description === 'string' && record.description !== '' ? record.description : undefined
      const usage = typeof record.usage === 'object' && record.usage !== null ? record.usage as Record<string, unknown> : undefined
      const totalTokens = nonNegativeInt(usage?.total_tokens)
      const toolUses = nonNegativeInt(usage?.tool_uses)
      const durationMs = nonNegativeInt(usage?.duration_ms)
      events.push({
        type: 'task_progress',
        taskId: record.task_id,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(description === undefined ? {} : { description }),
        ...(subagentType === undefined ? {} : { subagentType }),
        ...(lastToolName === undefined ? {} : { lastToolName }),
        ...(summary === undefined ? {} : { summary }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(toolUses === undefined ? {} : { toolUses }),
        ...(durationMs === undefined ? {} : { durationMs }),
      })
      return events
    }
    if (subtype === 'task_notification' && typeof record.task_id === 'string' && record.task_id !== '') {
      const toolUseId = typeof record.tool_use_id === 'string' && record.tool_use_id !== '' ? record.tool_use_id : undefined
      const rawStatus = record.status
      const status = rawStatus === 'failed' || rawStatus === 'stopped' ? rawStatus : 'completed'
      const summary = typeof record.summary === 'string' && record.summary !== '' ? record.summary : undefined
      const usage = typeof record.usage === 'object' && record.usage !== null ? record.usage as Record<string, unknown> : undefined
      const totalTokens = nonNegativeInt(usage?.total_tokens)
      const toolUses = nonNegativeInt(usage?.tool_uses)
      const durationMs = nonNegativeInt(usage?.duration_ms)
      events.push({
        type: 'task_completed',
        taskId: record.task_id,
        ...(toolUseId === undefined ? {} : { toolUseId }),
        status,
        ...(summary === undefined ? {} : { summary }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(toolUses === undefined ? {} : { toolUses }),
        ...(durationMs === undefined ? {} : { durationMs }),
      })
      return events
    }
    return events
  }

  if (record.type === 'stream_event' && typeof record.event === 'object' && record.event !== null) {
    if (parentToolUseId !== undefined) {
      return events
    }
    const inner = record.event as Record<string, unknown>
    if (inner.type === 'content_block_delta' && typeof inner.delta === 'object' && inner.delta !== null) {
      const delta = inner.delta as Record<string, unknown>
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
        state.sawStreamDeltas = true
        events.push({ type: 'thinking_delta', delta: delta.thinking })
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        state.sawStreamDeltas = true
        state.lastText += delta.text
        events.push({ type: 'text_delta', delta: delta.text })
      }
    } else if (inner.type === 'message_start') {
      state.sawStreamDeltas = false
      const msg = typeof inner.message === 'object' && inner.message !== null
        ? inner.message as Record<string, unknown>
        : undefined
      const usageEvt = parseAnthropicUsage(msg?.usage)
      if (usageEvt !== undefined) events.push(usageEvt)
    } else if (inner.type === 'message_delta') {
      const usageEvt = parseAnthropicUsage(inner.usage)
      if (usageEvt !== undefined) events.push(usageEvt)
    }
    return events
  }

  if (record.type === 'assistant' && typeof record.message === 'object' && record.message !== null) {
    const msg = record.message as Record<string, unknown>
    const content = msg.content
    if (parentToolUseId !== undefined) {
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item !== 'object' || item === null) continue
          const block = item as Record<string, unknown>
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            events.push({
              type: 'task_progress',
              taskId: parentToolUseId,
              toolUseId: parentToolUseId,
              lastToolName: block.name,
            })
          }
        }
      }
      return events
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== 'object' || item === null) continue
        const block = item as Record<string, unknown>
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const callId = typeof block.id === 'string' && block.id !== '' ? block.id : `claude-tool-${Date.now()}`
          events.push({
            type: 'tool_start',
            callId,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        } else if (block.type === 'thinking' && !state.sawStreamDeltas && typeof block.thinking === 'string' && block.thinking !== '') {
          events.push({ type: 'thinking_delta', delta: block.thinking })
        } else if (block.type === 'text' && !state.sawStreamDeltas && typeof block.text === 'string' && block.text !== '') {
          state.lastText += block.text
          events.push({ type: 'text', text: block.text })
        }
      }
    }
    const usageEvt = parseAnthropicUsage(msg.usage)
    if (usageEvt !== undefined) events.push(usageEvt)
    return events
  }

  if (record.type === 'user' && typeof record.message === 'object' && record.message !== null) {
    if (parentToolUseId !== undefined) return events
    const content = (record.message as Record<string, unknown>).content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item !== 'object' || item === null) continue
        const block = item as Record<string, unknown>
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          events.push({
            type: 'tool_result',
            callId: block.tool_use_id,
            content: stringifyToolPayload(block.content),
            isError: block.is_error === true,
          })
        }
      }
    }
    return events
  }

  if (record.type === 'result') {
    if (typeof record.session_id === 'string' && record.session_id !== '') {
      state.externalSessionId = record.session_id
      events.push({ type: 'session', externalSessionId: record.session_id })
    }
    const contextWindow = extractClaudeResultContextWindow(record)
    const usageEvt = parseAnthropicUsage(record.usage, contextWindow, true)
      ?? parseClaudeResultModelUsage(record)
    if (usageEvt !== undefined) {
      events.push(usageEvt)
    }
    const isError = record.is_error === true
      || (typeof record.subtype === 'string' && record.subtype !== 'success')
    if (isError) {
      const errs = Array.isArray(record.errors)
        ? record.errors.filter((e): e is string => typeof e === 'string').join('; ')
        : ''
      state.errorText = typeof record.result === 'string' && record.result !== '' ? record.result : (errs || 'Claude Code failed')
    } else if (typeof record.result === 'string') {
      state.resultText = record.result
    }
  }

  return events
}

export const CLAUDE_PERMISSION_MODES = [
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Automatically approve workspace file edits' },
  { id: 'auto', name: 'Auto', description: 'Use Claude Code automated permission classifier' },
  { id: 'dontAsk', name: "Don't Ask", description: 'Deny actions that require interactive confirmation' },
  { id: 'plan', name: 'Plan', description: 'Plan changes without applying edits or commands' },
  { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skip all Claude Code permission checks' },
] as const

/** Parse Claude Code `control_response` (`subtype: "initialize"`) into commands + live models. */
export function parseClaudeInitResponse(payload: unknown): {
  readonly commands: readonly AgentCommandOption[]
  readonly models: readonly AgentModelOption[]
} {
  if (typeof payload !== 'object' || payload === null) return { commands: [], models: [] }
  const rec = payload as Record<string, unknown>
  if (rec.type !== 'control_response' || typeof rec.response !== 'object' || rec.response === null) {
    return { commands: [], models: [] }
  }
  const outer = rec.response as Record<string, unknown>
  if (outer.subtype !== 'success' || typeof outer.response !== 'object' || outer.response === null) {
    return { commands: [], models: [] }
  }
  const body = outer.response as Record<string, unknown>

  const commands: AgentCommandOption[] = []
  if (Array.isArray(body.commands)) {
    for (const item of body.commands) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.name !== 'string' || entry.name.trim() === '') continue
      const description = typeof entry.description === 'string' ? entry.description : undefined
      const argumentHint = typeof entry.argumentHint === 'string' ? entry.argumentHint : undefined
      commands.push({
        name: entry.name,
        ...(description === undefined ? {} : { description }),
        ...(argumentHint === undefined ? {} : { argumentHint }),
        source: entry.builtin === true ? 'builtin' : 'custom',
      })
    }
  }

  const models: AgentModelOption[] = []
  if (Array.isArray(body.models)) {
    for (const item of body.models) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.value !== 'string' || entry.value.trim() === '') continue
      const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
        ? entry.displayName.trim()
        : entry.value
      models.push({ id: entry.value, name: displayName })
    }
  }

  return {
    commands: normalizeCommandList(commands),
    models,
  }
}

/** Build one NDJSON `user` message carrying text + base64 image blocks for `--input-format stream-json`. */
export function buildClaudeStreamUserMessage(prompt: string, images: readonly ExternalImageInput[]): string {
  const content: Array<Record<string, unknown>> = []
  if (prompt.trim() !== '') {
    content.push({ type: 'text', text: prompt })
  }
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.base64,
      },
    })
  }
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  })
}

/** Build the `claude -p` argv for one turn, including optional model, effort, resume id, and MCP config. */
const CLAUDE_READONLY_MANAGER_TOOLS = [
  'dsh_manager_board_summary',
  'dsh_manager_team_config_get',
] as const

/** Compute `--allowedTools` entries for bridged DSH MCP servers under the active permission mode. */
export function resolveClaudeAllowedMcpTools(
  permissionMode: string,
  permissionPolicy: ExternalTurnRequest['permissionPolicy'],
  mcpServers: NonNullable<ExternalTurnRequest['mcpServers']>,
): string[] | undefined {
  if (mcpServers.length === 0 || permissionPolicy === 'reject') return undefined
  if (permissionMode !== 'plan') {
    return mcpServers.map(srv => `mcp__${srv.name}__*`)
  }
  return mcpServers.flatMap(srv =>
    CLAUDE_READONLY_MANAGER_TOOLS.map(tool => `mcp__${srv.name}__${tool}`),
  )
}

export function buildClaudeRunArgs(
  request: Pick<ExternalTurnRequest, 'model' | 'reasoningEffort' | 'externalSessionId'>,
  permissionMode: string,
  hasImages = false,
  mcpConfigPath?: string,
  allowedMcpTools?: readonly string[],
): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    ...(hasImages ? ['--input-format', 'stream-json'] : []),
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', permissionMode,
  ]
  if (mcpConfigPath !== undefined && mcpConfigPath !== '') {
    args.push('--mcp-config', mcpConfigPath)
    if (allowedMcpTools !== undefined && allowedMcpTools.length > 0) {
      args.push('--allowedTools', ...allowedMcpTools)
    }
  }
  if (request.model !== undefined && request.model !== '' && request.model !== 'default') {
    args.push('--model', request.model)
  }
  if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
    args.push('--effort', request.reasoningEffort)
  }
  if (request.externalSessionId !== undefined && request.externalSessionId !== '') {
    args.push('--resume', request.externalSessionId)
  }
  return args
}

export class ClaudeCodeAdapter implements ExternalAgentAdapter {
  readonly id = 'claude-code' as const
  readonly label = 'Claude Code'
  readonly command = 'claude'
  readonly permissionModes = CLAUDE_PERMISSION_MODES
  readonly reasoning = CLAUDE_REASONING
  readonly defaultPermissionMode = 'acceptEdits'

  constructor(private readonly configuredModels: readonly AgentModelOption[] = []) {}

  async probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult> {
    let executablePath: string
    try {
      executablePath = await resolveAgentExecutable(subprocess, this.command, signal)
    } catch (error) {
      return {
        available: false,
        command: this.command,
        reason: error instanceof Error ? error.message : String(error),
        models: normalizeModelList(this.configuredModels.length > 0 ? this.configuredModels : DEFAULT_CLAUDE_MODELS),
        defaultModel: 'default',
        reasoning: CLAUDE_REASONING,
        defaultPermissionMode: this.defaultPermissionMode,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }
    const [version, initCatalog] = await Promise.all([
      probeAgentVersion(subprocess, executablePath),
      this.probeClaudeCatalog(subprocess, executablePath, homedir(), signal),
    ])
    const models = normalizeModelList([
      ...this.configuredModels,
      ...(initCatalog.models.length > 0 ? initCatalog.models : DEFAULT_CLAUDE_MODELS),
    ])
    return {
      available: true,
      command: this.command,
      executablePath,
      ...(version === undefined ? {} : { version }),
      models,
      defaultModel: 'default',
      reasoning: CLAUDE_REASONING,
      defaultPermissionMode: this.defaultPermissionMode,
      permissionModes: this.permissionModes,
      commands: initCatalog.commands,
    }
  }

  async probeCommands(
    subprocess: SubprocessRuntime,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentCommandOption[]> {
    let executablePath: string
    try {
      executablePath = await resolveAgentExecutable(subprocess, this.command, signal)
    } catch {
      return []
    }
    const targetCwd = cwd.trim() === '' ? homedir() : cwd
    const initCatalog = await this.probeClaudeCatalog(subprocess, executablePath, targetCwd, signal).catch(() => ({
      commands: [],
      models: [],
    }))
    return initCatalog.commands
  }

  private async probeClaudeCatalog(
    subprocess: SubprocessRuntime,
    executablePath: string,
    cwd: string = homedir(),
    signal?: AbortSignal,
  ): Promise<{ readonly commands: readonly AgentCommandOption[]; readonly models: readonly AgentModelOption[] }> {
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => { controller.abort(new Error('Claude initialize probe timeout')) }, 4_500)
    try {
      const handle = subprocess.spawn({
        argv: [
          executablePath,
          '-p',
          '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
        ],
        cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
        graceMs: 1_000,
        signal: controller.signal,
      })
      if (handle.stdin === undefined || handle.stdout === undefined) {
        try { handle.terminate() } catch { /* ignore */ }
        return { commands: [], models: [] }
      }
      handle.stdin.write(`${JSON.stringify({
        type: 'control_request',
        request_id: 'probe-init',
        request: { subtype: 'initialize' },
      })}\n`)
      let catalog: { readonly commands: readonly AgentCommandOption[]; readonly models: readonly AgentModelOption[] } = {
        commands: [],
        models: [],
      }
      try {
        await readNdjsonLines(handle, async (line) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          const extracted = parseClaudeInitResponse(parsed)
          if (extracted.commands.length > 0 || extracted.models.length > 0) {
            catalog = extracted
            try { handle.stdin?.end() } catch { /* ignore */ }
            try { handle.terminate() } catch { /* ignore */ }
          }
        })
      } catch {
        // Probe termination aborts stdout read cleanly.
      }
      await handle.done.catch(() => {})
      return catalog
    } catch {
      return { commands: [], models: [] }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome> {
    const executablePath = await resolveAgentExecutable(subprocess, this.command, request.signal)
    const permissionMode = request.permissionMode ?? (request.permissionPolicy === 'allow' ? this.defaultPermissionMode : 'dontAsk')
    const images = request.images ?? []
    const hasImages = images.length > 0
    const mcpServers = request.mcpServers ?? []
    let tempMcpDir: string | undefined
    let mcpConfigPath: string | undefined
    let allowedMcpTools: string[] | undefined
    if (mcpServers.length > 0) {
      tempMcpDir = mkdtempSync(join(tmpdir(), 'dsh-claude-mcp-'))
      mcpConfigPath = join(tempMcpDir, 'mcp.json')
      const mcpConfigPayload: Record<string, { type: 'http'; url: string; headers: Readonly<Record<string, string>> }> = {}
      for (const srv of mcpServers) {
        mcpConfigPayload[srv.name] = { type: 'http', url: srv.url, headers: srv.headers }
      }
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfigPayload }), { encoding: 'utf8', mode: 0o600 })
      allowedMcpTools = resolveClaudeAllowedMcpTools(permissionMode, request.permissionPolicy, mcpServers)
    }
    const args = buildClaudeRunArgs(request, permissionMode, hasImages, mcpConfigPath, allowedMcpTools)
    const stdinData = hasImages
      ? `${buildClaudeStreamUserMessage(request.prompt, images)}\n`
      : request.prompt

    try {
      const handle = subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: request.cwd,
        stdio: {
          stdin: { data: stdinData },
          stdout: 'pipe',
          stderr: { maxBytes: 100_000 },
        },
        graceMs: 3_000,
        signal: request.signal,
      })

      const state: ClaudeParseState = { sawStreamDeltas: false, lastText: '' }
      const [outcome] = await Promise.all([
        handle.done,
        readNdjsonLines(handle, async (line) => {
          for (const event of parseClaudeLine(line, state)) {
            await request.onEvent(event)
          }
        }),
      ])

      if (request.signal.aborted) {
        throw request.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (state.errorText !== undefined) {
        throw new Error(state.errorText)
      }
      if (outcome.exitCode !== 0 && outcome.signal === null) {
        const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
        throw new Error(stderr !== '' ? stderr : `claude exited with code ${String(outcome.exitCode)}`)
      }

      return {
        ...(state.externalSessionId === undefined ? {} : { externalSessionId: state.externalSessionId }),
        finalText: state.resultText !== undefined && state.resultText !== '' ? state.resultText : state.lastText,
      }
    } finally {
      if (tempMcpDir !== undefined) {
        try { rmSync(tempMcpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
}
