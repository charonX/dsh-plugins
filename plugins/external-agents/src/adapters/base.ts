/**
 * Shared adapter contract, CLI executable resolution, and process helpers for
 * third-party coding agents.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
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
  readonly readOnly?: boolean
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
  /**
   * Explicit terminal confirmation from streaming/RPC adapters (`true` when a
   * protocol terminal frame was observed; `false` when the stream ended without
   * one). Omitted only for simple/legacy adapters.
   */
  readonly terminalConfirmed?: boolean
  /** Optional diagnostic message when a stream fails closed. */
  readonly error?: string
  /**
   * Positive evidence that the CLI/ACP runtime rejected the supplied
   * `externalSessionId` during session resume/load.
   */
  readonly resumeRejected?: boolean
}

export class ExternalResumeRejectedError extends Error {
  readonly code = 'external-agent/resume-rejected'
  readonly resumeRejected = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExternalResumeRejectedError'
  }
}

export function isResumeRejectedError(error: unknown): boolean {
  if (error instanceof ExternalResumeRejectedError) return true
  if (typeof error === 'object' && error !== null) {
    return (error as { readonly resumeRejected?: unknown }).resumeRejected === true
  }
  return false
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
  probeCommands?(subprocess: SubprocessRuntime, cwd: string, signal?: AbortSignal): Promise<readonly AgentCommandOption[]>
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

export const CLAUDE_CODE_INTERNAL_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
] as const

/**
 * Return true when `key` is an internal Claude Code session/nesting marker that
 * must be stripped before spawning an external CLI, while keeping user-facing
 * `CLAUDE_CODE_*` configuration variables (e.g. `CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_TMPDIR`).
 */
export function isInternalClaudeCodeEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if ((CLAUDE_CODE_INTERNAL_ENV_KEYS as readonly string[]).includes(upper)) {
    return true
  }
  return upper.startsWith('CLAUDECODE_')
}

function listNvmNodeBinDirs(home: string): string[] {
  const versionsDir = join(home, '.nvm', 'versions', 'node')
  if (!existsSync(versionsDir)) return []
  try {
    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    return entries.map(ver => join(versionsDir, ver, 'bin'))
  } catch {
    return []
  }
}

export interface GuiPathOptions {
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<NodeJS.ProcessEnv>
}

/** Common user-local binary directories omitted when launched from macOS/Linux GUI shells. */
export function guiFallbackBinDirs(options: GuiPathOptions = {}): readonly string[] {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const rawDirs: Array<string | undefined> = platform === 'win32'
    ? [
        join(home, '.local', 'bin'),
        join(home, '.cursor', 'bin'),
        env.PNPM_HOME,
        env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'cursor-agent') : undefined,
      ]
    : [
        join(home, '.local', 'bin'),
        join(home, '.cursor', 'bin'),
        join(home, '.pi', 'agent', 'bin'),
        env.PNPM_HOME,
        join(home, 'Library', 'pnpm'),
        join(home, '.local', 'share', 'pnpm'),
        join(home, '.npm-global', 'bin'),
        env.NVM_BIN,
        join(home, '.nvm', 'current', 'bin'),
        ...listNvmNodeBinDirs(home),
        env.FNM_MULTISHELL_PATH ? join(env.FNM_MULTISHELL_PATH, 'bin') : undefined,
        join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
        join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
        join(home, '.fnm', 'aliases', 'default', 'bin'),
        join(home, '.volta', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.cargo', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/local/sbin',
      ]

  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of rawDirs) {
    if (dir === undefined || dir === '') continue
    const normalized = platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(dir)
  }
  return result
}

/** Merge `currentPath` (first, preserving user precedence) with GUI fallback bin dirs. */
export function buildGuiFallbackPath(
  currentPath?: string,
  options: GuiPathOptions = {},
): string {
  const platform = options.platform ?? process.platform
  const sep = platform === 'win32' ? ';' : delimiter
  const existing = (currentPath ?? '')
    .split(sep)
    .map(part => part.trim())
    .filter(part => part !== '')
  const seen = new Set(existing.map(part => (platform === 'win32' ? part.toLowerCase() : part)))
  const merged = [...existing]
  for (const candidate of guiFallbackBinDirs(options)) {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(candidate)
    }
  }
  return merged.join(sep)
}

/** Return a clean string-only env object with internal Claude Code markers removed and GUI PATH enriched. */
export function sanitizeExternalCliEnv(
  baseEnv: Readonly<NodeJS.ProcessEnv> = process.env,
  extraEnv?: Readonly<NodeJS.ProcessEnv>,
  options: GuiPathOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || isInternalClaudeCodeEnvKey(key)) continue
    result[key] = value
  }
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (isInternalClaudeCodeEnvKey(key)) continue
      if (value === undefined) {
        delete result[key]
      } else {
        result[key] = value
      }
    }
  }
  const pathKey = Object.keys(result).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  result[pathKey] = buildGuiFallbackPath(result[pathKey], { ...options, env: { ...baseEnv, ...extraEnv } })
  return result
}

/**
 * Build an `env` overlay for `SubprocessRuntime.spawn({ env })`: emits explicit
 * `undefined` tombstones for all internal Claude Code variables and enriches `PATH`.
 */
export function buildExternalSubprocessEnv(
  extraEnv?: Readonly<NodeJS.ProcessEnv>,
  baseEnv: Readonly<NodeJS.ProcessEnv> = process.env,
  options: GuiPathOptions = {},
): NodeJS.ProcessEnv {
  const envPatch: NodeJS.ProcessEnv = {}
  for (const key of CLAUDE_CODE_INTERNAL_ENV_KEYS) {
    envPatch[key] = undefined
  }
  for (const key of Object.keys(baseEnv)) {
    if (isInternalClaudeCodeEnvKey(key)) {
      envPatch[key] = undefined
    }
  }
  const basePath = baseEnv.PATH ?? baseEnv.Path
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (isInternalClaudeCodeEnvKey(key)) {
        envPatch[key] = undefined
        continue
      }
      envPatch[key] = value
    }
  }
  const overridePathKey = extraEnv ? Object.keys(extraEnv).find(k => k.toUpperCase() === 'PATH') : undefined
  const effectivePath = overridePathKey !== undefined && typeof extraEnv?.[overridePathKey] === 'string'
    ? extraEnv[overridePathKey]
    : basePath
  const targetPathKey = overridePathKey ?? (baseEnv.PATH === undefined && baseEnv.Path !== undefined ? 'Path' : 'PATH')
  const enrichedPath = buildGuiFallbackPath(effectivePath, { ...options, env: { ...baseEnv, ...extraEnv } })
  if (enrichedPath !== '') {
    envPatch[targetPathKey] = enrichedPath
  }
  return envPatch
}

const explainedExecErrors = new WeakSet<object>()
const BLOCKED_POSTINSTALL_CAUSES = 'npm 12 allowScripts, pnpm 10 approve-builds, --ignore-scripts, --omit=optional'

function readErrnoDetails(error: unknown): { readonly code?: string; readonly errno?: number; readonly path?: string; readonly message: string } {
  const visited = new Set<unknown>()
  let cur: unknown = error
  let fallbackMsg = error instanceof Error ? error.message : String(error)
  while (cur !== undefined && cur !== null && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur)
    const rec = cur as { readonly code?: unknown; readonly errno?: unknown; readonly path?: unknown; readonly message?: unknown; readonly cause?: unknown }
    if (typeof rec.message === 'string' && rec.message !== '') {
      fallbackMsg = rec.message
    }
    if (rec.code === 'ENOEXEC' || rec.errno === -8) {
      return {
        code: typeof rec.code === 'string' ? rec.code : 'ENOEXEC',
        ...(typeof rec.errno === 'number' ? { errno: rec.errno } : {}),
        ...(typeof rec.path === 'string' ? { path: rec.path } : {}),
        message: typeof rec.message === 'string' ? rec.message : fallbackMsg,
      }
    }
    cur = rec.cause
  }
  return { message: fallbackMsg }
}

export function isExecFormatError(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const details = readErrnoDetails(error)
  if (details.code === 'ENOEXEC' || details.errno === -8) return true
  const msg = details.message
  if (/\bENOEXEC\b|exec format error/i.test(msg)) return true
  if (process.platform === 'win32' && /not a valid Win32 application|%1 is not a valid/i.test(msg)) return true
  return false
}

export interface ExecFormatRepair {
  readonly packageName: string
  readonly rootDir: string
  readonly command: string
  readonly shell: 'bash' | 'powershell'
}

function shellSingleQuote(value: string, shell: 'bash' | 'powershell'): string {
  if (shell === 'powershell') {
    return `'${value.replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Inspect an unrunnable `bin/` entry point for a sibling `package.json` with a
 * `scripts.postinstall` hook so ENOEXEC diagnostics can provide the exact repair command.
 */
export function npmPackagePostinstallRepair(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): ExecFormatRepair | undefined {
  if (executablePath.trim() === '') return undefined
  const binDir = dirname(executablePath)
  if (basename(binDir).toLowerCase() !== 'bin') return undefined
  const rootDir = dirname(binDir)
  const manifestPath = join(rootDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly name?: unknown
      readonly scripts?: { readonly postinstall?: unknown }
    }
    const postinstall = typeof manifest.scripts?.postinstall === 'string'
      ? manifest.scripts.postinstall.trim()
      : ''
    if (postinstall === '') return undefined
    const packageName = typeof manifest.name === 'string' && manifest.name.trim() !== ''
      ? manifest.name.trim()
      : basename(rootDir)
    const shell: 'bash' | 'powershell' = platform === 'win32' ? 'powershell' : 'bash'
    const command = shell === 'powershell'
      ? `Set-Location ${shellSingleQuote(rootDir, shell)}; ${postinstall}`
      : `cd ${shellSingleQuote(rootDir, shell)} && ${postinstall}`
    return { packageName, rootDir, command, shell }
  } catch {
    return undefined
  }
}

/**
 * Annotate an `ENOEXEC` launch error with an actionable diagnosis (blocked npm
 * postinstall stub, repair command when discoverable). Non-ENOEXEC errors and
 * already-explained errors are returned unchanged.
 */
export function explainExecFormatError(error: unknown, executablePath?: string): Error {
  const baseErr = error instanceof Error ? error : new Error(String(error))
  if (!isExecFormatError(error)) return baseErr
  if (explainedExecErrors.has(baseErr)) return baseErr

  const details = readErrnoDetails(error)
  const target = executablePath?.trim() || details.path?.trim() || 'the agent CLI'
  const repair = target !== 'the agent CLI' ? npmPackagePostinstallRepair(target) : undefined
  const diagnosis = repair !== undefined
    ? `${target} is not a runnable executable on ${process.platform}/${process.arch} (ENOEXEC). It is the bin entry of npm package ${repair.packageName}, so its postinstall likely never ran (${BLOCKED_POSTINSTALL_CAUSES} all block it), leaving a placeholder stub in place. Run \`${repair.command}\` to install the native binary, or reinstall the CLI with install scripts enabled, then retry.`
    : `${target} is not a runnable executable on ${process.platform}/${process.arch} (ENOEXEC). For an npm-installed agent CLI this usually means its postinstall never ran (${BLOCKED_POSTINSTALL_CAUSES} all block it), leaving a placeholder stub at that path. Reinstall the CLI with install scripts enabled, then retry.`

  const wrapped = new Error(`${baseErr.message}: ${diagnosis}`, { cause: baseErr })
  explainedExecErrors.add(wrapped)
  explainedExecErrors.add(baseErr)
  return wrapped
}

function guiFallbackCandidates(command: string): readonly string[] {
  if (process.platform === 'win32' || command.includes('/') || command.includes('\\')) return []
  return guiFallbackBinDirs().map(dir => join(dir, command))
}

/**
 * Resolve an executable through `SubprocessRuntime`, falling back to common
 * user-local bin dirs omitted by GUI launch environments (including `~/.cursor/bin`).
 */
export async function resolveAgentExecutable(
  subprocess: SubprocessRuntime,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await subprocess.resolveExecutable(command, undefined, signal)
  } catch (primaryError) {
    if (signal?.aborted) throw primaryError
    if (!command.includes('/') && !command.includes('\\')) {
      const guiPath = buildGuiFallbackPath(process.env.PATH)
      if (guiPath !== '' && guiPath !== process.env.PATH) {
        try {
          return await subprocess.resolveExecutable(command, { PATH: guiPath }, signal)
        } catch {
          if (signal?.aborted) throw primaryError
        }
      }
    }
    for (const candidate of guiFallbackCandidates(command)) {
      try {
        return await subprocess.resolveExecutable(candidate, undefined, signal)
      } catch {
        if (signal?.aborted) throw primaryError
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
      env: buildExternalSubprocessEnv(),
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
