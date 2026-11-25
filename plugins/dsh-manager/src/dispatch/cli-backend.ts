/**
 * Multica-style protocol-agnostic external CLI backend (`claude-code`, `codex`,
 * `agy`): spawns local headless CLIs through the DSH subprocess seam, streams
 * NDJSON events into a normalized progress/result taxonomy, and captures the
 * external session id so rework dispatches resume the prior context.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentKind } from '../crew/crew-core.ts'
import type { AgentKindOption } from '../crew/wire-types.ts'
import type { ReportActivity, ReportActivityCategory } from './dispatch-core.ts'

/** External CLI backends (every `AgentKind` except the harness `builtin` session). */
export type ExternalAgentKind = Exclude<AgentKind, 'builtin'>

/** Normalized Multica-style event emitted from an external CLI stream. */
export type CliStreamEvent =
  | { readonly type: 'init'; readonly externalSessionId: string }
  | { readonly type: 'progress'; readonly message: string; readonly activity?: ReportActivity }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'result'; readonly ok: boolean; readonly output: string; readonly externalSessionId?: string }

/** Specification for building one CLI process invocation. */
export interface CliInvocationSpec {
  readonly kind: ExternalAgentKind
  readonly prompt: string
  readonly mapped: boolean
  readonly model?: string
  readonly resumeSessionId?: string
}

/** Resolved executable name, argv, and optional stdin payload for one CLI run. */
export interface CliInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly stdinData?: string
}

/** Inputs to {@link runCliBackend}. */
export interface CliExecOptions extends CliInvocationSpec {
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: CliStreamEvent) => void | Promise<void>
  readonly onActivity?: () => void | Promise<void>
}

/** Settled outcome of one external CLI run. */
export interface CliExecOutcome {
  readonly ok: boolean
  readonly output: string
  readonly externalSessionId?: string
  readonly exitCode: number | null
  readonly stderr: string
}

export const AGENT_CLI_COMMANDS: Readonly<Record<ExternalAgentKind, string>> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'agy': 'agy',
  'cursor': 'cursor-agent',
  'pi': 'pi',
}

const COMMAND_BY_KIND = AGENT_CLI_COMMANDS
const EXTERNAL_KINDS: readonly ExternalAgentKind[] = ['claude-code', 'codex', 'agy', 'cursor', 'pi']

/** Common user-local bin dirs GUI apps on macOS/Linux may omit from ambient PATH. */
function guiFallbackCandidates(command: string): readonly string[] {
  if (process.platform === 'win32' || command.includes('/') || command.includes('\\')) return []
  return [
    join(homedir(), '.local', 'bin', command),
    join(homedir(), '.pi', 'agent', 'bin', command),
    join(homedir(), '.cursor', 'bin', command),
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
  ]
}

/**
 * Resolve one external CLI binary through the subprocess seam, falling back
 * to common user-local bin directories when launched without a login shell PATH.
 */
export async function resolveCliExecutable(
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
        // Keep trying fallback locations before surfacing the primary failure.
      }
    }
    throw primaryError
  }
}

/** Read the first non-empty version line of an external CLI (`<bin> --version`). */
async function probeCliVersion(subprocess: SubprocessRuntime, executablePath: string): Promise<string | undefined> {
  try {
    const handle = subprocess.spawn({
      argv: [executablePath, '--version'],
      cwd: homedir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1000,
      signal: AbortSignal.timeout(2500),
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    const raw = (handle.collected.stdout?.readFrom(0).text ?? '').trim() || (handle.collected.stderr?.readFrom(0).text ?? '').trim()
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim()
    return firstLine === undefined || firstLine === '' ? undefined : firstLine.slice(0, 80)
  } catch {
    return undefined
  }
}

/**
 * Probe local installation availability for every supported `AgentKind`.
 * `builtin` is always available inside the harness host; external CLIs are
 * checked via {@link resolveCliExecutable} and `<bin> --version`.
 */
export async function probeAgentKinds(subprocess?: SubprocessRuntime, signal?: AbortSignal): Promise<readonly AgentKindOption[]> {
  const builtinOption: AgentKindOption = { kind: 'builtin', command: '', available: true }
  const externalOptions = await Promise.all(EXTERNAL_KINDS.map(async (kind): Promise<AgentKindOption> => {
    const command = COMMAND_BY_KIND[kind]
    if (subprocess === undefined) {
      return { kind, command, available: false, reason: 'subprocess runtime unavailable' }
    }
    try {
      const executablePath = await resolveCliExecutable(subprocess, command, signal)
      const version = await probeCliVersion(subprocess, executablePath)
      return {
        kind,
        command,
        available: true,
        executablePath,
        ...(version === undefined ? {} : { version }),
      }
    } catch (error) {
      return {
        kind,
        command,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }))
  return [builtinOption, ...externalOptions]
}

/**
 * Build the headless argv and stdin payload for one external CLI backend.
 * Prompts pass over stdin so long instructions and special characters never
 * collide with OS command-line length limits or shell quoting.
 */
export function buildCliInvocation(spec: CliInvocationSpec): CliInvocation {
  const command = COMMAND_BY_KIND[spec.kind]
  if (spec.kind === 'claude-code') {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', spec.mapped ? 'acceptEdits' : 'plan',
    ]
    if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model)
    if (spec.resumeSessionId !== undefined && spec.resumeSessionId !== '') args.push('--resume', spec.resumeSessionId)
    return { command, args, stdinData: spec.prompt }
  }
  if (spec.kind === 'agy') {
    // In `agy`, `-p`/`--print` is a string flag taking the prompt directly;
    // attach it with `--print=...` after `--output-format` so flags never collide.
    const args: string[] = [
      '--output-format', 'stream-json',
      '--mode', spec.mapped ? 'accept-edits' : 'plan',
    ]
    if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model)
    if (spec.resumeSessionId !== undefined && spec.resumeSessionId !== '') args.push('--conversation', spec.resumeSessionId)
    args.push(`--print=${spec.prompt}`)
    return { command, args }
  }
  if (spec.kind === 'cursor') {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--trust',
    ]
    if (spec.mapped) args.push('--force')
    if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model)
    if (spec.resumeSessionId !== undefined && spec.resumeSessionId !== '') args.push('--resume', spec.resumeSessionId)
    return { command, args, stdinData: spec.prompt }
  }
  if (spec.kind === 'pi') {
    const args: string[] = ['--mode', 'json', '--print']
    if (!spec.mapped) args.push('--tools', 'read,grep,find,ls')
    if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model)
    if (spec.resumeSessionId !== undefined && spec.resumeSessionId !== '') args.push('--session', spec.resumeSessionId)
    return { command, args, stdinData: spec.prompt }
  }
  // Codex CLI (`codex exec --json` / `codex exec resume <id> --json`).
  const args: string[] = spec.resumeSessionId !== undefined && spec.resumeSessionId !== ''
    ? ['exec', 'resume', spec.resumeSessionId, '--json']
    : ['exec', '--json']
  args.push('--sandbox', spec.mapped ? 'workspace-write' : 'read-only')
  if (spec.model !== undefined && spec.model !== '') args.push('--model', spec.model)
  args.push('-')
  return { command, args, stdinData: spec.prompt }
}

const SLASH_COMMAND_LINE_RE = /^\s*(\/[A-Za-z0-9][A-Za-z0-9:_-]*(?=\s|$)[^\r\n]*)(?:\r?\n([\s\S]*))?$/

/**
 * Extract a leading CLI `/command ...` line if `text` starts with one. Paths such
 * as `/Users/foo` contain `/` inside the first token and do not match.
 */
export function extractLeadingSlashCommand(text: string | undefined): {
  readonly commandLine: string
  readonly remainder?: string
} | undefined {
  if (text === undefined) return undefined
  const match = SLASH_COMMAND_LINE_RE.exec(text)
  if (match === null || match[1] === undefined) return undefined
  const commandLine = match[1].trim()
  const remainder = match[2]?.trim()
  return remainder === undefined || remainder === ''
    ? { commandLine }
    : { commandLine, remainder }
}

/**
 * Format a headless external CLI prompt so any leading `/command ...` in a stage
 * instruction, mandate scope, or ticket title appears at line 1 / byte 0 for
 * native CLI parsing while preserving ticket context below.
 */
export function buildExternalCliPrompt(input: {
  readonly candidates: readonly (string | undefined)[]
  readonly bodyLines: readonly (string | undefined)[]
}): string {
  const cleanBody = input.bodyLines.filter((line): line is string => line !== undefined)
  for (const candidate of input.candidates) {
    const extracted = extractLeadingSlashCommand(candidate)
    if (extracted === undefined) continue
    return [
      extracted.commandLine,
      '',
      'Context:',
      ...(extracted.remainder === undefined ? [] : [extracted.remainder]),
      ...cleanBody,
    ].join('\n')
  }
  return cleanBody.join('\n')
}

/** Categorize a tool name into a coarse activity bucket for UI rendering. */
function toolActivityCategory(name: string): ReportActivityCategory {
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command') || lower.includes('shell')) return 'command'
  if (lower.includes('edit') || lower.includes('write') || lower.includes('read') || lower.includes('file')) return 'file'
  return 'tool'
}

/** Summarize one tool call input into a compact human-readable line + structured activity. */
function summarizeToolUse(name: string, input: unknown): { readonly summary: string; readonly activity: ReportActivity } {
  const category = toolActivityCategory(name)
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    const rawTarget = typeof record.file_path === 'string' ? record.file_path
      : typeof record.path === 'string' ? record.path
        : typeof record.command === 'string' ? record.command.slice(0, 80)
          : typeof record.pattern === 'string' ? record.pattern
            : undefined
    const target = rawTarget === undefined ? undefined : rawTarget.trim()
    if (target !== undefined && target !== '') {
      return {
        summary: `${name}: ${target}`,
        activity: { category, toolName: name, target },
      }
    }
  }
  return { summary: name, activity: { category, toolName: name } }
}

/**
 * Parse one NDJSON line emitted by `claude`, `agy`, or `codex` into zero or
 * more normalized {@link CliStreamEvent} items. Non-JSON diagnostic lines are
 * ignored safely.
 */
export function parseCliStreamLine(kind: ExternalAgentKind, rawLine: string): readonly CliStreamEvent[] {
  const trimmed = rawLine.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  if (kind === 'codex') return parseCodexRecord(record)
  if (kind === 'pi') return parsePiRecord(record)
  if (kind === 'agy' && typeof record.event === 'string') return parseAgyRecord(record)
  return parseStreamJsonRecord(record)
}

/** Parse `agy --output-format stream-json` (`{ event, ... }`) NDJSON records. */
function parseAgyRecord(record: Record<string, unknown>): readonly CliStreamEvent[] {
  const events: CliStreamEvent[] = []
  const eventKind = record.event
  if (eventKind === 'init' && typeof record.conversation_id === 'string' && record.conversation_id !== '') {
    events.push({ type: 'init', externalSessionId: record.conversation_id })
  } else if (eventKind === 'step_update' && typeof record.step_update === 'object' && record.step_update !== null) {
    const step = record.step_update as Record<string, unknown>
    if (typeof step.text_delta === 'string' && step.text_delta !== '') {
      events.push({ type: 'text_delta', delta: step.text_delta })
    }
    const stepType = typeof step.step_type === 'string' ? step.step_type : undefined
    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        if (typeof tc !== 'object' || tc === null) continue
        const call = tc as Record<string, unknown>
        if (typeof call.name === 'string') {
          const detail = summarizeToolUse(call.name, call.arguments ?? call.input)
          events.push({ type: 'progress', message: `tool: ${detail.summary}`, activity: detail.activity })
        }
      }
    } else if (stepType !== undefined && stepType !== 'user_input' && stepType !== 'agent_response' && step.state === 'ACTIVE') {
      const resolvedName = typeof step.tool_name === 'string' && step.tool_name !== '' ? step.tool_name
        : typeof step.name === 'string' && step.name !== '' ? step.name
          : typeof step.tool === 'string' && step.tool !== '' ? step.tool
            : stepType
      const detail = summarizeToolUse(resolvedName, step.input ?? step.args ?? step.arguments ?? step)
      if (detail.summary !== 'tool') {
        events.push({ type: 'progress', message: `tool: ${detail.summary}`, activity: detail.activity })
      }
    }
  } else if (eventKind === 'result' && typeof record.result === 'object' && record.result !== null) {
    const res = record.result as Record<string, unknown>
    const status = typeof res.status === 'string' ? res.status : ''
    const ok = status === 'SUCCESS'
    const output = typeof res.response === 'string'
      ? res.response
      : typeof res.error === 'string'
        ? res.error
        : ''
    const sessionId = typeof res.conversation_id === 'string' && res.conversation_id !== '' ? res.conversation_id : undefined
    events.push({
      type: 'result',
      ok,
      output,
      ...(sessionId === undefined ? {} : { externalSessionId: sessionId }),
    })
  }
  return events
}

/** Parse Claude Code / `agy` `--output-format stream-json` events. */
function parseStreamJsonRecord(record: Record<string, unknown>): readonly CliStreamEvent[] {
  const events: CliStreamEvent[] = []
  const type = record.type
  if (type === 'system' && typeof record.session_id === 'string' && record.session_id !== '') {
    events.push({ type: 'init', externalSessionId: record.session_id })
  } else if (type === 'assistant') {
    const message = record.message
    if (typeof message === 'object' && message !== null) {
      const content = (message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const item = block as Record<string, unknown>
          if (item.type === 'tool_use' && typeof item.name === 'string') {
            const detail = summarizeToolUse(item.name, item.input)
            events.push({ type: 'progress', message: `tool: ${detail.summary}`, activity: detail.activity })
          } else if (item.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '') {
            events.push({ type: 'text', text: item.text })
          }
        }
      }
    }
  } else if (type === 'result') {
    const isError = record.is_error === true || (typeof record.subtype === 'string' && record.subtype !== 'success')
    const output = typeof record.result === 'string'
      ? record.result
      : Array.isArray(record.errors)
        ? record.errors.filter((e): e is string => typeof e === 'string').join('; ')
        : ''
    const sessionId = typeof record.session_id === 'string' && record.session_id !== '' ? record.session_id : undefined
    events.push({
      type: 'result',
      ok: !isError,
      output,
      ...(sessionId === undefined ? {} : { externalSessionId: sessionId }),
    })
  }
  return events
}

/** Extract concatenated plain text from a Pi assistant `message.content` field. */
function extractPiText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '') {
      parts.push(item.text)
    }
  }
  return parts.join('\n').trim()
}

/** Parse Pi Agent (`pi --mode json --print`) JSONL session events. */
function parsePiRecord(record: Record<string, unknown>): readonly CliStreamEvent[] {
  const events: CliStreamEvent[] = []
  const type = record.type
  if (type === 'session' && typeof record.id === 'string' && record.id !== '') {
    events.push({ type: 'init', externalSessionId: record.id })
  } else if (type === 'tool_execution_start' && typeof record.toolName === 'string') {
    const detail = summarizeToolUse(record.toolName, record.args)
    events.push({ type: 'progress', message: `tool: ${detail.summary}`, activity: detail.activity })
  } else if (type === 'message_end') {
    const message = record.message
    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>
      if (msg.role === 'assistant') {
        const text = extractPiText(msg.content)
        if (text !== '') events.push({ type: 'text', text })
        const stopReason = msg.stopReason
        if (stopReason === 'error' || stopReason === 'aborted') {
          const errMsg = typeof msg.errorMessage === 'string' && msg.errorMessage !== ''
            ? msg.errorMessage
            : (text !== '' ? text : `pi terminated with stopReason=${stopReason}`)
          events.push({ type: 'result', ok: false, output: errMsg })
        }
      }
    }
  } else if (type === 'agent_settled') {
    const aborted = record.aborted === true
    events.push({ type: 'result', ok: !aborted, output: aborted ? 'aborted' : '' })
  }
  return events
}

/** Parse Codex `exec --json` JSONL events. */
function parseCodexRecord(record: Record<string, unknown>): readonly CliStreamEvent[] {
  const events: CliStreamEvent[] = []
  const type = record.type
  if (type === 'thread.started' && typeof record.thread_id === 'string' && record.thread_id !== '') {
    events.push({ type: 'init', externalSessionId: record.thread_id })
  } else if (type === 'item.started' || type === 'item.completed') {
    const item = record.item
    if (typeof item === 'object' && item !== null) {
      const entry = item as Record<string, unknown>
      if (entry.type === 'agent_message' && type === 'item.completed' && typeof entry.text === 'string' && entry.text.trim() !== '') {
        events.push({ type: 'text', text: entry.text })
      } else if (entry.type === 'command_execution' && type === 'item.started' && typeof entry.command === 'string') {
        const cmd = entry.command.slice(0, 80)
        events.push({ type: 'progress', message: `cmd: ${cmd}`, activity: { category: 'command', toolName: 'command_execution', target: cmd } })
      } else if (entry.type === 'file_change' && type === 'item.completed') {
        events.push({ type: 'progress', message: 'updated workspace files', activity: { category: 'file', toolName: 'file_change' } })
      } else if (entry.type === 'mcp_tool_call' && type === 'item.started' && typeof entry.tool === 'string') {
        events.push({ type: 'progress', message: `tool: ${entry.tool}`, activity: { category: 'tool', toolName: entry.tool } })
      }
    }
  } else if (type === 'turn.failed') {
    const err = record.error
    const message = typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>).message === 'string'
      ? (err as Record<string, unknown>).message as string
      : 'codex turn failed'
    events.push({ type: 'result', ok: false, output: message })
  } else if (type === 'error' && typeof record.message === 'string') {
    events.push({ type: 'result', ok: false, output: record.message })
  } else if (type === 'turn.completed') {
    events.push({ type: 'result', ok: true, output: '' })
  }
  return events
}

/**
 * Execute one external CLI backend through DSH's managed subprocess service,
 * streaming normalized events to `options.onEvent` and settling with the final
 * text output and captured external session id.
 */
export async function runCliBackend(subprocess: SubprocessRuntime, options: CliExecOptions): Promise<CliExecOutcome> {
  const invocation = buildCliInvocation(options)
  const executable = await resolveCliExecutable(subprocess, invocation.command, options.signal)
  const handle = subprocess.spawn({
    argv: [executable, ...invocation.args],
    cwd: options.cwd,
    stdio: {
      stdin: invocation.stdinData !== undefined ? { data: invocation.stdinData } : 'ignore',
      stdout: 'pipe',
      stderr: { maxBytes: 100_000 },
    },
    graceMs: 5_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  let externalSessionId: string | undefined
  let lastText = ''
  let terminalResult: { readonly ok: boolean; readonly output: string } | undefined

  const processLine = async (line: string): Promise<void> => {
    for (const event of parseCliStreamLine(options.kind, line)) {
      if (event.type === 'init') {
        externalSessionId = event.externalSessionId
      } else if (event.type === 'text') {
        lastText = event.text
      } else if (event.type === 'text_delta') {
        lastText += event.delta
      } else if (event.type === 'result') {
        if (event.externalSessionId !== undefined) externalSessionId = event.externalSessionId
        if (terminalResult === undefined || !event.ok) {
          terminalResult = {
            ok: event.ok,
            output: event.output !== '' ? event.output : lastText,
          }
        }
      }
      await options.onEvent?.(event)
    }
  }

  const streamPromise = (async () => {
    const stdout = handle.stdout
    if (stdout === undefined) return
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    for await (const chunk of stdout) {
      await options.onActivity?.()
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        await processLine(line)
        newlineAt = buffer.indexOf('\n')
      }
    }
    buffer += decoder.end()
    if (buffer.trim() !== '') await processLine(buffer)
  })()

  const [outcome] = await Promise.all([handle.done, streamPromise])
  const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  const exitOk = outcome.exitCode === 0 && outcome.signal === null
  const ok = terminalResult !== undefined ? (terminalResult.ok && exitOk) : exitOk
  const output = terminalResult?.output && terminalResult.output !== ''
    ? terminalResult.output
    : lastText !== ''
      ? lastText
      : stderr !== ''
        ? stderr
        : ok ? 'completed' : `CLI exited with code ${String(outcome.exitCode ?? outcome.signal ?? 'unknown')}`

  return {
    ok,
    output,
    ...(externalSessionId === undefined ? {} : { externalSessionId }),
    exitCode: outcome.exitCode,
    stderr,
  }
}
