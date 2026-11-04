/**
 * Configuration schema for Autoloop microkernel plugin.
 *
 * @module @charonx/dsh-autoloop/config
 */

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  maxHops?: number
  autoWorktree?: boolean
  journalPath?: string
  defaultWorkspacePath?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Whether the autoloop microkernel is active'),
  maxHops: Schema.number().default(8).description('Hop limit circuit breaker threshold to stop recursive agent calls'),
  autoWorktree: Schema.boolean().default(false).description('Whether to automatically allocate isolated Git worktrees via ctx.worktrees'),
  journalPath: Schema.string().description('Path to the append-only event-sourcing JSONL journal file'),
  defaultWorkspacePath: Schema.string().description('Fallback workspace path when not specified by external events'),
})
