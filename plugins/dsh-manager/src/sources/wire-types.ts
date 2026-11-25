/**
 * Wire-level types and input schemas of the sources and triggers API —
 * shared by the Host service and the client contribution.
 */
import { z as zod } from 'zod'

/** The Source kinds the client can add. */
export const SOURCE_KINDS = ['jira', 'gitlab-mr', 'gitlab-pipeline'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** The connector families a Thread can carry (`manual` = the user's own input). */
export type ThreadConnector = 'jira' | 'gitlab' | 'manual'

/** The accept modes a Source instance can run under. */
export const ACCEPT_MODES = ['off', 'observe', 'auto'] as const
export type AcceptModeSetting = (typeof ACCEPT_MODES)[number]

/** One Source instance as the wire sees it. */
export interface SourceView {
  readonly id: string
  readonly connectionId: string
  readonly kind: SourceKind | 'manual'
  readonly enabled: boolean
  /** The accept mode of this instance's evals. */
  readonly acceptMode: AcceptModeSetting
  /** The watch query; Jira instances carry a JQL, GitLab watches use defaults. */
  readonly jql?: string
  /** The watched project paths; the GitLab pipeline watch carries them. */
  readonly projects?: readonly string[]
  readonly pollIntervalMs: number
  readonly lastPollAt?: number
  readonly lastError?: string
}

/** Input of adding one Source instance on a connection. */
export interface SourceAddInput {
  readonly connectionId: string
  /** Which Source kind to instantiate; defaults to `jira`. */
  readonly kind?: SourceKind
  /** The accept mode; defaults to `auto`. */
  readonly acceptMode?: AcceptModeSetting
  /** The watch query; defaults to the connector's sensible watch. */
  readonly jql?: string
  /** The watched project paths; the GitLab pipeline watch needs them. */
  readonly projects?: readonly string[]
  /** Poll cadence in millis; clamped to the minimum. */
  readonly pollIntervalMs?: number
}

/** Input of editing one Source instance. */
export interface SourceUpdateInput {
  readonly id: string
  readonly enabled?: boolean
  /** The accept mode of this instance's evals. */
  readonly acceptMode?: AcceptModeSetting
  readonly jql?: string
  readonly pollIntervalMs?: number
}

/** Input addressing one Source instance. */
export interface SourceIdInput {
  readonly id: string
}

/** One Thread as the wire sees it. */
export interface ThreadView {
  readonly id: string
  readonly connectionId: string
  readonly connector: ThreadConnector
  readonly externalKey: string
  readonly title: string
  readonly updatedAt: number
  /** Deep link to the external object, taken from the newest trigger. */
  readonly url: string
}

/** One trigger as the wire sees it. */
export interface TriggerView {
  readonly id: string
  readonly threadId: string
  readonly externalKey: string
  readonly url: string
  readonly occurredAt?: number
  readonly collectedAt: number
}

export const sourceAddInputSchema = zod.object({
  connectionId: zod.string().min(1),
  kind: zod.enum(SOURCE_KINDS).optional(),
  acceptMode: zod.enum(ACCEPT_MODES).optional(),
  jql: zod.string().min(1).optional(),
  projects: zod.array(zod.string().min(1)).optional(),
  pollIntervalMs: zod.number().int().min(10_000).optional(),
})

export const sourceUpdateInputSchema = zod.object({
  id: zod.string().min(1),
  enabled: zod.boolean().optional(),
  acceptMode: zod.enum(ACCEPT_MODES).optional(),
  jql: zod.string().min(1).optional(),
  pollIntervalMs: zod.number().int().min(10_000).optional(),
})

export const sourceIdInputSchema = zod.object({
  id: zod.string().min(1),
})

export const triggerListInputSchema = zod.object({
  threadId: zod.string().min(1),
})

/** The outcome of one poll, reported back to the caller. */
export interface PollOutcome {
  readonly added: number
  readonly duplicates: number
  /** The failure detail when the poll did not succeed. */
  readonly error?: string
}

/** Input of one manual entry from the user. */
export interface ManualInput {
  /** What the user wants done; the trigger's title. */
  readonly title: string
  /** The description carried on the trigger payload. */
  readonly description: string
  /** The DSH project the resulting ticket belongs to, when chosen. */
  readonly projectId?: string
}

export const manualInputSchema = zod.object({
  title: zod.string().min(1),
  description: zod.string().min(1),
  projectId: zod.string().min(1).optional(),
})
