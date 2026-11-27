/**
 * OpenAI Codex CLI (`codex exec --json` / `codex exec resume <id> --json`) adapter.
 * Gracefully probes missing installations so hosts without `codex` still start cleanly.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentModelOption, AgentQuotaSnapshot, AgentReasoning } from '../types.ts'
import {
  nonNegativeInt,
  normalizeModelList,
  probeAgentVersion,
  readNdjsonLines,
  resolveAgentExecutable,
  stringifyToolPayload,
  type ExternalAgentAdapter,
  type ExternalImageInput,
  type ExternalMcpServerConfig,
  type ExternalProbeResult,
  type ExternalTurnEvent,
  type ExternalTurnOutcome,
  type ExternalTurnRequest,
} from './base.ts'

const DEFAULT_CODEX_MODELS: readonly AgentModelOption[] = [
  { id: 'default', name: 'Default (Codex default)' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'o3', name: 'o3' },
]

/** Levels accepted by Codex's `model_reasoning_effort` config key; unsupported ones clamp. */
export const CODEX_REASONING: AgentReasoning = {
  efforts: [
    { id: 'minimal', name: 'Minimal' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Extra High' },
  ],
}

export interface CodexParseState {
  externalSessionId?: string
  lastText: string
  errorText?: string
}

/** Parse one Codex `--json` JSONL record. */
export function parseCodexLine(rawLine: string, state: CodexParseState): readonly ExternalTurnEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  const events: ExternalTurnEvent[] = []

  if (record.type === 'thread.started' && typeof record.thread_id === 'string' && record.thread_id !== '') {
    state.externalSessionId = record.thread_id
    events.push({ type: 'session', externalSessionId: record.thread_id })
    return events
  }

  if ((record.type === 'item.started' || record.type === 'item.completed') && typeof record.item === 'object' && record.item !== null) {
    const entry = record.item as Record<string, unknown>
    const itemId = typeof entry.id === 'string' && entry.id !== '' ? entry.id : `codex-${Date.now()}`
    const completed = record.type === 'item.completed'

    if (entry.type === 'reasoning' && completed && typeof entry.text === 'string' && entry.text !== '') {
      events.push({ type: 'thinking_delta', delta: entry.text })
    } else if (entry.type === 'agent_message' && completed && typeof entry.text === 'string' && entry.text !== '') {
      state.lastText = entry.text
      events.push({ type: 'text', text: entry.text })
    } else if (entry.type === 'command_execution') {
      if (!completed) {
        events.push({
          type: 'tool_start',
          callId: itemId,
          name: 'command_execution',
          arguments: JSON.stringify({ command: entry.command ?? '' }),
        })
      } else {
        const output = typeof entry.aggregated_output === 'string'
          ? entry.aggregated_output
          : stringifyToolPayload(entry.output)
        const isError = entry.status === 'failed' || (typeof entry.exit_code === 'number' && entry.exit_code !== 0)
        events.push({ type: 'tool_result', callId: itemId, content: output, isError })
      }
    } else if (entry.type === 'file_change') {
      if (!completed) {
        events.push({
          type: 'tool_start',
          callId: itemId,
          name: 'file_change',
          arguments: JSON.stringify({ changes: entry.changes ?? [] }),
        })
      } else {
        events.push({
          type: 'tool_result',
          callId: itemId,
          content: stringifyToolPayload(entry.changes ?? 'applied'),
          isError: entry.status === 'failed',
        })
      }
    } else if (entry.type === 'mcp_tool_call') {
      const toolName = typeof entry.tool === 'string' ? entry.tool : 'mcp_tool_call'
      if (!completed) {
        events.push({
          type: 'tool_start',
          callId: itemId,
          name: toolName,
          arguments: JSON.stringify(entry.arguments ?? {}),
        })
      } else {
        events.push({
          type: 'tool_result',
          callId: itemId,
          content: stringifyToolPayload(entry.result ?? entry.error),
          isError: entry.status === 'failed' || entry.error !== undefined,
        })
      }
    }
    return events
  }

  if (record.type === 'turn.completed' && typeof record.usage === 'object' && record.usage !== null) {
    const u = record.usage as Record<string, unknown>
    const totalInput = nonNegativeInt(u.input_tokens)
    const cached = nonNegativeInt(u.cached_input_tokens) ?? 0
    const output = nonNegativeInt(u.output_tokens)
    if (totalInput !== undefined || output !== undefined) {
      events.push({
        type: 'usage',
        inputTokens: totalInput === undefined ? 0 : Math.max(0, totalInput - cached),
        outputTokens: output ?? 0,
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        isTurnTotal: true,
      })
    }
    return events
  }

  if (record.type === 'turn.failed') {
    const err = record.error
    state.errorText = typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>).message === 'string'
      ? (err as Record<string, unknown>).message as string
      : 'Codex turn failed'
  } else if (record.type === 'error' && typeof record.message === 'string') {
    state.errorText = record.message
  }

  return events
}

export const CODEX_SANDBOX_MODES = [
  { id: 'workspace-write', name: 'Workspace Write', description: 'Allow file edits inside workspace sandbox' },
  { id: 'read-only', name: 'Read-Only', description: 'Read-only sandbox inspection' },
  { id: 'danger-full-access', name: 'Full Access', description: 'Unrestricted filesystem and network access' },
] as const

function tomlEscapeString(value: string): string {
  return JSON.stringify(value)
}

/** Build the `codex exec` argv for one turn; reasoning effort & MCP bridges ride `-c` overrides. */
export function buildCodexRunArgs(
  request: Pick<ExternalTurnRequest, 'model' | 'reasoningEffort' | 'externalSessionId'>,
  sandboxMode: string,
  imagePaths: readonly string[] = [],
  mcpServers: readonly ExternalMcpServerConfig[] = [],
): string[] {
  const args: string[] = ['exec']
  if (request.externalSessionId !== undefined && request.externalSessionId !== '') {
    args.push('resume', request.externalSessionId)
  }
  args.push('--json')
  if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
    args.push('-c', `model_reasoning_effort=${request.reasoningEffort}`)
  }
  for (const srv of mcpServers) {
    const key = srv.name.replace(/[^A-Za-z0-9_]/g, '_')
    args.push('-c', `mcp_servers.${key}.url=${tomlEscapeString(srv.url)}`)
    const headerEntries = Object.entries(srv.headers)
    if (headerEntries.length > 0) {
      const inlineHeaders = headerEntries
        .map(([hName, hVal]) => `${tomlEscapeString(hName)} = ${tomlEscapeString(hVal)}`)
        .join(', ')
      args.push('-c', `mcp_servers.${key}.http_headers={ ${inlineHeaders} }`)
    }
  }
  args.push('--sandbox', sandboxMode)
  if (request.model !== undefined && request.model !== '' && request.model !== 'default') {
    args.push('--model', request.model)
  }
  for (const imagePath of imagePaths) {
    args.push('--image', imagePath)
  }
  args.push('-')
  return args
}

function imageExt(mediaType: ExternalImageInput['mediaType']): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
  }
}

export class CodexAdapter implements ExternalAgentAdapter {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  readonly command = 'codex'
  readonly permissionModes = CODEX_SANDBOX_MODES
  readonly reasoning = CODEX_REASONING
  readonly defaultPermissionMode = 'workspace-write'

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
        models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_CODEX_MODELS),
        defaultModel: 'default',
        reasoning: CODEX_REASONING,
        defaultPermissionMode: this.defaultPermissionMode,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }
    const version = await probeAgentVersion(subprocess, executablePath)
    return {
      available: true,
      command: this.command,
      executablePath,
      ...(version === undefined ? {} : { version }),
      models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_CODEX_MODELS),
      defaultModel: 'default',
      reasoning: CODEX_REASONING,
      defaultPermissionMode: this.defaultPermissionMode,
      permissionModes: this.permissionModes,
      commands: [],
    }
  }

  async probeQuota(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<AgentQuotaSnapshot> {
    try {
      await resolveAgentExecutable(subprocess, this.command, signal)
    } catch (error) {
      return {
        status: 'unavailable',
        source: 'passive_stream',
        note: error instanceof Error ? error.message : String(error),
      }
    }
    return {
      status: 'unavailable',
      source: 'passive_stream',
      note: 'Codex CLI quota is observed passively or requires app-server session telemetry.',
    }
  }

  async runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome> {
    const executablePath = await resolveAgentExecutable(subprocess, this.command, request.signal)
    const sandboxMode = request.permissionMode ?? (request.permissionPolicy === 'allow' ? this.defaultPermissionMode : 'read-only')
    let tempImageDir: string | undefined
    const imagePaths: string[] = []
    for (const [idx, img] of (request.images ?? []).entries()) {
      if (img.hostPath !== undefined && img.hostPath !== '') {
        imagePaths.push(img.hostPath)
      } else {
        if (tempImageDir === undefined) {
          tempImageDir = mkdtempSync(join(tmpdir(), 'dsh-codex-img-'))
        }
        const filePath = join(tempImageDir, `img-${idx}${imageExt(img.mediaType)}`)
        writeFileSync(filePath, Buffer.from(img.base64, 'base64'))
        imagePaths.push(filePath)
      }
    }
    const args = buildCodexRunArgs(request, sandboxMode, imagePaths, request.mcpServers)

    try {
      const handle = subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: request.cwd,
        stdio: {
          stdin: { data: request.prompt },
          stdout: 'pipe',
          stderr: { maxBytes: 100_000 },
        },
        graceMs: 3_000,
        signal: request.signal,
      })

      const state: CodexParseState = { lastText: '' }
      const [outcome] = await Promise.all([
        handle.done,
        readNdjsonLines(handle, async (line) => {
          for (const event of parseCodexLine(line, state)) {
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
        throw new Error(stderr !== '' ? stderr : `codex exited with code ${String(outcome.exitCode)}`)
      }

      return {
        ...(state.externalSessionId === undefined ? {} : { externalSessionId: state.externalSessionId }),
        finalText: state.lastText,
      }
    } finally {
      if (tempImageDir !== undefined) {
        try { rmSync(tempImageDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
}
