/**
 * Cursor Agent (`agent` / `cursor-agent`) adapter over ACP stdio (`agent acp`),
 * built on top of the shared `AcpSessionBase` transport/pooling layer.
 */
import { homedir } from 'node:os'
import { methods, type RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  AgentAuthStatus,
  AgentCommandOption,
  AgentModelOption,
} from '../types.ts'
import { parseContextSizeString } from '../context-windows.ts'
import {
  AcpSessionBase,
  type AcpSessionBaseOptions,
  type PooledAcpSession,
  classifyAcpMcpPermission,
  formatAcpError,
} from './acp-base.ts'
import {
  buildExternalSubprocessEnv,
  isExecFormatError,
  normalizeModelList,
  probeAgentVersion,
  resolveAgentExecutable,
  type ExternalProbeResult,
  type ExternalTurnRequest,
} from './base.ts'

const CURSOR_COMMAND_CANDIDATES = ['agent', 'cursor-agent'] as const

const DEFAULT_CURSOR_MODELS: readonly AgentModelOption[] = [
  { id: 'default', name: 'Auto (Cursor default)' },
]

export const CURSOR_PERMISSION_MODES = [
  { id: 'agent', name: 'Agent', description: 'Full agent capabilities with tool access' },
  { id: 'plan', name: 'Plan', description: 'Read-only mode for planning and designing before implementation' },
  { id: 'ask', name: 'Ask', description: 'Q&A mode - no edits or command execution' },
] as const

export interface ParsedCursorModelId {
  readonly rawId: string
  readonly baseId: string
  readonly params: Readonly<Record<string, string>>
  readonly effort?: string
  readonly contextWindow?: number
  readonly fast?: boolean
  readonly thinking?: boolean
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[A-Za-z]/gu
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/gu
const EFFORT_SUFFIX_RE = /(?:^|-)(low|medium|high|xhigh|max)$/iu

function stripTerminalArtifacts(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, '').replace(ZERO_WIDTH_RE, '')
}

/**
 * Parse Cursor parameterized `modelId` syntax such as
 * `claude-opus-5-5[context=300k,effort=medium,fast=false]` or
 * `gemini-4-neon[context=300k,reasoning_effort=high]`.
 */
export function parseCursorModelId(modelId: string): ParsedCursorModelId {
  const trimmed = modelId.trim()
  const match = /^([^\[\]]+?)(?:\[(.*)\])?$/u.exec(trimmed)
  if (match === null) {
    return { rawId: trimmed, baseId: trimmed, params: {} }
  }
  const baseId = match[1]!.trim()
  const rawParams = (match[2] ?? '').trim()
  const params: Record<string, string> = {}
  if (rawParams !== '') {
    for (const part of rawParams.split(',')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const key = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (key !== '' && value !== '') {
        params[key] = value
      }
    }
  }
  const effort = params.effort ?? params.reasoning_effort ?? params.reasoning
  const contextWindow = parseContextSizeString(params.context)
  const fast = params.fast === 'true' ? true : params.fast === 'false' ? false : undefined
  const thinking = params.thinking === 'true' ? true : params.thinking === 'false' ? false : undefined
  return {
    rawId: trimmed,
    baseId,
    params,
    ...(effort === undefined ? {} : { effort }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(fast === undefined ? {} : { fast }),
    ...(thinking === undefined ? {} : { thinking }),
  }
}

/**
 * Parse non-secret login status from `agent status` stdout/stderr without
 * exposing user email addresses or credential strings.
 */
export function parseCursorAuthStatus(raw: string, exitCode?: number | null): AgentAuthStatus | undefined {
  const clean = stripTerminalArtifacts(raw).trim()
  if (clean === '' && (exitCode === undefined || exitCode === null || exitCode === 0)) {
    return undefined
  }
  if (/\bnot\s+logged\s+in\b|\bunauthenticated\b|run\s+['"]?(?:agent|cursor-agent)\s+login/iu.test(clean)) {
    return {
      authenticated: false,
      method: 'cursor_login',
      summary: 'Not logged in',
    }
  }
  if (/\blogged\s+in\b|\bauthenticated\b/iu.test(clean) && (exitCode === undefined || exitCode === null || exitCode === 0)) {
    return {
      authenticated: true,
      method: 'cursor_login',
      summary: 'Logged in',
    }
  }
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    return {
      authenticated: false,
      method: 'cursor_login',
      summary: 'Not logged in',
    }
  }
  return undefined
}

/** Parse `agent --list-models` stdout into fallback model options. */
export function parseCursorListModelsOutput(raw: string): readonly AgentModelOption[] {
  const clean = stripTerminalArtifacts(raw)
  const out: AgentModelOption[] = []
  const seen = new Set<string>()
  for (const line of clean.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || /^available models$/iu.test(trimmed)) continue
    const sep = trimmed.indexOf(' - ')
    if (sep === -1) continue
    const rawId = trimmed.slice(0, sep).trim()
    const rawName = trimmed.slice(sep + 3).trim()
    if (rawId === '' || seen.has(rawId)) continue
    seen.add(rawId)
    if (rawId === 'auto') {
      if (!seen.has('default')) {
        seen.add('default')
        out.push({ id: 'default', name: 'Auto (Cursor default)' })
      }
      continue
    }
    out.push({ id: rawId, name: rawName || rawId })
  }
  return out
}

function stripCliVariantSuffix(baseId: string): { readonly base: string; readonly effort?: string; readonly fast?: boolean } {
  let current = baseId.trim()
  let fast: boolean | undefined
  if (current.endsWith('-fast')) {
    fast = true
    current = current.slice(0, -'-fast'.length)
  }
  const effortMatch = EFFORT_SUFFIX_RE.exec(current)
  let effort: string | undefined
  if (effortMatch !== null) {
    effort = effortMatch[1]!.toLowerCase()
    current = current.slice(0, current.length - effortMatch[0].length)
  }
  return {
    base: current,
    ...(effort === undefined ? {} : { effort }),
    ...(fast === undefined ? {} : { fast }),
  }
}

/**
 * Resolve a requested model and optional reasoning effort into an exact
 * `modelId` accepted by Cursor's `session/set_config_option("model", ...)`.
 */
export function resolveCursorModelAndEffort(
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  advertisedModelIds: ReadonlySet<string>,
): { readonly targetModelId?: string; readonly unknownModel?: string } {
  const trimmedModel = requestedModel?.trim() ?? ''
  const trimmedEffort = requestedEffort?.trim().toLowerCase() || undefined

  if (trimmedModel === '' || trimmedModel === 'default' || trimmedModel === 'default[]') {
    if (advertisedModelIds.has('default[]')) {
      return { targetModelId: 'default[]' }
    }
    return trimmedModel === 'default[]' ? { targetModelId: 'default[]' } : {}
  }

  if (advertisedModelIds.size === 0) {
    return { targetModelId: trimmedModel }
  }

  if (advertisedModelIds.has(trimmedModel)) {
    if (trimmedEffort === undefined) {
      return { targetModelId: trimmedModel }
    }
    const parsedExact = parseCursorModelId(trimmedModel)
    if (parsedExact.effort?.toLowerCase() === trimmedEffort) {
      return { targetModelId: trimmedModel }
    }
    const matchingVariant = [...advertisedModelIds].find((candidate) => {
      const parsed = parseCursorModelId(candidate)
      return parsed.baseId === parsedExact.baseId && parsed.effort?.toLowerCase() === trimmedEffort
    })
    return { targetModelId: matchingVariant ?? trimmedModel }
  }

  const parsedReq = parseCursorModelId(trimmedModel)
  const cliStripped = stripCliVariantSuffix(parsedReq.baseId)
  const desiredEffort = trimmedEffort ?? parsedReq.effort?.toLowerCase() ?? cliStripped.effort
  const desiredFast = parsedReq.fast ?? cliStripped.fast

  const candidates = [...advertisedModelIds].filter((candidate) => {
    const base = parseCursorModelId(candidate).baseId
    return base === parsedReq.baseId || base === cliStripped.base
  })

  if (candidates.length === 0) {
    return { unknownModel: trimmedModel }
  }

  let best = candidates[0]!
  let bestScore = -1
  for (const candidate of candidates) {
    const parsed = parseCursorModelId(candidate)
    let score = 0
    if (desiredEffort !== undefined && parsed.effort?.toLowerCase() === desiredEffort) score += 2
    if (desiredFast !== undefined && parsed.fast === desiredFast) score += 1
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return { targetModelId: best }
}

function formatCursorModelDisplayName(modelId: string, rawName: string): string {
  const parsed = parseCursorModelId(modelId)
  const details: string[] = []
  if (parsed.effort !== undefined) details.push(parsed.effort)
  if (parsed.params.context !== undefined) details.push(parsed.params.context)
  if (parsed.fast === true) details.push('fast')
  const baseName = rawName.trim() || parsed.baseId
  if (details.length === 0) return baseName
  return `${baseName} (${details.join(' · ')})`
}

export type CursorAdapterOptions = AcpSessionBaseOptions

export class CursorAdapter extends AcpSessionBase {
  readonly id = 'cursor' as const
  readonly label = 'Cursor'
  readonly command = 'agent'
  readonly permissionModes = CURSOR_PERMISSION_MODES
  override readonly defaultPermissionMode = 'agent'

  private readonly readConfiguredModels: () => readonly AgentModelOption[]

  constructor(
    configuredModels: readonly AgentModelOption[] | (() => readonly AgentModelOption[]) = [],
    options: CursorAdapterOptions = {},
  ) {
    super({
      ...options,
      probeTimeoutMs: options.probeTimeoutMs ?? 12_000,
      probeCommandsWaitMs: options.probeCommandsWaitMs ?? 1_500,
    })
    this.readConfiguredModels = typeof configuredModels === 'function' ? configuredModels : () => configuredModels
  }

  protected override async resolveExecutable(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<string> {
    let firstError: unknown
    for (const candidate of CURSOR_COMMAND_CANDIDATES) {
      try {
        return await resolveAgentExecutable(subprocess, candidate, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        firstError ??= error
      }
    }
    throw firstError ?? new Error('Cursor Agent CLI ("agent" / "cursor-agent") was not found on PATH')
  }

  protected override buildAcpSpawnArgs(_request: ExternalTurnRequest, _mode: string): string[] {
    return ['acp']
  }

  protected override buildProbeSpawnArgs(): string[] {
    return ['acp']
  }

  protected override validateRequestedModel(session: PooledAcpSession, model: string | undefined): void {
    const resolved = resolveCursorModelAndEffort(model, undefined, session.advertisedModelIds)
    if (resolved.unknownModel !== undefined) {
      throw new Error(
        `Unknown model "${resolved.unknownModel}" for ${this.label} (available: ${[...session.advertisedModelIds].join(', ')})`,
      )
    }
  }

  protected override async applyTurnConfiguration(
    session: PooledAcpSession,
    request: ExternalTurnRequest,
    mode: string,
  ): Promise<void> {
    const resolved = resolveCursorModelAndEffort(
      request.model,
      request.reasoningEffort,
      session.advertisedModelIds,
    )
    if (resolved.unknownModel !== undefined) {
      throw new Error(
        `Unknown model "${resolved.unknownModel}" for ${this.label} (available: ${[...session.advertisedModelIds].join(', ')})`,
      )
    }

    if (session.lastModeApplied !== mode) {
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

    const targetModelId = resolved.targetModelId
    if (
      targetModelId !== undefined
      && session.lastModelApplied !== targetModelId
      && !(session.lastModelApplied === undefined && targetModelId === 'default[]' && session.initialModelId === 'default[]')
    ) {
      try {
        await session.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.externalSessionId,
          configId: 'model',
          value: targetModelId,
        })
      } catch (error) {
        throw new Error(
          `ACP session/set_config_option("model", "${targetModelId}") failed: ${formatAcpError(error)}`,
          { cause: error },
        )
      }
      session.lastModelApplied = targetModelId
    }
  }

  protected override shouldAllowPermission(
    params: RequestPermissionRequest,
    session: PooledAcpSession,
  ): boolean {
    if (session.permissionPolicy === 'reject') return false
    if (session.mode === 'agent') return true
    const allowKind = params.toolCall.kind
    const mcpMatch = classifyAcpMcpPermission(params.toolCall, session.mcpServers)
    if (session.mode === 'plan' || session.mode === 'ask') {
      return allowKind === 'read'
        || allowKind === 'search'
        || allowKind === 'think'
        || mcpMatch.isReadOnlyBridgedMcp
    }
    return false
  }

  private async probeAuthStatus(
    subprocess: SubprocessRuntime,
    executablePath: string,
    signal?: AbortSignal,
  ): Promise<AgentAuthStatus | undefined> {
    const timeoutSignal = AbortSignal.timeout(4_000)
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    try {
      const handle = subprocess.spawn({
        argv: [executablePath, 'status'],
        cwd: homedir(),
        env: buildExternalSubprocessEnv(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8_192 }, stderr: { maxBytes: 8_192 } },
        graceMs: 1_000,
        signal: combinedSignal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return parseCursorAuthStatus(`${stdout}\n${stderr}`, outcome.exitCode)
    } catch {
      return undefined
    }
  }

  private async probeListModels(
    subprocess: SubprocessRuntime,
    executablePath: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentModelOption[]> {
    const timeoutSignal = AbortSignal.timeout(5_000)
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    try {
      const handle = subprocess.spawn({
        argv: [executablePath, '--list-models'],
        cwd: homedir(),
        env: buildExternalSubprocessEnv(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32_768 }, stderr: { maxBytes: 8_192 } },
        graceMs: 1_000,
        signal: combinedSignal,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) return []
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      return parseCursorListModelsOutput(stdout)
    } catch {
      return []
    }
  }

  async probe(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<ExternalProbeResult> {
    const configured = this.readConfiguredModels()
    let executablePath: string
    try {
      executablePath = await this.resolveExecutable(subprocess, signal)
    } catch (error) {
      return {
        available: false,
        command: this.command,
        reason: error instanceof Error ? error.message : String(error),
        models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_CURSOR_MODELS),
        defaultModel: 'default',
        defaultPermissionMode: this.defaultPermissionMode,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }

    let acpCatalog: {
      readonly models: readonly AgentModelOption[]
      readonly commands: readonly AgentCommandOption[]
    } = { models: [], commands: [] }
    let acpError: unknown
    const [version, authStatus, listModels] = await Promise.all([
      probeAgentVersion(subprocess, executablePath),
      this.probeAuthStatus(subprocess, executablePath, signal),
      this.probeListModels(subprocess, executablePath, signal),
      this.probeAcpCatalog(subprocess, executablePath, homedir(), signal)
        .then((res) => {
          acpCatalog = res
        })
        .catch((err) => {
          acpError = err
        }),
    ])

    if (isExecFormatError(acpError)) {
      return {
        available: false,
        command: this.command,
        executablePath,
        reason: acpError instanceof Error ? acpError.message : String(acpError),
        models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_CURSOR_MODELS),
        defaultModel: 'default',
        defaultPermissionMode: this.defaultPermissionMode,
        permissionModes: this.permissionModes,
        commands: [],
      }
    }

    const modelContextWindows: Record<string, number> = {}
    const acpModels: AgentModelOption[] = []
    for (const item of acpCatalog.models) {
      if (item.id === 'default[]') {
        acpModels.push({ id: 'default', name: 'Auto (Cursor default)' })
        continue
      }
      const parsed = parseCursorModelId(item.id)
      if (parsed.contextWindow !== undefined) {
        modelContextWindows[item.id] = parsed.contextWindow
      }
      acpModels.push({
        id: item.id,
        name: formatCursorModelDisplayName(item.id, item.name),
      })
    }

    const discoveredModels = acpModels.length > 0
      ? acpModels
      : (listModels.length > 0 ? listModels : DEFAULT_CURSOR_MODELS)
    const merged = normalizeModelList([...configured, ...discoveredModels])

    return {
      available: true,
      command: this.command,
      executablePath,
      ...(version === undefined ? {} : { version }),
      ...(authStatus === undefined ? {} : { authStatus }),
      models: merged,
      ...(Object.keys(modelContextWindows).length > 0 ? { modelContextWindows } : {}),
      defaultModel: 'default',
      defaultPermissionMode: this.defaultPermissionMode,
      permissionModes: this.permissionModes,
      commands: acpCatalog.commands,
    }
  }

  async probeCommands(
    subprocess: SubprocessRuntime,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentCommandOption[]> {
    let executablePath: string
    try {
      executablePath = await this.resolveExecutable(subprocess, signal)
    } catch {
      return []
    }
    const targetCwd = cwd.trim() === '' ? homedir() : cwd
    const discovered = await this.probeAcpCatalog(subprocess, executablePath, targetCwd, signal).catch(() => ({
      models: [],
      commands: [],
    }))
    return discovered.commands
  }
}
