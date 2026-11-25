import { createHash } from 'node:crypto'
import type { ThreadId, TriggerId } from './triggers-domain.ts'

/** One change a connector hands to the domain core; delivery-agnostic. */
export interface IncomingTrigger {
  /** The Source instance that collected the change. */
  readonly sourceId: string
  /** The connection the external object lives under. */
  readonly connectionId: string
  /** Connector family the trigger came from (`manual` = the user's own input). */
  readonly connector: 'jira' | 'gitlab' | 'manual'
  /** Connector-specific external object key (e.g. a Jira issue key). */
  readonly externalKey: string
  /** The change fingerprint inside the external object (e.g. an updated stamp). */
  readonly fingerprint: string
  /** Latest display title for the external object. */
  readonly title: string
  /** Connector-specific payload, opaque to the domain core. */
  readonly payload: unknown
  /** Deep link back to the external object. */
  readonly url: string
  /** Epoch millis of the external change, when the connector knows it. */
  readonly occurredAt?: number
}

/** The storage face the core needs; the storage-domain adapter implements it. */
export interface TriggerStorePort {
  getTrigger(id: string): { readonly fingerprint: string } | undefined
  putTrigger(record: {
    id: string
    sourceId: string
    threadId: string
    connector: 'jira' | 'gitlab' | 'manual'
    externalKey: string
    fingerprint: string
    payload: unknown
    url: string
    collectedAt: number
    occurredAt?: number
  }): Promise<void>
  getThread(id: string): { readonly updatedAt: number } | undefined
  putThread(record: {
    id: string
    connectionId: string
    connector: 'jira' | 'gitlab' | 'manual'
    externalKey: string
    title: string
    updatedAt: number
  }): Promise<void>
}

/** The content-derived trigger id: same source, object, and change → same id. */
export function triggerIdOf(sourceId: string, externalKey: string, fingerprint: string): TriggerId {
  const hash = createHash('sha256').update(`${sourceId}|${externalKey}|${fingerprint}`).digest('hex')
  return `trg-${hash.slice(0, 24)}` as TriggerId
}

/** The content-derived thread id: one external object on one connection. */
export function threadIdOf(connectionId: string, externalKey: string): ThreadId {
  const hash = createHash('sha256').update(`${connectionId}|${externalKey}`).digest('hex')
  return `thr-${hash.slice(0, 24)}` as ThreadId
}

/**
 * Whether one trigger's payload says the external object has ended: a merged
 * or closed MR, a resolved/closed/done Jira issue (spec story 66). The
 * "suggest end" decision reads this; it never ends a ticket by itself.
 */
export function externalObjectEnded(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  if (record['kind'] === 'mr') return record['state'] === 'merged' || record['state'] === 'closed'
  if (record['kind'] === 'jira') {
    return record['resolution'] !== undefined
      || record['status'] === 'Resolved' || record['status'] === 'Closed' || record['status'] === 'Done'
  }
  return false
}

/** The result of one ingest batch. */
export interface IngestResult {
  /** Newly stored triggers. */
  readonly added: readonly string[]
  /** Triggers skipped because their id already existed. */
  readonly duplicates: number
}

/**
 * Ingest a batch of collected changes. The entry point is delivery-agnostic:
 * a poller today, a webhook tomorrow — dedupe and thread grouping live here.
 * @param store - the trigger storage port.
 * @param incoming - changes collected since the last ingest.
 * @param now - epoch millis the batch was collected at.
 * @returns the added trigger ids and the duplicate count.
 */
export async function ingestTriggers(
  store: TriggerStorePort,
  incoming: readonly IncomingTrigger[],
  now: number,
): Promise<IngestResult> {
  const added: string[] = []
  let duplicates = 0
  for (const change of incoming) {
    const id = triggerIdOf(change.sourceId, change.externalKey, change.fingerprint)
    const existing = store.getTrigger(id)
    if (existing !== undefined) {
      duplicates += 1
      continue
    }
    const threadId = threadIdOf(change.connectionId, change.externalKey)
    const thread = store.getThread(threadId)
    await store.putTrigger({
      id,
      sourceId: change.sourceId,
      threadId,
      connector: change.connector,
      externalKey: change.externalKey,
      fingerprint: change.fingerprint,
      payload: change.payload,
      url: change.url,
      collectedAt: now,
      ...(change.occurredAt === undefined ? {} : { occurredAt: change.occurredAt }),
    })
    await store.putThread({
      id: threadId,
      connectionId: change.connectionId,
      connector: change.connector,
      externalKey: change.externalKey,
      title: change.title,
      updatedAt: Math.max(thread?.updatedAt ?? 0, change.occurredAt ?? now),
    })
    added.push(id)
  }
  return { added, duplicates }
}
