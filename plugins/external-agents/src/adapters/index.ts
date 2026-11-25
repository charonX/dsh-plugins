import type { ExternalAgentId } from '../types.ts'
import type { ExternalAgentAdapter } from './base.ts'
import { AgyAdapter } from './agy.ts'
import { ClaudeCodeAdapter } from './claude.ts'
import { PiAdapter } from './pi.ts'
import { CodexAdapter } from './codex.ts'

export * from './base.ts'
export { AGY_REASONING, AgyAdapter, type AgyAdapterOptions, buildAcpPromptBlocks, extractAcpAvailableCommands, extractAcpUsageEvent, extractReasoningFromSessionResponse } from './agy.ts'
export { CLAUDE_REASONING, ClaudeCodeAdapter, buildClaudeRunArgs, buildClaudeStreamUserMessage, parseClaudeInitResponse, parseClaudeLine } from './claude.ts'
export { PI_REASONING, PiAdapter, buildPiRunArgs, parsePiCommandsResponse, parsePiLine, parsePiListModelsOutput, parsePiListModelsWithContext } from './pi.ts'
export { CODEX_REASONING, CodexAdapter, buildCodexRunArgs, parseCodexLine } from './codex.ts'

export function createAdapterMap(
  customModels: Partial<Record<ExternalAgentId, readonly { readonly id: string; readonly name: string }[]>> = {},
): ReadonlyMap<ExternalAgentId, ExternalAgentAdapter> {
  const list: ExternalAgentAdapter[] = [
    new AgyAdapter(customModels.agy ?? []),
    new ClaudeCodeAdapter(customModels['claude-code'] ?? []),
    new PiAdapter(customModels.pi ?? []),
    new CodexAdapter(customModels.codex ?? []),
  ]
  return new Map(list.map(adapter => [adapter.id, adapter]))
}
