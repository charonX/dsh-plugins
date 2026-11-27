/**
 * The ticket timeline core: the append-only ledger of business events that
 * make up a ticket's history — human instructions, executor replies, tool
 * activity, reports, attentions, deliverables, and Steward/system decisions.
 * The Executor Session is only one source of these events, never their
 * storage: the ledger survives session loss, cold resumes, and plugin
 * restarts, and it keeps events that no session ever sees (a Steward rework,
 * a dispatch ending, a deliverable).
 *
 * One record per ticket keeps appends single-record atomic under the domain's
 * write chain (ADR-0003), so `seq` is dense and stable without a separate
 * counter. The store port keeps this module memory-testable.
 */
import { z } from 'zod'
import type { AttentionRecord } from '../attention/attention-core.ts'
import type { DispatchRecord, ReportRecord } from '../dispatch/dispatch-core.ts'

/** What one timeline event records. */
export const TIMELINE_EVENT_KINDS = ['instruction', 'assistant', 'tool', 'report', 'attention', 'artifact', 'system'] as const
export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number]

/** Who produced the event; `steward` and `system` are ticket-level, not session-level. */
export const TIMELINE_AUTHORS = ['user', 'executor', 'steward', 'system'] as const
export type TimelineAuthor = (typeof TIMELINE_AUTHORS)[number]

/** One activity breakdown carried by an executor report, when the backend emitted one. */
export const timelineActivity = z.object({
  category: z.enum(['tool', 'command', 'file', 'message', 'error']),
  toolName: z.string().optional(),
  target: z.string().optional(),
})

export type TimelineActivity = z.infer<typeof timelineActivity>

/**
 * One event on a ticket's timeline. `code` is a stable machine token the
 * client localizes (`turn-started`, `turn-ended`, `answered`, `reopened`,
 * `finished`, `report-progress`, …); `body` is the verbatim text, if any.
 */
export const timelineEventRecord = z.object({
  /** Stable event id; report/attention-derived ids are derived from their source, so replays dedupe. */
  id: z.string(),
  /** Dense per-ticket sequence; the ledger appends under the domain write chain. */
  seq: z.number().int().min(0),
  kind: z.enum(TIMELINE_EVENT_KINDS),
  author: z.enum(TIMELINE_AUTHORS),
  /** Epoch millis the event happened. */
  at: z.number(),
  /** The dispatch (turn) the event belongs to; absent on ticket-level events. */
  turnId: z.string().optional(),
  /** Stable machine token the client localizes. */
  code: z.string().optional(),
  /** Verbatim text: the instruction, reply, question, answer, report, or reason. */
  body: z.string().default(''),
  /** Set when the event is an attention (the ask or its answer). */
  attentionId: z.string().optional(),
  /** Set when the event mirrors one executor report. */
  reportId: z.string().optional(),
  /** Structured activity for tool/command/file events. */
  activity: timelineActivity.optional(),
  /** The executor Session that produced the event, when it came from one. */
  sessionId: z.string().optional(),
  /** The numeric turn inside that Session, when the source carries one. */
  turn: z.number().int().min(0).optional(),
  /** The source event seq inside that Session (workspace change reads use it). */
  sourceSeq: z.number().int().min(0).optional(),
  /** True when the event was derived from historical records on first read. */
  backfilled: z.boolean().optional(),
})

export type TimelineEvent = z.infer<typeof timelineEventRecord>

/** The durable ledger of one ticket. */
export const ticketTimelineRecord = z.object({
  ticketId: z.string(),
  events: z.array(timelineEventRecord).default([]),
  updatedAt: z.number().default(0),
  /** Set once the one-time duplicate compaction ran over this ledger. */
  compactedAt: z.number().optional(),
})

export type TicketTimelineRecord = z.infer<typeof ticketTimelineRecord>

/** Durable timeline storage; synchronous reads. */
export interface TimelineStorePort {
  getTimeline(ticketId: string): TicketTimelineRecord | undefined
  putTimeline(record: TicketTimelineRecord): Promise<void>
  /** Run `update` in the storage write chain; `undefined` when the ticket has no ledger yet. */
  updateTimeline(ticketId: string, update: (current: TicketTimelineRecord) => TicketTimelineRecord): Promise<TicketTimelineRecord | undefined>
  listTimelines(): readonly TicketTimelineRecord[]
}

/**
 * Collapse the duplicate rows older builds wrote: the same executor sentence
 * landed once as an `assistant` event and once as its `message` report, and a
 * re-emitted message landed again. Only *adjacent* equal sentences inside one
 * turn fold, so a deliberate repetition separated by other work survives.
 *
 * The pass is idempotent and records `compactedAt`, so boot scans each ledger
 * once and later appends (already guarded at capture time) stay untouched.
 */
export function compactTimeline(record: TicketTimelineRecord): { record: TicketTimelineRecord; removed: number } {
  const kept: TimelineEvent[] = []
  for (const event of record.events) {
    const speech = event.kind === 'assistant' || event.kind === 'report'
    const previous = kept[kept.length - 1]
    const duplicate = speech
      && previous !== undefined
      && previous.turnId === event.turnId
      && (previous.kind === 'assistant' || previous.kind === 'report')
      && previous.body === event.body
    if (!duplicate) kept.push(event)
  }
  const removed = record.events.length - kept.length
  if (record.compactedAt !== undefined) return { record, removed: 0 }
  return { record: { ...record, events: kept, compactedAt: Date.now() }, removed }
}

/** One event to append; `id` makes replays idempotent. */
export interface AppendTimelineEventInput {
  readonly ticketId: string
  /** Stable id for dedupe; a random one is minted when absent. */
  readonly id?: string
  readonly kind: TimelineEventKind
  readonly author: TimelineAuthor
  readonly at: number
  readonly turnId?: string
  readonly code?: string
  readonly body?: string
  readonly attentionId?: string
  readonly reportId?: string
  readonly activity?: TimelineActivity
  readonly sessionId?: string
  readonly turn?: number
  readonly sourceSeq?: number
  readonly backfilled?: boolean
}

/**
 * Per-ticket serialization for appends. The domain serializes a single
 * `update`, but a first append is a `get` + `put` and two of them can race on
 * a ticket that has no ledger yet; chaining appends of one ticket keeps the
 * `get`/`put`/`update` sequence whole. The map drops settled keys so a long
 * session does not accumulate one entry per ticket.
 */
const appendChains = new Map<string, Promise<void>>()

function serializeAppend<T>(ticketId: string, task: () => Promise<T>): Promise<T> {
  const prior = appendChains.get(ticketId) ?? Promise.resolve()
  const run = prior.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  appendChains.set(ticketId, settled)
  void settled.then(() => { if (appendChains.get(ticketId) === settled) appendChains.delete(ticketId) })
  return run
}

/** Build the event value without mutating storage. */
function eventOf(input: AppendTimelineEventInput, id: string, seq: number): TimelineEvent {
  return {
    id,
    seq,
    kind: input.kind,
    author: input.author,
    at: input.at,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.code === undefined ? {} : { code: input.code }),
    body: input.body ?? '',
    ...(input.attentionId === undefined ? {} : { attentionId: input.attentionId }),
    ...(input.reportId === undefined ? {} : { reportId: input.reportId }),
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.sourceSeq === undefined ? {} : { sourceSeq: input.sourceSeq }),
    ...(input.backfilled === undefined ? {} : { backfilled: input.backfilled }),
  }
}

/**
 * Append one event to a ticket's ledger. An event whose id is already present
 * is a no-op (replays after a crash stay exactly-once), and the first append
 * creates the ledger record.
 * @param store - durable timeline storage.
 * @param input - the event to append.
 * @returns the ledger as it stands after the append.
 */
export function appendTimelineEvent(
  store: TimelineStorePort,
  input: AppendTimelineEventInput,
): Promise<TicketTimelineRecord> {
  return serializeAppend(input.ticketId, () => appendNow(store, input))
}

async function appendNow(
  store: TimelineStorePort,
  input: AppendTimelineEventInput,
): Promise<TicketTimelineRecord> {
  const id = input.id ?? `evt-${crypto.randomUUID()}`
  const current = store.getTimeline(input.ticketId)
  if (current === undefined) {
    const record: TicketTimelineRecord = {
      ticketId: input.ticketId,
      events: [eventOf(input, id, 0)],
      updatedAt: input.at,
    }
    await store.putTimeline(record)
    return record
  }
  if (current.events.some(event => event.id === id)) return current
  const appended = await store.updateTimeline(input.ticketId, ledger => {
    if (ledger.events.some(event => event.id === id)) return ledger
    const last = ledger.events[ledger.events.length - 1]
    const seq = last === undefined ? 0 : last.seq + 1
    return { ...ledger, events: [...ledger.events, eventOf(input, id, seq)], updatedAt: input.at }
  })
  return appended ?? current
}

/** The kind/author/code mapping for one executor report. */
export function eventOfReport(report: ReportRecord): Pick<TimelineEvent, 'kind' | 'author' | 'code'> {
  const category = report.activity?.category
  if (category === 'message') return { kind: 'assistant', author: 'executor', code: `report-${report.kind}` }
  if (category === 'tool' || category === 'command' || category === 'file') {
    return { kind: 'tool', author: 'executor', code: `report-${report.kind}` }
  }
  return { kind: 'report', author: 'executor', code: `report-${report.kind}` }
}

/**
 * Derive the ledger of a ticket from its historical dispatches and attentions.
 * Used on first read of pre-ledger tickets; ids derive from the source record
 * so a repeated backfill never duplicates events.
 * @param ticketId - the ticket whose history is folded in.
 * @param dispatches - every dispatch of the ticket, any order.
 * @param attentions - every attention of the ticket, any order.
 * @param now - epoch millis stamped on the ledger record.
 * @returns the ledger with backfilled events in chronological order.
 */
export function backfillTimeline(
  ticketId: string,
  dispatches: readonly DispatchRecord[],
  attentions: readonly AttentionRecord[],
  now: number,
): TicketTimelineRecord {
  const drafts: Omit<TimelineEvent, 'seq'>[] = []
  for (const dispatch of dispatches) {
    drafts.push({
      id: `dispatch:${dispatch.id}:started`,
      kind: 'system',
      author: 'system',
      at: dispatch.createdAt,
      turnId: dispatch.id,
      code: 'turn-started',
      body: '',
      backfilled: true,
    })
    for (const report of dispatch.reports) {
      const mapped = eventOfReport(report)
      drafts.push({
        id: `report:${dispatch.id}:${report.id}`,
        kind: mapped.kind,
        author: mapped.author,
        at: report.at,
        turnId: dispatch.id,
        ...(mapped.code === undefined ? {} : { code: mapped.code }),
        body: report.message,
        reportId: report.id,
        ...(report.activity === undefined ? {} : { activity: report.activity }),
        backfilled: true,
      })
    }
    if (dispatch.state === 'ended') {
      drafts.push({
        id: `dispatch:${dispatch.id}:ended`,
        kind: 'system',
        author: 'system',
        at: dispatch.updatedAt,
        turnId: dispatch.id,
        code: `turn-ended${dispatch.outcome === undefined ? '' : `:${dispatch.outcome}`}`,
        body: '',
        backfilled: true,
      })
    }
  }
  for (const attention of attentions) {
    drafts.push({
      id: `attention:${attention.id}:asked`,
      kind: 'attention',
      author: 'executor',
      at: attention.createdAt,
      turnId: attention.dispatchId,
      code: `attention-${attention.kind}`,
      body: attention.question,
      attentionId: attention.id,
      backfilled: true,
    })
    if (attention.status === 'answered' && attention.answer !== undefined) {
      drafts.push({
        id: `attention:${attention.id}:answered`,
        kind: 'instruction',
        author: 'user',
        at: attention.updatedAt,
        code: 'answered',
        body: attention.answer,
        attentionId: attention.id,
        backfilled: true,
      })
    }
  }
  drafts.sort((left, right) => left.at - right.at)
  return {
    ticketId,
    events: drafts.map((event, seq) => ({ ...event, seq })),
    updatedAt: now,
  }
}

/** Read one ticket's events in ledger order; an absent ledger reads as empty. */
/** One deliverable recovered from the ledger. */
export interface DeliverableArtifact {
  readonly sessionId: string
  readonly turn: number
  readonly path: string
  readonly description?: string
}

/** One workspace-change record recovered from the ledger. */
export interface ChangeArtifact {
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly files: number
}

/**
 * Recover deliverable and change chips from ledger events, so a drawer opened
 * after the host restarted still lists what a ticket produced.
 * @param events - the ticket's ordered timeline events.
 * @returns ledger-backed artifact refs, in timeline order.
 */
export function artifactsOf(events: readonly TimelineEvent[]): {
  readonly deliverables: readonly DeliverableArtifact[]
  readonly changes: readonly ChangeArtifact[]
} {
  const deliverables: DeliverableArtifact[] = []
  const changes: ChangeArtifact[] = []
  for (const event of events) {
    if (event.kind !== 'artifact' || event.sessionId === undefined) continue
    if (event.code === 'deliverable') {
      const path = event.activity?.target
      if (path === undefined || path === '') continue
      deliverables.push({
        sessionId: event.sessionId,
        turn: event.turn ?? 0,
        path,
        ...(event.body === '' ? {} : { description: event.body }),
      })
      continue
    }
    if (event.code === 'change' && event.sourceSeq !== undefined) {
      const files = Number.parseInt(event.body, 10)
      if (!Number.isFinite(files) || files <= 0) continue
      changes.push({ sessionId: event.sessionId, seq: event.sourceSeq, turn: event.turn ?? 0, files })
    }
  }
  return { deliverables, changes }
}

/** The compact newest-activity line shown on a board card. */
export interface TimelineActivitySummary {
  readonly at: number
  readonly kind: TimelineEventKind
  readonly author: TimelineAuthor
  readonly text?: string
}

const ACTIVITY_TEXT_LIMIT = 72

/**
 * Pick the newest event worth showing on a card, preferring anything a human
 * would recognize over raw tool traffic.
 * @param events - the ticket's ordered timeline events.
 * @returns the summary, or `undefined` when the timeline is empty.
 */
export function summarizeActivity(events: readonly TimelineEvent[]): TimelineActivitySummary | undefined {
  if (events.length === 0) return undefined
  const event = [...events].reverse().find(candidate => candidate.kind !== 'tool') ?? events[events.length - 1]!
  const collapsed = event.body.replace(/\s+/g, ' ').trim()
  const text = collapsed.length > ACTIVITY_TEXT_LIMIT
    ? `${collapsed.slice(0, ACTIVITY_TEXT_LIMIT - 1)}…`
    : collapsed
  return { at: event.at, kind: event.kind, author: event.author, ...(text === '' ? {} : { text }) }
}

export function timelineEventsOf(store: TimelineStorePort, ticketId: string): readonly TimelineEvent[] {
  return store.getTimeline(ticketId)?.events ?? []
}

/**
 * Mirror one dispatch transition into its ticket ledger: turn start, every
 * newly appended report, and the turn end. Event ids derive from the dispatch
 * and report ids, so replaying the same transition (boot sweep, retry) never
 * duplicates events.
 * @param store - durable timeline storage.
 * @param previous - the dispatch record before the write, when it existed.
 * @param next - the dispatch record being written.
 */
export async function recordDispatchTimeline(
  store: TimelineStorePort,
  previous: DispatchRecord | undefined,
  next: DispatchRecord,
): Promise<void> {
  const started = next.state === 'running' && (previous === undefined || previous.state !== 'running')
  if (started) {
    await appendTimelineEvent(store, {
      ticketId: next.ticketId,
      id: `dispatch:${next.id}:started`,
      kind: 'system',
      author: 'system',
      at: next.updatedAt,
      turnId: next.id,
      code: 'turn-started',
    })
  }
  const reports = next.reports.slice(previous?.reports.length ?? 0)
  for (const report of reports) {
    const mapped = eventOfReport(report)
    await appendTimelineEvent(store, {
      ticketId: next.ticketId,
      id: `report:${next.id}:${report.id}`,
      kind: mapped.kind,
      author: mapped.author,
      at: report.at,
      turnId: next.id,
      ...(mapped.code === undefined ? {} : { code: mapped.code }),
      body: report.message,
      reportId: report.id,
      ...(report.activity === undefined ? {} : { activity: report.activity }),
    })
  }
  if (next.state === 'ended' && previous?.state !== 'ended') {
    await appendTimelineEvent(store, {
      ticketId: next.ticketId,
      id: `dispatch:${next.id}:ended`,
      kind: 'system',
      author: 'system',
      at: next.updatedAt,
      turnId: next.id,
      code: `turn-ended${next.outcome === undefined ? '' : `:${next.outcome}`}`,
    })
  }
}

/**
 * Mirror one attention transition into its ticket ledger: the ask when it is
 * created, and the human's answer when it is settled.
 * @param store - durable timeline storage.
 * @param previous - the attention record before the write, when it existed.
 * @param next - the attention record being written.
 */
export async function recordAttentionTimeline(
  store: TimelineStorePort,
  previous: AttentionRecord | undefined,
  next: AttentionRecord,
): Promise<void> {
  if (previous === undefined) {
    await appendTimelineEvent(store, {
      ticketId: next.ticketId,
      id: `attention:${next.id}:asked`,
      kind: 'attention',
      author: 'executor',
      at: next.createdAt,
      turnId: next.dispatchId,
      code: `attention-${next.kind}`,
      body: next.question,
      attentionId: next.id,
    })
    return
  }
  if (previous.status === 'pending' && next.status === 'answered' && next.answer !== undefined) {
    await appendTimelineEvent(store, {
      ticketId: next.ticketId,
      id: `attention:${next.id}:answered`,
      kind: 'instruction',
      author: 'user',
      at: next.updatedAt,
      turnId: next.dispatchId,
      code: 'answered',
      body: next.answer,
      attentionId: next.id,
    })
  }
}
