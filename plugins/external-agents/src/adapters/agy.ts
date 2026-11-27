/**
 * Antigravity (`agy`) adapter over ACP stdio (`agy acp --stdio`), built on top
 * of the shared `AcpSessionBase` transport/pooling layer.
 */
import { homedir } from 'node:os'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AgentCommandOption, AgentModelOption, AgentQuotaSnapshot, AgentReasoning } from '../types.ts'
import { parseAgyUsageOutput } from '../quota-store.ts'
import {
  AcpSessionBase,
  type AcpSessionBaseOptions,
  buildAcpPromptBlocks,
  extractAcpAvailableCommands,
  extractAcpUsageEvent,
  extractReasoningFromSessionResponse,
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

export {
  buildAcpPromptBlocks,
  extractAcpAvailableCommands,
  extractAcpUsageEvent,
  extractReasoningFromSessionResponse,
}

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

export const AGY_PERMISSION_MODES = [
  { id: 'accept-edits', name: 'Accept Edits', description: 'Approve workspace file edits automatically' },
  { id: 'auto', name: 'Auto', description: 'Approve safe commands and edits; block risky operations' },
  { id: 'plan', name: 'Plan', description: 'Read-only planning without workspace modifications' },
  { id: 'default', name: 'Default', description: 'Default mode (deny unapproved operations in unattended runs)' },
  { id: 'bypass', name: 'Bypass Permissions', description: 'Skip all permission prompts' },
] as const

export type AgyAdapterOptions = AcpSessionBaseOptions

export class AgyAdapter extends AcpSessionBase {
  readonly id = 'agy' as const
  readonly label = 'Antigravity'
  readonly command = 'agy'
  readonly permissionModes = AGY_PERMISSION_MODES
  override readonly reasoning = AGY_REASONING
  override readonly defaultPermissionMode = 'accept-edits'

  private readonly readConfiguredModels: () => readonly AgentModelOption[]

  constructor(
    configuredModels: readonly AgentModelOption[] | (() => readonly AgentModelOption[]) = [],
    options: AgyAdapterOptions = {},
  ) {
    super(options)
    this.readConfiguredModels = typeof configuredModels === 'function' ? configuredModels : () => configuredModels
  }

  protected override buildAcpSpawnArgs(_request: ExternalTurnRequest, mode: string): string[] {
    const args = ['acp', '--stdio']
    if (mode === 'bypass') {
      args.push('--dangerously-skip-permissions')
    }
    return args
  }

  protected override buildProbeSpawnArgs(): string[] {
    return ['acp', '--stdio']
  }

  protected override shouldBypassSetMode(mode: string): boolean {
    return mode === 'bypass'
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
        models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_AGY_MODELS),
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
      discovered = await this.probeAcpCatalog(subprocess, executablePath, homedir(), signal)
    } catch (error) {
      if (isExecFormatError(error)) {
        return {
          available: false,
          command: this.command,
          executablePath,
          reason: error instanceof Error ? error.message : String(error),
          models: normalizeModelList(configured.length > 0 ? configured : DEFAULT_AGY_MODELS),
          defaultModel: 'default',
          reasoning: AGY_REASONING,
          defaultPermissionMode: this.defaultPermissionMode,
          permissionModes: this.permissionModes,
          commands: [],
        }
      }
      // Fall back cleanly to defaults if ACP catalog query cannot connect offline.
    }
    const merged = normalizeModelList([
      ...configured,
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
    const discovered = await this.probeAcpCatalog(subprocess, executablePath, targetCwd, signal).catch(() => ({
      models: [],
      commands: [],
    }))
    return discovered.commands
  }

  async probeQuota(subprocess: SubprocessRuntime, signal?: AbortSignal): Promise<AgentQuotaSnapshot> {
    let executablePath: string
    try {
      executablePath = await resolveAgentExecutable(subprocess, this.command, signal)
    } catch (error) {
      return {
        status: 'unavailable',
        source: 'active_cli',
        note: error instanceof Error ? error.message : String(error),
      }
    }
    const timeoutSignal = AbortSignal.timeout(8_000)
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    try {
      const handle = subprocess.spawn({
        argv: [executablePath, '-p', '/usage', '--output-format', 'json'],
        cwd: homedir(),
        env: buildExternalSubprocessEnv(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 128_000 }, stderr: { maxBytes: 16_384 } },
        graceMs: 1_500,
        signal: combinedSignal,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const parsed = parseAgyUsageOutput(stdout)
      if (parsed !== undefined) {
        return parsed
      }
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      return {
        status: 'error',
        source: 'active_cli',
        observedAt: new Date().toISOString(),
        note: stderr !== '' ? stderr.slice(0, 200) : `agy /usage exited with code ${String(outcome.exitCode)}`,
      }
    } catch (error) {
      return {
        status: 'error',
        source: 'active_cli',
        observedAt: new Date().toISOString(),
        note: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
