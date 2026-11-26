/**
 * The dispatch domain core: one Executor Session per dispatched ticket,
 * independent of the ticket's own lifecycle (spec §8) — a dispatch's state
 * never mutates its ticket. Pure state machine over the
 * {@link DispatchStorePort} — persistence is a thin adapter, so tests drive
 * this core in memory (ADR-0003).
 */
import { z } from 'zod'
import { AGENT_KINDS, type AgentKind } from '../flow/flow-ir.ts'

/** Lifecycle states a dispatch moves through; the ticket's state is untouched. */
export const DISPATCH_STATES = ['queued', 'running', 'ended'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

/** How the executor reports progress; terminal kinds end the dispatch. */
export const REPORT_KINDS = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'not-needed'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** Terminal outcomes; `interrupted` comes from the boot sweep, the rest from reports. */
export const DISPATCH_OUTCOMES = ['ready', 'failed', 'not-needed', 'interrupted'] as const
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number]

/** The report kinds that end a dispatch. */
const TERMINAL_KINDS: readonly ReportKind[] = ['ready', 'failed', 'not-needed']

/** Whether one report kind ends its dispatch. */
function isTerminalKind(kind: ReportKind): kind is 'ready' | 'failed' | 'not-needed' {
  return TERMINAL_KINDS.includes(kind)
}

/** Structured activity category captured from external CLI streams. */
export const REPORT_ACTIVITY_CATEGORIES = ['tool', 'command', 'file', 'message', 'error'] as const
export type ReportActivityCategory = (typeof REPORT_ACTIVITY_CATEGORIES)[number]

/** Structured metadata attached to a progress/terminal report when available. */
export const reportActivity = z.object({
  category: z.enum(REPORT_ACTIVITY_CATEGORIES),
  toolName: z.string().optional(),
  target: z.string().optional(),
})

export type ReportActivity = z.infer<typeof reportActivity>

/** One executor report. */
export const reportRecord = z.object({
  id: z.string(),
  kind: z.enum(REPORT_KINDS),
  /** What happened or what is needed, verbatim from the executor. */
  message: z.string(),
  /** Optional structured activity breakdown emitted by external CLIs. */
  activity: reportActivity.optional(),
  at: z.number(),
})

export type ReportRecord = z.infer<typeof reportRecord>

/** Provenance of one rendered prompt section stored on a dispatch record. */
export const dispatchPromptSectionRecord = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(['builtin', 'global', 'pipeline', 'stage']),
  locked: z.boolean(),
})

export type DispatchPromptSectionRecord = z.infer<typeof dispatchPromptSectionRecord>

/** Full rendered prompt snapshot persisted on a dispatch record. */
export const dispatchPromptRecord = z.object({
  turnId: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  sections: z.array(dispatchPromptSectionRecord),
  templateRevision: z.number(),
  renderedAt: z.number(),
})

export type DispatchPromptRecord = z.infer<typeof dispatchPromptRecord>

/** One dispatch of a ticket to an Executor Session. */
export const dispatchRecord = z.object({
  id: z.string(),
  /** The ticket being worked on. */
  ticketId: z.string(),
  state: z.enum(DISPATCH_STATES).default('queued'),
  /** Set exactly when the state is `ended`. */
  outcome: z.enum(DISPATCH_OUTCOMES).optional(),
  /** The Executor Session id, set once the session starts. */
  sessionId: z.string().optional(),
  /** The ended dispatch this one continues; marks a resume into its session. */
  resumeOf: z.string().optional(),
  /** Execution backend kind (`builtin`, `claude-code`, `codex`, `agy`). */
  agentKind: z.enum(AGENT_KINDS).optional(),
  /** Sticky external CLI session id captured from stream-json for rework `--resume`. */
  externalSessionId: z.string().optional(),
  /** Rendered prompt snapshot actually dispatched to the executor. */
  prompt: dispatchPromptRecord.optional(),
  /** Every report the executor submitted, in order. */
  reports: z.array(reportRecord).default([]),
  createdAt: z.number(),
  updatedAt: z.number().default(0),
})

export type DispatchRecord = z.infer<typeof dispatchRecord>

/** Durable dispatch storage the scheduler drives; synchronous reads. */
export interface DispatchStorePort {
  getDispatch(id: string): DispatchRecord | undefined
  putDispatch(record: DispatchRecord): Promise<void>
  listDispatches(): readonly DispatchRecord[]
}

/** Create one queued dispatch for a ticket, optionally continuing a prior session. */
export async function enqueueDispatch(
  store: DispatchStorePort,
  ticketId: string,
  now: number,
  options: { readonly sessionId?: string; readonly resumeOf?: string } = {},
): Promise<DispatchRecord> {
  const record: DispatchRecord = {
    id: `dispatch-${crypto.randomUUID()}`,
    ticketId,
    state: 'queued',
    reports: [],
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.resumeOf === undefined ? {} : { resumeOf: options.resumeOf }),
    createdAt: now,
    updatedAt: now,
  }
  await store.putDispatch(record)
  return record
}

/**
 * Move one queued dispatch to `running` under its Executor Session. Anything
 * but `queued` (including a second start) leaves the record untouched.
 */
export async function startDispatch(store: DispatchStorePort, id: string, sessionId: string, now: number): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined || record.state !== 'queued') return undefined
  const updated: DispatchRecord = { ...record, state: 'running', sessionId, updatedAt: now }
  await store.putDispatch(updated)
  return updated
}

/**
 * Append one executor report. Terminal kinds (`ready` / `failed` /
 * `not-needed`) end the dispatch; `progress`, `waiting`, and `blocked` keep
 * it running. A report on an ended dispatch is refused.
 */
export async function recordReport(
  store: DispatchStorePort,
  id: string,
  kind: ReportKind,
  message: string,
  now: number,
  activity?: ReportActivity,
): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined || record.state === 'ended') return undefined
  const report: ReportRecord = {
    id: `report-${crypto.randomUUID()}`,
    kind,
    message,
    ...(activity === undefined ? {} : { activity }),
    at: now,
  }
  const updated: DispatchRecord = isTerminalKind(kind)
    ? { ...record, state: 'ended', outcome: kind, reports: [...record.reports, report], updatedAt: now }
    : { ...record, reports: [...record.reports, report], updatedAt: now }
  await store.putDispatch(updated)
  return updated
}

/** Refresh `updatedAt` on a live dispatch as a liveness heartbeat without adding extra reports. */
export async function touchDispatch(
  store: DispatchStorePort,
  id: string,
  now: number,
): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined || record.state === 'ended' || now <= record.updatedAt) return record
  const updated: DispatchRecord = { ...record, updatedAt: now }
  await store.putDispatch(updated)
  return updated
}

/**
 * Cancel a `queued` or `running` dispatch on explicit operator request:
 * settles as `ended` with outcome `'interrupted'` and records the reason.
 */
export async function cancelDispatch(
  store: DispatchStorePort,
  id: string,
  now: number,
  reason = 'cancelled by user',
): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined || record.state === 'ended') return undefined
  const note: ReportRecord = {
    id: `report-${crypto.randomUUID()}`,
    kind: 'progress',
    message: reason,
    activity: { category: 'error', target: 'cancelled' },
    at: now,
  }
  const updated: DispatchRecord = {
    ...record,
    state: 'ended',
    outcome: 'interrupted',
    reports: [...record.reports, note],
    updatedAt: now,
  }
  await store.putDispatch(updated)
  return updated
}

/**
 * Mark one running dispatch interrupted: the boot sweep's answer to a crash
 * mid-run, so an interrupted dispatch never silently disappears. Queued and
 * ended records are untouched.
 */
export async function interruptDispatch(store: DispatchStorePort, id: string, now: number): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined || record.state !== 'running') return undefined
  const updated: DispatchRecord = { ...record, state: 'ended', outcome: 'interrupted', updatedAt: now }
  await store.putDispatch(updated)
  return updated
}

/**
 * Record the external CLI backend and sticky session id on a dispatch so
 * subsequent rework dispatches on the same ticket resume the prior context.
 */
export async function recordExternalSession(
  store: DispatchStorePort,
  id: string,
  agentKind: AgentKind,
  externalSessionId: string | undefined,
  now: number,
): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined) return undefined
  const updated: DispatchRecord = {
    ...record,
    agentKind,
    ...(externalSessionId === undefined ? {} : { externalSessionId }),
    updatedAt: now,
  }
  await store.putDispatch(updated)
  return updated
}

/** Find the newest sticky external session id recorded for `(ticketId, agentKind)`. */
export function latestExternalSession(
  store: DispatchStorePort,
  ticketId: string,
  agentKind: AgentKind,
): string | undefined {
  return store.listDispatches()
    .filter(record => record.ticketId === ticketId && record.agentKind === agentKind && record.externalSessionId !== undefined && record.externalSessionId !== '')
    .sort((left, right) => right.createdAt - left.createdAt)[0]?.externalSessionId
}

/** Persist the exact rendered prompt snapshot on a dispatch record before execution begins. */
export async function recordDispatchPrompt(
  store: DispatchStorePort,
  id: string,
  prompt: DispatchPromptRecord,
  now: number,
): Promise<DispatchRecord | undefined> {
  const record = store.getDispatch(id)
  if (record === undefined) return undefined
  const updated: DispatchRecord = { ...record, prompt, updatedAt: Math.max(record.updatedAt, now) }
  await store.putDispatch(updated)
  return updated
}
