import type { AgentModelOption, ExternalAgentId } from '../types.ts'
import type { ExternalAgentAdapter } from './base.ts'
import { AgyAdapter } from './agy.ts'
import { ClaudeCodeAdapter } from './claude.ts'
import { PiAdapter } from './pi.ts'
import { CodexAdapter } from './codex.ts'
import { CursorAdapter } from './cursor.ts'

export * from './base.ts'
export { AGY_REASONING, AgyAdapter, type AgyAdapterOptions, buildAcpPromptBlocks, extractAcpAvailableCommands, extractAcpUsageEvent, extractReasoningFromSessionResponse } from './agy.ts'
export { CLAUDE_REASONING, ClaudeCodeAdapter, buildClaudeRunArgs, buildClaudeStreamUserMessage, parseClaudeInitResponse, parseClaudeLine } from './claude.ts'
export { PI_REASONING, PiAdapter, buildPiRunArgs, parsePiCommandsResponse, parsePiLine, parsePiListModelsOutput, parsePiListModelsWithContext } from './pi.ts'
export { CODEX_REASONING, CodexAdapter, buildCodexRunArgs, parseCodexLine } from './codex.ts'
export {
  CURSOR_PERMISSION_MODES,
  CursorAdapter,
  type CursorAdapterOptions,
  type ParsedCursorModelId,
  parseCursorAuthStatus,
  parseCursorListModelsOutput,
  parseCursorModelId,
  resolveCursorModelAndEffort,
} from './cursor.ts'

export type CustomModelsResolver =
  | Partial<Record<ExternalAgentId, readonly AgentModelOption[]>>
  | ((id: ExternalAgentId) => readonly AgentModelOption[])

export function createAdapterMap(
  customModels: CustomModelsResolver = {},
): ReadonlyMap<ExternalAgentId, ExternalAgentAdapter> {
  const resolve = (id: ExternalAgentId): (() => readonly AgentModelOption[]) =>
    typeof customModels === 'function'
      ? () => customModels(id)
      : () => customModels[id] ?? []

  const list: ExternalAgentAdapter[] = [
    new AgyAdapter(resolve('agy')),
    new ClaudeCodeAdapter(resolve('claude-code')),
    new PiAdapter(resolve('pi')),
    new CodexAdapter(resolve('codex')),
    new CursorAdapter(resolve('cursor')),
  ]
  return new Map(list.map(adapter => [adapter.id, adapter]))
}
