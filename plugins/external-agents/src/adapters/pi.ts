/**
 * Pi Agent (`pi --mode json --print` + `pi --list-models`) adapter.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentCommandOption, AgentModelOption, AgentQuotaSnapshot, AgentReasoning } from '../types.ts'
import { parseContextSizeString } from '../context-windows.ts'
import {
  nonNegativeInt,
  normalizeCommandList,
  normalizeModelList,
  probeAgentVersion,
  readNdjsonLines,
  resolveAgentExecutable,
  stringifyToolPayload,
  type ExternalAgentAdapter,
  type ExternalProbeResult,
  type ExternalTurnEvent,
  type ExternalTurnOutcome,
  type ExternalTurnRequest,
} from './base.ts'

const DEFAULT_PI_MODELS: readonly AgentModelOption[] = [
  { id: 'default', name: 'Default (Pi CLI default)' },
]

/** Levels accepted by Pi's `--thinking`; Pi clamps levels the selected model does not support. */
export const PI_REASONING: AgentReasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'minimal', name: 'Minimal' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra High' },
    { id: 'max', name: 'Max' },
  ],
}

/** Parse `pi --list-models` tabular stdout into DSH model catalog items + context windows. */
export function parsePiListModelsWithContext(raw: string): {
  readonly models: readonly AgentModelOption[]
  readonly modelContextWindows: Readonly<Record<string, number>>
} {
  const models: AgentModelOption[] = []
  const modelContextWindows: Record<string, number> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('provider')) continue
    const parts = trimmed.split(/\s+/)
    const provider = parts[0]
    const model = parts[1]
    if (provider === undefined || model === undefined || provider === '' || model === '') continue
    const full = `${provider}/${model}`
    models.push({ id: full, name: full })
    const ctxWindow = parseContextSizeString(parts[2])
    if (ctxWindow !== undefined) {
      modelContextWindows[full] = ctxWindow
    }
  }
  return { models, modelContextWindows }
}

/** Parse `pi --list-models` tabular stdout into DSH model catalog items. */
export function parsePiListModelsOutput(raw: string): readonly AgentModelOption[] {
  return parsePiListModelsWithContext(raw).models
}

/** Parse Pi RPC `get_commands` response record into normalized slash commands. */
export function parsePiCommandsResponse(payload: unknown): readonly AgentCommandOption[] {
  if (typeof payload !== 'object' || payload === null) return []
  const rec = payload as Record<string, unknown>
  if (rec.type !== 'response' || rec.command !== 'get_commands' || rec.success !== true) return []
  if (typeof rec.data !== 'object' || rec.data === null) return []
  const rawCommands = (rec.data as Record<string, unknown>).commands
  if (!Array.isArray(rawCommands)) return []
  const commands: AgentCommandOption[] = []
  for (const item of rawCommands) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || entry.name.trim() === '') continue
    const description = typeof entry.description === 'string' ? entry.description : undefined
    const source = typeof entry.source === 'string' ? entry.source : undefined
    commands.push({
      name: entry.name,
      ...(description === undefined ? {} : { description }),
      ...(source === undefined ? {} : { source }),
    })
  }
  return normalizeCommandList(commands)
}

export interface PiParseState {
  externalSessionId?: string
  sawStreamDeltas: boolean
  lastText: string
  errorText?: string
}

function extractPiText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Parse one Pi `--mode json` JSONL record. */
export function parsePiLine(rawLine: string, state: PiParseState): readonly ExternalTurnEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  const events: ExternalTurnEvent[] = []

  if (record.type === 'session' && typeof record.id === 'string' && record.id !== '') {
    state.externalSessionId = record.id
    events.push({ type: 'session', externalSessionId: record.id })
    return events
  }

  if (record.type === 'message_start') {
    state.sawStreamDeltas = false
    return events
  }

  if (record.type === 'message_update' && typeof record.assistantMessageEvent === 'object' && record.assistantMessageEvent !== null) {
    const evt = record.assistantMessageEvent as Record<string, unknown>
    if (evt.type === 'thinking_delta' && typeof evt.delta === 'string' && evt.delta !== '') {
      state.sawStreamDeltas = true
      events.push({ type: 'thinking_delta', delta: evt.delta })
    } else if (evt.type === 'text_delta' && typeof evt.delta === 'string' && evt.delta !== '') {
      state.sawStreamDeltas = true
      state.lastText += evt.delta
      events.push({ type: 'text_delta', delta: evt.delta })
    }
    return events
  }

  if (record.type === 'tool_execution_start' && typeof record.toolName === 'string') {
    const callId = typeof record.toolCallId === 'string' && record.toolCallId !== ''
      ? record.toolCallId
      : `pi-tool-${Date.now()}`
    events.push({
      type: 'tool_start',
      callId,
      name: record.toolName,
      arguments: JSON.stringify(record.args ?? {}),
    })
    return events
  }

  if (record.type === 'tool_execution_end') {
    const callId = typeof record.toolCallId === 'string' && record.toolCallId !== ''
      ? record.toolCallId
      : `pi-tool-${Date.now()}`
    events.push({
      type: 'tool_result',
      callId,
      content: stringifyToolPayload(record.result),
      isError: record.isError === true,
    })
    return events
  }

  if (record.type === 'message_end' && typeof record.message === 'object' && record.message !== null) {
    const msg = record.message as Record<string, unknown>
    if (msg.role === 'assistant') {
      const text = extractPiText(msg.content)
      if (!state.sawStreamDeltas && text.trim() !== '') {
        state.lastText += text
        events.push({ type: 'text', text })
      }
      if (typeof msg.usage === 'object' && msg.usage !== null) {
        const u = msg.usage as Record<string, unknown>
        const inputTokens = nonNegativeInt(u.input ?? u.inputTokens)
        const outputTokens = nonNegativeInt(u.output ?? u.outputTokens)
        const cacheReadTokens = nonNegativeInt(u.cacheRead ?? u.cacheReadTokens)
        const cacheWriteTokens = nonNegativeInt(u.cacheWrite ?? u.cacheWriteTokens)
        if (inputTokens !== undefined || outputTokens !== undefined || cacheReadTokens !== undefined || cacheWriteTokens !== undefined) {
          events.push({
            type: 'usage',
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
          })
        }
      }
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
        state.errorText = typeof msg.errorMessage === 'string' && msg.errorMessage !== ''
          ? msg.errorMessage
          : `pi stopped with reason=${String(msg.stopReason)}`
      }
    }
  }

  return events
}

/** Build the `pi --mode json` argv for one turn; `--thinking` carries the reasoning level. */
export function buildPiRunArgs(
  request: Pick<ExternalTurnRequest, 'model' | 'reasoningEffort' | 'externalSessionId'>,
  rpcMode = false,
  extensionPaths: readonly string[] = [],
): string[] {
  const args: string[] = rpcMode ? ['--mode', 'rpc'] : ['--mode', 'json', '--print']
  if (request.model !== undefined && request.model !== '' && request.model !== 'default') {
    args.push('--model', request.model)
  }
  if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
    args.push('--thinking', request.reasoningEffort)
  }
  if (request.externalSessionId !== undefined && request.externalSessionId !== '') {
    args.push('--session', request.externalSessionId)
  }
  for (const extPath of extensionPaths) {
    args.push('-e', extPath)
  }
  return args
}

function buildPiMcpExtensionSource(mcpServers: readonly NonNullable<ExternalTurnRequest['mcpServers']>[number][]): string {
  const endpoints = mcpServers.flatMap(srv =>
    (srv.tools ?? []).map(tool => ({
      url: srv.url,
      headers: srv.headers,
      tool,
    })),
  )
  return [
    `const BRIDGED_TOOLS = ${JSON.stringify(endpoints)};`,
    `let rpcCounter = 1;`,
    `export default function dshHostToolsExtension(pi) {`,
    `  for (const entry of BRIDGED_TOOLS) {`,
    `    pi.registerTool({`,
    `      name: entry.tool.name,`,
    `      label: entry.tool.name,`,
    `      description: entry.tool.description,`,
    `      parameters: entry.tool.inputSchema,`,
    `      async execute(_id, params) {`,
    `        const res = await fetch(entry.url, {`,
    `          method: 'POST',`,
    `          headers: { ...entry.headers, 'Content-Type': 'application/json' },`,
    `          body: JSON.stringify({ jsonrpc: '2.0', id: rpcCounter++, method: 'tools/call', params: { name: entry.tool.name, arguments: params ?? {} } }),`,
    `        });`,
    `        if (!res.ok) {`,
    `          return { content: [{ type: 'text', text: 'Host MCP bridge HTTP ' + res.status }] };`,
    `        }`,
    `        const rpc = await res.json();`,
    `        if (rpc.error) {`,
    `          return { content: [{ type: 'text', text: rpc.error.message || 'Host MCP error' }] };`,
    `        }`,
    `        return rpc.result ?? { content: [{ type: 'text', text: 'ok' }] };`,
    `      },`,
    `    });`,
    `  }`,
    `}`,
  ].join('\n')
}

export class PiAdapter implements ExternalAgentAdapter {
  readonly id = 'pi' as const
  readonly label = 'Pi Agent'
  readonly command = 'pi'
  // Pi Agent exposes tool allowlists rather than a permission/approval mode system.
  readonly permissionModes = [] as const
  readonly reasoning = PI_REASONING

  private readonly readConfiguredModels: () => readonly AgentModelOption[]

  constructor(configuredModels: readonly AgentModelOption[] | (() => readonly AgentModelOption[]) = []) {
    this.readConfiguredModels = typeof configuredModels === 'function' ? configuredModels : () => configuredModels
  }

  async probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult> {
    const configured = this.readConfiguredModels()
    let executablePath: string
    try {
      executablePath = await resolveAgentExecutable(subprocess, this.command, signal)
    } catch (error) {
      return {
        available: false,
        command: this.command,
        reason: error instanceof Error ? error.message : String(error),
        models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_PI_MODELS),
        defaultModel: 'default',
        reasoning: PI_REASONING,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }

    const [version, discoveredModels, discoveredCommands] = await Promise.all([
      probeAgentVersion(subprocess, executablePath),
      this.probePiModels(subprocess, executablePath),
      this.probePiCommands(subprocess, executablePath, homedir(), signal),
    ])

    return {
      available: true,
      command: this.command,
      executablePath,
      ...(version === undefined ? {} : { version }),
      models: normalizeModelList([...configured, ...discoveredModels.models]),
      modelContextWindows: discoveredModels.modelContextWindows,
      defaultModel: 'default',
      reasoning: PI_REASONING,
      permissionModes: this.permissionModes,
      commands: discoveredCommands,
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
    return await this.probePiCommands(subprocess, executablePath, targetCwd, signal).catch(() => [])
  }

  async probeQuota(): Promise<AgentQuotaSnapshot> {
    return {
      status: 'unsupported',
      source: 'unsupported',
      note: 'Pi Agent CLI does not expose subscription quota.',
    }
  }

  private async probePiModels(subprocess: SubprocessRuntime, executablePath: string): Promise<{
    readonly models: readonly AgentModelOption[]
    readonly modelContextWindows: Readonly<Record<string, number>>
  }> {
    try {
      const listHandle = subprocess.spawn({
        argv: [executablePath, '--list-models'],
        cwd: homedir(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 128_000 }, stderr: { maxBytes: 8_192 } },
        graceMs: 1_500,
        signal: AbortSignal.timeout(3_500),
      })
      const listOutcome = await listHandle.done
      if (listOutcome.exitCode === 0) {
        return parsePiListModelsWithContext(listHandle.collected.stdout?.readFrom(0).text ?? '')
      }
    } catch {
      // Ignore model listing failure and keep defaults.
    }
    return { models: [], modelContextWindows: {} }
  }

  private async probePiCommands(
    subprocess: SubprocessRuntime,
    executablePath: string,
    cwd: string = homedir(),
    signal?: AbortSignal,
  ): Promise<readonly AgentCommandOption[]> {
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => { controller.abort(new Error('Pi RPC get_commands timeout')) }, 4_500)
    try {
      const handle = subprocess.spawn({
        argv: [executablePath, '--mode', 'rpc', '--no-session'],
        cwd,
        stdio: {
          stdin: { data: `${JSON.stringify({ id: 'probe-cmds', type: 'get_commands' })}\n` },
          stdout: 'pipe',
          stderr: { maxBytes: 8_192 },
        },
        graceMs: 1_000,
        signal: controller.signal,
      })
      let commands: readonly AgentCommandOption[] = []
      try {
        await Promise.all([
          handle.done,
          readNdjsonLines(handle, async (line) => {
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              return
            }
            const extracted = parsePiCommandsResponse(parsed)
            if (extracted.length > 0 || (
              typeof parsed === 'object' && parsed !== null
              && (parsed as Record<string, unknown>).type === 'response'
              && (parsed as Record<string, unknown>).command === 'get_commands'
            )) {
              commands = extracted
              try { handle.terminate() } catch { /* ignore */ }
            }
          }),
        ])
      } catch {
        // Process termination after response aborts gracefully.
      }
      return commands
    } catch {
      return []
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome> {
    const executablePath = await resolveAgentExecutable(subprocess, this.command, request.signal)
    const images = request.images ?? []
    const useRpc = images.length > 0
    const bridgedServers = (request.mcpServers ?? []).filter(srv => (srv.tools?.length ?? 0) > 0)
    let tempExtDir: string | undefined
    const extensionPaths: string[] = []
    if (bridgedServers.length > 0) {
      tempExtDir = mkdtempSync(join(tmpdir(), 'dsh-pi-tools-'))
      const extPath = join(tempExtDir, 'dsh-host-tools.mjs')
      writeFileSync(extPath, buildPiMcpExtensionSource(bridgedServers), { encoding: 'utf8', mode: 0o600 })
      extensionPaths.push(extPath)
    }
    const args = buildPiRunArgs(request, useRpc, extensionPaths)

    try {
      const handle = subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: request.cwd,
        stdio: {
          stdin: useRpc ? 'pipe' : { data: request.prompt },
          stdout: 'pipe',
          stderr: { maxBytes: 100_000 },
        },
        graceMs: 3_000,
        signal: request.signal,
      })

      if (useRpc) {
        if (handle.stdin === undefined) {
          try { await handle.terminate() } catch { /* ignore */ }
          throw new Error('pi rpc subprocess did not expose stdin pipe')
        }
        const rpcPrompt = JSON.stringify({
          id: 'turn-1',
          type: 'prompt',
          message: request.prompt,
          images: images.map(img => ({
            type: 'image',
            data: img.base64,
            mimeType: img.mediaType,
          })),
        })
        handle.stdin.write(`${rpcPrompt}\n`)
      }

      const state: PiParseState = { sawStreamDeltas: false, lastText: '' }
      const [outcome] = await Promise.all([
        handle.done,
        readNdjsonLines(handle, async (line) => {
          if (useRpc) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>
              if (parsed.type === 'response' && parsed.command === 'prompt' && parsed.success === false) {
                state.errorText = typeof parsed.error === 'string' && parsed.error !== ''
                  ? parsed.error
                  : 'pi prompt command rejected'
                try { handle.stdin?.end() } catch { /* ignore */ }
                return
              }
              if (parsed.type === 'agent_settled' || parsed.type === 'agent_end') {
                try { handle.stdin?.end() } catch { /* ignore */ }
              }
            } catch {
              // Fall through to parsePiLine
            }
          }
          for (const event of parsePiLine(line, state)) {
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
        throw new Error(stderr !== '' ? stderr : `pi exited with code ${String(outcome.exitCode)}`)
      }

      return {
        ...(state.externalSessionId === undefined ? {} : { externalSessionId: state.externalSessionId }),
        finalText: state.lastText,
      }
    } finally {
      if (tempExtDir !== undefined) {
        try { rmSync(tempExtDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
}
