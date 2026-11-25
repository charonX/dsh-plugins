/**
 * Host service behind the Source instances and the trigger browse page:
 * durable Source configs over storage-domain, a polling scheduler with
 * backoff, and trigger ingestion through the delivery-agnostic domain core.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  DEFAULT_JIRA_JQL, DEFAULT_POLL_INTERVAL_MS, MANUAL_CONNECTION_ID, MANUAL_SOURCE_ID, MIN_POLL_INTERVAL_MS, sourcesDomain,
  type RecordSourceKind, type SourceId, type SourceKind, type SourceRecord,
} from './sources/sources-domain.ts'
import { triggersDomain, type TriggerRecord } from './triggers/triggers-domain.ts'
import { pollJiraIssues } from './sources/jira-poller.ts'
import { pollGitLabMrs } from './sources/gitlab-mr-poller.ts'
import { pollGitLabPipelines } from './sources/gitlab-pipeline-poller.ts'
import {
  sourceAddInputSchema, sourceIdInputSchema, sourceUpdateInputSchema, triggerListInputSchema,
  manualInputSchema,
  type ManualInput, type PollOutcome, type SourceAddInput, type SourceIdInput, type SourceUpdateInput, type SourceView,
  type ThreadView, type TriggerView,
} from './sources/wire-types.ts'
import { createDomainTriggerStore } from './triggers/storage-store.ts'
import { ingestTriggers, threadIdOf } from './triggers/trigger-core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sources-and-triggers API served to the Dsh Manager client. */
    dshManagerSources: DshManagerSources
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed Source instance does not exist. */
    'dshManager/source-not-found': { readonly id: string }
  }
}

/** Sources facet configuration. */
export interface SourcesConfig {}

export const SourcesConfig: z<SourcesConfig> = z.object({})

export type { PollOutcome } from './sources/wire-types.ts'

export type { SourceView, SourceAddInput, SourceUpdateInput, SourceIdInput, ThreadView, TriggerView }

/** The scheduler tick while idle. */
const TICK_MS = 5_000
/** The ceiling of the error backoff. */
const MAX_BACKOFF_MS = 15 * 60_000

export class DshManagerSources extends TypertRemoteService {
  /** Host services the sources API reads. */
  static inject = ['storageDomain', 'dshManagerConnections']

  static Config: z<SourcesConfig> = SourcesConfig

  private domain?: Domain<typeof sourcesDomain>
  private triggers?: Domain<typeof triggersDomain>
  private ticker?: ReturnType<typeof setInterval>
  private polling = new Set<string>()

  constructor(ctx: Context, config: SourcesConfig) {
    super(ctx, 'dshManagerSources', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sourcesDomain)
    this.domain = domain
    const triggerDomain = await this.ctx.storageDomain.open(triggersDomain)
    this.triggers = triggerDomain
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close sources domain')
    this.ctx.effect(() => async () => { await triggerDomain.close() }, 'dsh-manager: close triggers domain')
    // The scheduler ticks idle and polls whatever is due; failures back off
    // and rate limiting is honored through Retry-After.
    this.ticker = setInterval(() => { void this.tick() }, TICK_MS)
    this.ctx.effect(() => () => { clearInterval(this.ticker) }, 'dsh-manager: stop source scheduler')
  }

  /** List every Source instance. */
  @Remote
  async sourceList(): Promise<{ readonly sources: readonly SourceView[] }> {
    const sources = [...this.domain!.table('sources').entries()]
      .map(([, record]) => this.viewOf(record))
    return { sources }
  }

  /** Add one Source instance on a connection and persist it. */
  @Remote
  async sourceAdd(rawInput: SourceAddInput): Promise<SourceView> {
    const input = sourceAddInputSchema.parse(rawInput)
    const connections = await this.ctx.dshManagerConnections.connectionList()
    const connection = connections.connections.find(view => view.id === input.connectionId)
    if (connection === undefined) {
      throw new RemoteError('dshManager/connection-not-found', `connection ${input.connectionId} does not exist`, { id: input.connectionId })
    }
    const kind: SourceKind = input.kind ?? 'jira'
    const requiredConnector = kind === 'jira' ? 'jira' : 'gitlab'
    if (connection.connector !== requiredConnector) {
      throw new RemoteError('dshManager/connection-invalid', `the ${kind} source needs a ${requiredConnector} connection, got ${connection.connector}`, { id: input.connectionId })
    }
    if (kind === 'gitlab-pipeline' && (input.projects === undefined || input.projects.length === 0)) {
      throw new RemoteError('dshManager/connection-invalid', 'the pipeline source needs at least one watched project', { id: input.connectionId })
    }
    const record: SourceRecord = {
      id: crypto.randomUUID(),
      connectionId: input.connectionId,
      kind,
      enabled: true,
      acceptMode: input.acceptMode ?? 'auto',
      ...(kind === 'jira' ? { jql: input.jql ?? DEFAULT_JIRA_JQL } : {}),
      ...(kind === 'gitlab-pipeline' ? { projects: [...input.projects!] } : {}),
      pollIntervalMs: Math.max(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
    }
    await this.domain!.table('sources').put(record.id as SourceId, record)
    return this.viewOf(record)
  }

  /** Edit one Source instance's watch, cadence, or enabled flag. */
  @Remote
  async sourceUpdate(rawInput: SourceUpdateInput): Promise<SourceView> {
    const input = sourceUpdateInputSchema.parse(rawInput)
    const record = this.requireRecord(input.id)
    const updated: SourceRecord = {
      ...record,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.acceptMode === undefined ? {} : { acceptMode: input.acceptMode }),
      ...(input.jql === undefined ? {} : { jql: input.jql }),
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: Math.max(input.pollIntervalMs, MIN_POLL_INTERVAL_MS) }),
    }
    await this.domain!.table('sources').put(record.id as SourceId, updated)
    return this.viewOf(updated)
  }

  /** Poll one Source instance immediately; the scheduler and this share one path. */
  @Remote
  async sourcePoll(rawInput: SourceIdInput): Promise<PollOutcome> {
    const input = sourceIdInputSchema.parse(rawInput)
    return await this.pollOnce(input.id)
  }

  /** Remove one Source instance; its collected triggers and threads stay. */
  @Remote
  async sourceRemove(rawInput: SourceIdInput): Promise<void> {
    const input = sourceIdInputSchema.parse(rawInput)
    this.requireRecord(input.id)
    await this.domain!.table('sources').delete(input.id as SourceId)
  }

  /**
   * Record one manual entry as a `manual` trigger on its own Thread. It walks
   * the normal eval path — the Steward's decision, not the form, mints the
   * ticket. The user's own request is explicit evidence by nature.
   */
  @Remote
  async manualInput(rawInput: ManualInput): Promise<{ readonly threadId: string }> {
    const input = manualInputSchema.parse(rawInput)
    await this.ensureManualSource()
    const now = Date.now()
    const externalKey = `manual-${crypto.randomUUID().slice(0, 8)}`
    const store = createDomainTriggerStore(this.triggers!)
    const outcome = await ingestTriggers(store, [{
      sourceId: MANUAL_SOURCE_ID,
      connectionId: MANUAL_CONNECTION_ID,
      connector: 'manual',
      externalKey,
      fingerprint: `input-${now}`,
      title: input.title,
      payload: { kind: 'manual', description: input.description, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) },
      url: '',
    }], now)
    if (outcome.added.length !== 1) {
      throw new RemoteError('dshManager/connection-invalid', 'the manual entry collided with an existing trigger', { id: externalKey })
    }
    return { threadId: threadIdOf(MANUAL_CONNECTION_ID, externalKey) }
  }

  /** Create the single manual Source instance once; later calls keep it. */
  private async ensureManualSource(): Promise<void> {
    const existing = this.domain!.table('sources').get(MANUAL_SOURCE_ID as SourceId)
    if (existing !== undefined) return
    const record: SourceRecord = {
      id: MANUAL_SOURCE_ID,
      connectionId: MANUAL_CONNECTION_ID,
      kind: 'manual',
      enabled: false,
      acceptMode: 'auto',
      pollIntervalMs: MIN_POLL_INTERVAL_MS,
    }
    await this.domain!.table('sources').put(record.id as SourceId, record)
  }

  /** List every thread, most recently updated first. */
  @Remote
  async threadList(): Promise<{ readonly threads: readonly ThreadView[] }> {
    const store = createDomainTriggerStore(this.triggers!)
    const threads = store.listThreads().map((record): ThreadView => {
      const latest = store.listThreadTriggers(record.id)[0]
      return {
        id: record.id,
        connectionId: record.connectionId,
        connector: record.connector,
        externalKey: record.externalKey,
        title: record.title,
        updatedAt: record.updatedAt,
        url: latest?.url ?? '',
      }
    })
    return { threads }
  }

  /** List the triggers of one thread, newest first. */
  @Remote
  async triggerList(rawInput: { readonly threadId: string }): Promise<{ readonly triggers: readonly TriggerView[] }> {
    const input = triggerListInputSchema.parse(rawInput)
    const store = createDomainTriggerStore(this.triggers!)
    const triggers = store.listThreadTriggers(input.threadId).map((record): TriggerView => ({
      id: record.id,
      threadId: record.threadId,
      externalKey: record.externalKey,
      url: record.url,
      ...(record.occurredAt === undefined ? {} : { occurredAt: record.occurredAt }),
      collectedAt: record.collectedAt,
    }))
    return { triggers }
  }

  /** The full trigger records of one thread, newest first (host-internal use). */
  threadTriggers(threadId: string): readonly TriggerRecord[] {
    const store = createDomainTriggerStore(this.triggers!)
    return store.listThreadTriggers(threadId)
  }

  /** The trigger facts the board's backlog derivation needs, oldest first. */
  listTriggerFacts(): readonly { readonly id: string; readonly threadId: string; readonly acceptMode: string }[] {
    const store = createDomainTriggerStore(this.triggers!)
    const modes = new Map<string, string>()
    for (const [, record] of this.domain!.table('sources').entries()) {
      modes.set(record.id, record.acceptMode)
    }
    // listTriggers is newest-first; the backlog derivation wants oldest first.
    return store.listTriggers()
      .map(record => ({ id: record.id, threadId: record.threadId, acceptMode: modes.get(record.sourceId) ?? 'auto' }))
      .reverse()
  }

  /** The connection and Source kind each thread came from (host-internal use). */
  listThreadFacts(): readonly { readonly id: string; readonly connectionId: string; readonly kind: RecordSourceKind }[] {
    const store = createDomainTriggerStore(this.triggers!)
    const kinds = new Map<string, RecordSourceKind>()
    for (const [, record] of this.domain!.table('sources').entries()) {
      kinds.set(record.id, record.kind)
    }
    // A thread's kind rides the Source instance that produced its triggers.
    const threadKinds = new Map<string, RecordSourceKind>()
    for (const record of store.listTriggers()) {
      if (!threadKinds.has(record.threadId)) {
        threadKinds.set(record.threadId, kinds.get(record.sourceId) ?? 'manual')
      }
    }
    return store.listThreads().map(record => ({
      id: record.id,
      connectionId: record.connectionId,
      kind: threadKinds.get(record.id) ?? 'manual',
    }))
  }

  private viewOf(record: SourceRecord): SourceView {
    return {
      id: record.id,
      connectionId: record.connectionId,
      kind: record.kind,
      enabled: record.enabled,
      acceptMode: record.acceptMode,
      ...(record.jql === undefined ? {} : { jql: record.jql }),
      ...(record.projects === undefined ? {} : { projects: record.projects }),
      pollIntervalMs: record.pollIntervalMs,
      ...(record.lastPollAt === undefined ? {} : { lastPollAt: record.lastPollAt }),
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    }
  }

  private requireRecord(id: string): SourceRecord {
    const record = this.domain!.table('sources').get(id as SourceId)
    if (record === undefined) {
      throw new RemoteError('dshManager/source-not-found', `source ${id} does not exist`, { id })
    }
    return record
  }

  /** Poll every due enabled instance. */
  private async tick(): Promise<void> {
    const now = Date.now()
    for (const [, record] of this.domain!.table('sources').entries()) {
      if (!record.enabled || this.polling.has(record.id)) continue
      if (this.nextDueAt(record) > now) continue
      void this.pollOnce(record.id).catch(() => {
        // Poll failures are durable facts on the record, not scheduler crashes.
      })
    }
  }

  /** When the instance should poll next: the base cadence, doubled after an error. */
  private nextDueAt(record: SourceRecord): number {
    const cadence = record.lastError === undefined
      ? record.pollIntervalMs
      : Math.min(record.pollIntervalMs * 2, MAX_BACKOFF_MS)
    return Math.max((record.lastPollAt ?? 0) + cadence, record.rateLimitedUntil ?? 0)
  }

  /** One poll: fetch, ingest through the domain core, and persist the progress facts. */
  private async pollOnce(sourceId: string): Promise<PollOutcome> {
    if (this.polling.has(sourceId)) return { added: 0, duplicates: 0 }
    this.polling.add(sourceId)
    try {
      const record = this.requireRecord(sourceId)
      if (record.kind === 'manual') return { added: 0, duplicates: 0 }
      const facts = await this.ctx.dshManagerConnections.resolveConnectionFacts(record.connectionId)
      const result = facts === undefined
        ? { ok: false as const, reason: 'invalid-credentials' as const, detail: 'no credential stored for the source connection' }
        : record.kind === 'gitlab-mr'
          ? await pollGitLabMrs(facts.baseUrl, facts.auth)
          : record.kind === 'gitlab-pipeline'
            ? await pollGitLabPipelines(facts.baseUrl, facts.auth, record.projects ?? [])
            : await pollJiraIssues(facts.baseUrl, facts.auth, record.jql ?? DEFAULT_JIRA_JQL)
      if (!result.ok) {
        await this.markError(sourceId, `${result.reason}: ${result.detail}`,
          result.reason === 'rate-limited' ? result.retryAfterMs : undefined)
        return { added: 0, duplicates: 0, error: `${result.reason}: ${result.detail}` }
      }
      // The poller does not know the source; the ingest stamps identity here.
      const incoming = result.issues.map(issue => ({ ...issue, sourceId, connectionId: record.connectionId }))
      const store = createDomainTriggerStore(this.triggers!)
      const outcome = await ingestTriggers(store, incoming, Date.now())
      const cursor = incoming.reduce((latest, issue) => issue.fingerprint > latest ? issue.fingerprint : latest, record.cursor ?? '')
      const updated: SourceRecord = {
        ...record,
        ...(cursor === '' ? {} : { cursor }),
        lastPollAt: Date.now(),
      }
      await this.domain!.table('sources').put(sourceId as SourceId, updated)
      return { added: outcome.added.length, duplicates: outcome.duplicates }
    } finally {
      this.polling.delete(sourceId)
    }
  }

  private async markError(sourceId: string, detail: string, retryAfterMs?: number): Promise<void> {
    const record = this.requireRecord(sourceId)
    const updated: SourceRecord = {
      ...record,
      lastPollAt: Date.now(),
      lastError: detail,
      ...(retryAfterMs === undefined ? {} : { rateLimitedUntil: Date.now() + retryAfterMs }),
    }
    await this.domain!.table('sources').put(sourceId as SourceId, updated)
  }
}

export default DshManagerSources
