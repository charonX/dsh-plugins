/**
 * Wire-level types and input schemas for the dsh-im companion bridge.
 */
import { z as zod } from 'zod'

/** A single saved delivery target exposed by dsh-im for a bot. */
export interface ImTargetOption {
  readonly targetId: string
  readonly name?: string
  readonly kind: string
}

/** One configured IM bot from dsh-im with its saved delivery targets. */
export interface ImBotOption {
  readonly botId: string
  readonly channel: string
  readonly targets: readonly ImTargetOption[]
}

/** Durable IM integration preferences surfaced to the Settings UI. */
export interface ImSettingsView {
  readonly enabled: boolean
  readonly botId?: string
  readonly targetId?: string
  readonly notifyAttention: boolean
  readonly notifyProgress: boolean
}

/** Snapshot returned by `imSettings` and `imSettingsUpdate`. */
export interface ImSettingsSnapshotView {
  /** Whether the `@xmanrui/dsh-im` Host service (`ctx.dshIm`) is mounted. */
  readonly available: boolean
  readonly settings: ImSettingsView
  readonly bots: readonly ImBotOption[]
  readonly lastError?: string
}

export const imSettingsUpdateInputSchema = zod.object({
  enabled: zod.boolean().optional(),
  botId: zod.string().trim().max(128).optional(),
  targetId: zod.string().trim().max(128).optional(),
  notifyAttention: zod.boolean().optional(),
  notifyProgress: zod.boolean().optional(),
})

export type ImSettingsUpdateInput = zod.infer<typeof imSettingsUpdateInputSchema>

export const imTestSendInputSchema = zod.object({
  botId: zod.string().trim().min(1).max(128).optional(),
  targetId: zod.string().trim().min(1).max(128).optional(),
})

export type ImTestSendInput = zod.infer<typeof imTestSendInputSchema>
