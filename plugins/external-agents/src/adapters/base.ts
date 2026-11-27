/**
 * Shared adapter contract, CLI executable resolution, and process helpers for
 * third-party coding agents.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  AgentAuthStatus,
  AgentCommandOption,
  AgentModelOption,
  AgentPermissionOption,
  AgentQuotaSnapshot,
  AgentReasoning,
  ExternalAgentId,
} from '../types.ts'

export type ExternalPermissionPolicy = 'allow' | 'reject'

export interface ExternalImageInput {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly base64: string
  readonly hostPath?: string
  readonly name?: string
  readonly width?: number
  readonly height?: number
}

export interface ExternalUsageReport {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly contextWindow?: number
  readonly contextUsedTokens?: number
  readonly isTurnTotal?: boolean
}

export type ExternalTurnEvent =
  | { readonly type: 'session'; readonly externalSessionId: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'tool_start'
    readonly callId: string
    readonly name: string
    readonly arguments: string
    readonly toolName?: string
    readonly title?: string
    readonly kind?: string
  }
  | { readonly type: 'tool_progress'; readonly callId: string; readonly title?: string; readonly summary?: string }
  | { readonly type: 'tool_result'; readonly callId: string; readonly content: string; readonly isError: boolean }
  | ({ readonly type: 'usage' } & ExternalUsageReport)
  | { readonly type: 'rate_limit'; readonly snapshot: AgentQuotaSnapshot }
  | {
    readonly type: 'task_started'
    readonly taskId: string
    readonly toolUseId?: string
    readonly description: string
    readonly subagentType?: string
    readonly isBackgrounded?: boolean
  }
  | {
    readonly type: 'task_progress'
    readonly taskId: string
    readonly toolUseId?: string
    readonly description?: string
    readonly subagentType?: string
    readonly lastToolName?: string
    readonly summary?: string
    readonly totalTokens?: number
    readonly toolUses?: number
    readonly durationMs?: number
  }
  | {
    readonly type: 'task_completed'
    readonly taskId: string
    readonly toolUseId?: string
    readonly status: 'completed' | 'failed' | 'stopped'
    readonly summary?: string
    readonly totalTokens?: number
    readonly toolUses?: number
    readonly durationMs?: number
  }

export type ExternalAsyncEvent =
  | ExternalTurnEvent
  | { readonly type: 'wakeup_ready' }
  | { readonly type: 'wakeup_settled' }
  | { readonly type: 'process_exit'; readonly reason?: string }

export interface ExternalMcpToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ExternalMcpServerConfig {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly tools?: readonly ExternalMcpToolSpec[]
}

export interface ExternalTurnRequest {
  readonly prompt: string
  readonly images?: readonly ExternalImageInput[]
  readonly cwd: string
  readonly dshSessionId?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly externalSessionId?: string
  readonly permissionMode?: string
  readonly permissionPolicy: ExternalPermissionPolicy
  readonly mcpServers?: readonly ExternalMcpServerConfig[]
  readonly signal: AbortSignal
  readonly onEvent: (event: ExternalTurnEvent) => void | Promise<void>
}

export interface ExternalTurnOutcome {
  readonly externalSessionId?: string
  readonly finalText: string
  readonly pendingToolCallIds?: readonly string[]
}

export interface ExternalProbeResult {
  readonly available: boolean
  readonly command: string
  readonly executablePath?: string
  readonly version?: string
  readonly reason?: string
  readonly models: readonly AgentModelOption[]
  readonly modelContextWindows?: Readonly<Record<string, number>>
  readonly defaultModel: string
  /** Selectable reasoning levels every advertised model shares; absent when the CLI has no effort control. */
  readonly reasoning?: AgentReasoning
  readonly defaultPermissionMode?: string
  readonly permissionModes: readonly AgentPermissionOption[]
  readonly commands?: readonly AgentCommandOption[]
  readonly authStatus?: AgentAuthStatus
}

export interface ExternalAgentAdapter {
  readonly id: ExternalAgentId
  readonly label: string
  readonly command: string
  readonly permissionModes: readonly AgentPermissionOption[]
  /** Selectable reasoning levels the CLI exposes for every model; absent when it has no effort control. */
  readonly reasoning?: AgentReasoning
  readonly defaultPermissionMode?: string
  probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult>
  probeQuota?(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<AgentQuotaSnapshot>
  runTurn(subprocess: SubprocessRuntime, request: ExternalTurnRequest): Promise<ExternalTurnOutcome>
  subscribeBackground?(dshSessionId: string, listener: (event: ExternalAsyncEvent) => void): () => void
  consumeBufferedAsyncEvents?(dshSessionId: string): readonly ExternalTurnEvent[]
  drainWakeupTurn?(
    dshSessionId: string,
    signal: AbortSignal,
    onEvent: (event: ExternalTurnEvent) => void | Promise<void>,
  ): Promise<ExternalTurnOutcome>
  closeSession?(dshSessionId: string): Promise<void>
  dispose?(): Promise<void>
}

function guiFallbackCandidates(command: string): readonly string[] {
  if (process.platform === 'win32' || command.includes('/') || command.includes('\\')) return []
  return [
    join(homedir(), '.local', 'bin', command),
    join(homedir(), '.pi', 'agent', 'bin', command),
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
  ]
}

/**
 * Resolve an executable through `SubprocessRuntime`, falling back to common
 * user-local bin dirs omitted by GUI launch environments.
 */
export async function resolveAgentExecutable(
  subprocess: SubprocessRuntime,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await subprocess.resolveExecutable(command, undefined, signal)
  } catch (primaryError) {
    for (const candidate of guiFallbackCandidates(command)) {
      try {
        return await subprocess.resolveExecutable(candidate, undefined, signal)
      } catch {
        // Continue trying fallback directories.
      }
    }
    throw primaryError
  }
}

/** Read a short single-line version banner via `<bin> --version`. */
export async function probeAgentVersion(
  subprocess: SubprocessRuntime,
  executablePath: string,
): Promise<string | undefined> {
  try {
    const handle = subprocess.spawn({
      argv: [executablePath, '--version'],
      cwd: homedir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1_000,
      signal: AbortSignal.timeout(2_500),
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    const raw = (handle.collected.stdout?.readFrom(0).text ?? '').trim()
      || (handle.collected.stderr?.readFrom(0).text ?? '').trim()
    const line = raw.split(/\r?\n/, 1)[0]?.trim()
    return line === undefined || line === '' ? undefined : line.slice(0, 80)
  } catch {
    return undefined
  }
}

/** Consume an NDJSON stdout stream line-by-line until EOF. */
export async function readNdjsonLines(
  handle: SubprocessHandle,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const stdout = handle.stdout
  if (stdout === undefined) return
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  for await (const chunk of stdout) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() !== '') await onLine(line)
      nl = buffer.indexOf('\n')
    }
  }
  buffer += decoder.end()
  if (buffer.trim() !== '') await onLine(buffer)
}

/** Normalize arbitrary tool result payloads into readable string text. */
export function stringifyToolPayload(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const textParts: string[] = []
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        const rec = item as Record<string, unknown>
        if (rec.type === 'text' && typeof rec.text === 'string') {
          textParts.push(rec.text)
          continue
        }
        if (rec.type === 'content' && typeof rec.content === 'object' && rec.content !== null) {
          const inner = rec.content as Record<string, unknown>
          if (inner.type === 'text' && typeof inner.text === 'string') {
            textParts.push(inner.text)
            continue
          }
        }
      }
      textParts.push(JSON.stringify(item))
    }
    return textParts.join('\n')
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Ensure model list always carries unique ids plus a fallback `default` entry. */
export function normalizeModelList(models: readonly AgentModelOption[]): readonly AgentModelOption[] {
  const seen = new Set<string>()
  const result: AgentModelOption[] = []
  for (const item of models) {
    const id = item.id.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name: item.name.trim() || id })
  }
  if (!seen.has('default')) {
    result.unshift({ id: 'default', name: 'Default (Agent CLI default)' })
  }
  const nameCounts = new Map<string, number>()
  for (const entry of result) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1)
  }
  return result.map((entry) =>
    (nameCounts.get(entry.name) ?? 0) > 1 && entry.id !== entry.name
      ? { id: entry.id, name: `${entry.name} (${entry.id})` }
      : entry,
  )
}

const MAX_COMMAND_DESCRIPTION_CHARS = 240

/** Read a non-negative finite integer from an untrusted numeric payload field. */
export function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value)
}

/** Read a positive finite integer (e.g. context window tokens) from an untrusted field. */
export function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

/** Normalize discovered slash commands: strip leading slashes, deduplicate, and bound description length. */
export function normalizeCommandList(commands: readonly AgentCommandOption[]): readonly AgentCommandOption[] {
  const seen = new Set<string>()
  const result: AgentCommandOption[] = []
  for (const item of commands) {
    const cleanName = item.name.trim().replace(/^\/+/u, '')
    if (cleanName === '' || seen.has(cleanName)) continue
    seen.add(cleanName)
    const rawDesc = item.description?.replace(/\s+/gu, ' ').trim()
    const description = rawDesc === undefined || rawDesc === ''
      ? undefined
      : rawDesc.length > MAX_COMMAND_DESCRIPTION_CHARS
        ? `${rawDesc.slice(0, MAX_COMMAND_DESCRIPTION_CHARS - 1)}…`
        : rawDesc
    const argumentHint = item.argumentHint?.trim() || undefined
    const source = item.source?.trim() || undefined
    result.push({
      name: cleanName,
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
      ...(source === undefined ? {} : { source }),
    })
  }
  return result
}
