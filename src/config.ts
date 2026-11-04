/**
 * Configuration schema for the Autoloop microkernel plugin.
 *
 * Timing lives in `offpeakStart` / `offpeakEnd`: the deployment's own quiet
 * hours, host-local wall clock. Every surface (kernel admission, router
 * narrative, monitor board) reads that one value, so a patch that changes the
 * window changes all of them.
 *
 * @module @charonx/dsh-autoloop/config
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_OFFPEAK_WINDOW } from './shared/schedule.js'

export interface Config {
  enabled?: boolean
  maxHops?: number
  autoWorktree?: boolean
  journalPath?: string
  defaultWorkspacePath?: string
  /** Off-peak window start, `HH:mm` host-local; tickets with mode `offpeak` wait for it. */
  offpeakStart?: string
  /** Off-peak window end, `HH:mm` host-local; equal to the start keeps it open all day. */
  offpeakEnd?: string
  /** Maximum tickets executing at once; further due tickets wait for a free slot. */
  maxConcurrent?: number
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/u

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Whether the autoloop microkernel is active'),
  maxHops: Schema.number().default(8).description('Hop limit circuit breaker threshold to stop recursive agent calls'),
  autoWorktree: Schema.boolean().default(false).description('Whether to automatically allocate isolated Git worktrees via ctx.worktrees'),
  journalPath: Schema.string().description('Path to the append-only event-sourcing JSONL journal file'),
  defaultWorkspacePath: Schema.string().description('Fallback workspace path when not specified by external events'),
  offpeakStart: Schema.string().pattern(CLOCK).default(DEFAULT_OFFPEAK_WINDOW.start)
    .description('Off-peak window start in host-local HH:mm; offpeak tickets start inside this window'),
  offpeakEnd: Schema.string().pattern(CLOCK).default(DEFAULT_OFFPEAK_WINDOW.end)
    .description('Off-peak window end in host-local HH:mm; equal to the start keeps the window open all day'),
  maxConcurrent: Schema.number().default(2)
    .description('Maximum tickets executing at once; due tickets beyond the ceiling wait for a slot'),
})
