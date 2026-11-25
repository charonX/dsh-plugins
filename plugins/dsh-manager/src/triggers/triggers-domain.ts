import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable trigger identity (content-derived). */
export type TriggerId = Branded<'TriggerId'>

/** Stable thread identity: one external object's change stream. */
export type ThreadId = Branded<'ThreadId'>

/** One collected change from a Source instance. */
export const triggerRecord = z.object({
  /** Content-derived id; the same change never lands twice. */
  id: z.string(),
  /** The Source instance that collected the change. */
  sourceId: z.string(),
  /** The Thread the trigger belongs to (one external object = one Thread). */
  threadId: z.string(),
  /** Connector family the trigger came from (`manual` = the user's own input). */
  connector: z.enum(['jira', 'gitlab', 'manual']),
  /** Connector-specific external object key (e.g. a Jira issue key). */
  externalKey: z.string(),
  /** The change fingerprint inside the external object (e.g. an updated stamp). */
  fingerprint: z.string(),
  /** Connector-specific payload, opaque to the domain core. */
  payload: z.unknown(),
  /** Deep link back to the external object. */
  url: z.string(),
  /** Epoch millis of the external change, when the connector knows it. */
  occurredAt: z.number().optional(),
  /** Epoch millis when this bundle collected the change. */
  collectedAt: z.number(),
})

export type TriggerRecord = z.infer<typeof triggerRecord>

/** One Thread: the durable grouping of every trigger from one external object. */
export const threadRecord = z.object({
  id: z.string(),
  /** The connection the external object lives under. */
  connectionId: z.string(),
  /** Connector family (`manual` = the user's own input). */
  connector: z.enum(['jira', 'gitlab', 'manual']),
  /** Connector-specific external object key. */
  externalKey: z.string(),
  /** Latest display title seen for the external object. */
  title: z.string(),
  /** Epoch millis of the newest trigger in the thread. */
  updatedAt: z.number(),
})

export type ThreadRecord = z.infer<typeof threadRecord>

/**
 * Durable collected changes and their threads. Trigger ids are derived from
 * content (see `triggerIdOf`), so re-collecting the same change is a no-op
 * and a restart can never duplicate history.
 */
export const triggersDomain = defineDomain({
  name: 'dsh_manager_triggers',
  version: 1,
  tables: {
    triggers: domainTable<TriggerId, TriggerRecord>(triggerRecord),
    threads: domainTable<ThreadId, ThreadRecord>(threadRecord),
  },
})
