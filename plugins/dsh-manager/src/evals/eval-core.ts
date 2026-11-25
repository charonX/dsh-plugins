/**
 * The eval domain core: per-thread serial evals with batching, and
 * idempotent ticket acceptance. Pure functions over a storage port — the
 * main Session service drives it, tests script it directly.
 */
import type { EvalRecord, Mandate, TicketRecord } from '../board-domain.ts'

/** The storage face the core needs; the storage-domain adapter implements it. */
export interface EvalStorePort {
  getEval(id: string): EvalRecord | undefined
  putEval(record: EvalRecord): Promise<void>
  listThreadEvals(threadId: string): readonly EvalRecord[]
  listEvals(): readonly EvalRecord[]
  getTicket(id: string): TicketRecord | undefined
  putTicket(record: TicketRecord): Promise<void>
  listTickets(): readonly TicketRecord[]
}

/** One pending-eval fact: a thread whose triggers await the next batch. */
export interface ThreadBacklog {
  readonly threadId: string
  /** The pending trigger ids, in arrival order. */
  readonly triggerIds: readonly string[]
}

/** The minimal trigger fact the backlog derivation needs. */
export interface BacklogTrigger {
  readonly id: string
  readonly threadId: string
}

/**
 * Derive the eval backlog: every trigger not yet covered by a settled or
 * in-flight eval, grouped into its thread in arrival order. A `failed` eval
 * is inconclusive — its triggers re-queue for the next batch. A thread with
 * a live ticket (any state but `ended`) is subscribed: its new triggers fan
 * out to that ticket as context instead of being evaluated, so a follow-up
 * discussion never mints a second ticket. The trigger list must arrive
 * oldest first.
 * @param triggers - every collected trigger, oldest first.
 * @param evals - every eval record, any order.
 * @param tickets - every ticket record, any order; subscriptions derive from `threadId`.
 * @returns one backlog entry per thread with pending triggers.
 */
export function pendingBacklog(
  triggers: readonly BacklogTrigger[],
  evals: readonly EvalRecord[],
  tickets: readonly Pick<TicketRecord, 'threadId' | 'state'>[] = [],
): ThreadBacklog[] {
  const covered = new Set<string>()
  for (const evalRecord of evals) {
    if (evalRecord.status === 'failed') continue
    for (const triggerId of evalRecord.triggerIds) covered.add(triggerId)
  }
  // A live ticket subscribes its originating thread: new triggers there are
  // context for the ticket, not new work.
  const subscribed = new Set(
    tickets.filter(ticket => ticket.state !== 'ended' && ticket.threadId !== '')
      .map(ticket => ticket.threadId))
  const backlog = new Map<string, string[]>()
  for (const trigger of triggers) {
    if (covered.has(trigger.id)) continue
    if (subscribed.has(trigger.threadId)) continue
    const batch = backlog.get(trigger.threadId)
    if (batch === undefined) backlog.set(trigger.threadId, [trigger.id])
    else batch.push(trigger.id)
  }
  return [...backlog].map(([threadId, triggerIds]) => ({ threadId, triggerIds }))
}

/** The decision the main Session records through its decision tool. */
export interface EvalDecision {
  readonly action: 'accept' | 'stop' | 'ignore'
  readonly strength: 'explicit' | 'inferred'
  /** The ticket title when accepting. */
  readonly title?: string
  /** What the mandate covers when accepting. */
  readonly scope?: string
  /** Existing ticket ID that absorbs/resolves this thread, when ignoring as duplicate/subsumed. */
  readonly supersededBy?: string
  /** Free-form rationale kept verbatim. */
  readonly rationale: string
}

/** The policy face: strength → action in the current mode. */
export type AcceptMode = 'off' | 'observe' | 'auto' | 'confirm'
export type AcceptPolicy = (strength: 'explicit' | 'inferred', mode: AcceptMode) => 'accept' | 'ask' | 'reject'

/**
 * The default policy: explicit evidence auto-accepts in auto mode; a human
 * confirms everything in observe mode (and the legacy confirm); off never
 * produces a candidate. Inferred evidence always asks, even in auto mode.
 */
export const defaultAcceptPolicy: AcceptPolicy = (strength, mode) => {
  if (mode === 'off') return 'reject'
  if (mode !== 'auto') return 'ask'
  return strength === 'explicit' ? 'accept' : 'ask'
}

/** The version the shipped policy rules carry. */
export const POLICY_VERSION = '1'

/** The outcome of finishing one eval. */
export interface FinishOutcome {
  readonly eval: EvalRecord
  /** The ticket the acceptance produced or reused, when accepted. */
  readonly ticket?: TicketRecord
}

/**
 * Start one eval over a thread's pending triggers. The same thread runs at
 * most one eval at a time; callers batch triggers that arrived while a prior
 * eval ran into the next one.
 * @param store - the eval storage port.
 * @param threadId - the thread to evaluate.
 * @param triggerIds - the batch's trigger ids, in arrival order.
 * @param evalId - the caller's eval id.
 * @param now - epoch millis the eval started.
 * @param policyVersion - the Policy version this eval runs under.
 * @returns the running eval record.
 * @throws when the thread already has a running eval.
 */
export async function startEval(
  store: EvalStorePort,
  threadId: string,
  triggerIds: readonly string[],
  evalId: string,
  now: number,
  policyVersion: string = POLICY_VERSION,
): Promise<EvalRecord> {
  const running = store.listThreadEvals(threadId).find(evalRecord => evalRecord.status === 'running')
  if (running !== undefined) {
    throw new Error(`thread ${threadId} already has a running eval ${running.id}`)
  }
  const record: EvalRecord = {
    id: evalId,
    threadId,
    triggerIds: [...triggerIds],
    status: 'running',
    startedAt: now,
    policyVersion,
  }
  await store.putEval(record)
  return record
}

/** The external origin facts a minted ticket carries back to its object. */
export interface TicketOrigin {
  /** The connection the originating external object lives under. */
  readonly sourceConnectionId?: string
  /** The connector-specific external object key (e.g. a Jira issue key). */
  readonly externalKey?: string
  /** Deep link back to the external object. */
  readonly url?: string
  /** The DSH project the ticket belongs to, when the input named one. */
  readonly projectId?: string
}

/**
 * Finish one eval with the recorded decision. Acceptance runs the policy:
 * only an accepted action under the policy creates a ticket, and the same
 * trigger accepted twice never produces a second ticket — the ticket that
 * already covers any of the batch's triggers is reused.
 * @param store - the eval storage port.
 * @param evalId - the eval to finish.
 * @param decision - the decision the main Session recorded.
 * @param policy - the accept policy to run the strength under.
 * @param mode - the accept mode the eval's Source runs under.
 * @param now - epoch millis the eval finished.
 * @param origin - the external origin facts the minted ticket carries.
 * @returns the finished eval and, on acceptance, its ticket.
 * @throws when the eval does not exist or is not running.
 */
export async function finishEval(
  store: EvalStorePort,
  evalId: string,
  decision: EvalDecision,
  policy: AcceptPolicy = defaultAcceptPolicy,
  mode: AcceptMode = 'auto',
  now: number = Date.now(),
  origin: TicketOrigin = {},
): Promise<FinishOutcome> {
  const evalRecord = store.getEval(evalId)
  if (evalRecord === undefined) throw new Error(`eval ${evalId} does not exist`)
  // A human confirms a candidate through this path too: the recorded
  // acceptance finishes into its ticket.
  if (evalRecord.status !== 'running' && evalRecord.status !== 'candidate') {
    throw new Error(`eval ${evalId} is not running`)
  }

  const verdict = policy(decision.strength, mode)
  if (decision.action !== 'accept' || verdict !== 'accept') {
    if (decision.action === 'accept' && verdict === 'ask') {
      // An acceptance the Policy wants a human to confirm lands as a
      // candidate in the inbox; the user's acceptance mints the ticket.
      const finished: EvalRecord = { ...evalRecord, status: 'candidate', finishedAt: now }
      await store.putEval(finished)
      return { eval: finished }
    }
    // A declined eval always ends rejected; `failed` is reserved for
    // inconclusive runs and `incomplete` for retired batches.
    const finished: EvalRecord = { ...evalRecord, status: 'rejected', finishedAt: now }
    await store.putEval(finished)
    return { eval: finished }
  }

  // Idempotent acceptance: a ticket covering any batch trigger wins.
  const coveringEval = store.listEvals().find(previous =>
    previous.status === 'accepted'
    && previous.ticketId !== undefined
    && previous.triggerIds.some(triggerId => evalRecord.triggerIds.includes(triggerId)))
  const mandate: Mandate = {
    // A candidate finishing through the human path carries the user's own
    // confirmation, which is explicit by definition.
    strength: evalRecord.status === 'candidate' ? 'explicit' : decision.strength,
    scope: decision.scope ?? '',
    policyVersion: evalRecord.policyVersion,
  }
  const existingTicketId = coveringEval?.ticketId
  const existing = existingTicketId === undefined ? undefined : store.getTicket(existingTicketId)
  if (existing !== undefined) {
    const finished: EvalRecord = { ...evalRecord, status: 'accepted', ticketId: existing.id, finishedAt: now }
    await store.putEval(finished)
    return { eval: finished, ticket: existing }
  }
  const ticket: TicketRecord = {
    id: `ticket-${evalId}`,
    title: decision.title ?? evalRecord.threadId,
    threadId: evalRecord.threadId,
    state: 'todo',
    mandate,
    ...(origin.sourceConnectionId === undefined ? {} : { sourceConnectionId: origin.sourceConnectionId }),
    ...(origin.externalKey === undefined ? {} : { externalKey: origin.externalKey }),
    ...(origin.url === undefined ? {} : { url: origin.url }),
    ...(origin.projectId === undefined ? {} : { projectId: origin.projectId }),
    createdAt: now,
    updatedAt: now,
  }
  await store.putTicket(ticket)
  const finished: EvalRecord = { ...evalRecord, status: 'accepted', ticketId: ticket.id, finishedAt: now }
  await store.putEval(finished)
  return { eval: finished, ticket }
}

/**
 * End one running eval without a model decision. `failed` marks an
 * inconclusive run whose triggers re-queue; `incomplete` retires the batch
 * after repeated inconclusive runs, so it stops re-queuing.
 * @param store - the eval storage port.
 * @param evalId - the eval to abandon.
 * @param outcome - whether this run re-queues or retires its triggers.
 * @param now - epoch millis the eval was abandoned.
 * @returns the abandoned eval record.
 * @throws when the eval does not exist or is not running.
 */
export async function abandonEval(
  store: EvalStorePort,
  evalId: string,
  outcome: 'failed' | 'incomplete',
  now: number = Date.now(),
): Promise<EvalRecord> {
  const evalRecord = store.getEval(evalId)
  if (evalRecord === undefined) throw new Error(`eval ${evalId} does not exist`)
  if (evalRecord.status !== 'running') throw new Error(`eval ${evalId} is not running`)
  const finished: EvalRecord = { ...evalRecord, status: outcome, finishedAt: now }
  await store.putEval(finished)
  return finished
}

/**
 * Re-queue a retired eval: the user asks the steward to try its trigger batch
 * again. `failed` records already re-queue on their own; an `incomplete`
 * record re-queues only through here, so its batch re-enters the backlog and
 * the next tick evaluates it fresh.
 * @param store - the eval storage port.
 * @param evalId - the eval to re-queue.
 * @param now - epoch millis the re-queue happened.
 * @returns the re-queued eval record.
 * @throws when the eval does not exist or is not in a re-queueable state.
 */
export async function requeueEval(
  store: EvalStorePort,
  evalId: string,
  now: number = Date.now(),
): Promise<EvalRecord> {
  const evalRecord = store.getEval(evalId)
  if (evalRecord === undefined) throw new Error(`eval ${evalId} does not exist`)
  if (evalRecord.status !== 'failed' && evalRecord.status !== 'incomplete') {
    throw new Error(`eval ${evalId} is not re-queueable (status ${evalRecord.status})`)
  }
  const requeued: EvalRecord = { ...evalRecord, status: 'failed', finishedAt: now }
  await store.putEval(requeued)
  return requeued
}

/**
 * Drop every running eval that started under a different Policy version, so a
 * policy change re-evaluates in-flight batches under the new rules. Dropped
 * evals end `failed`: their triggers re-queue (no settled eval covers them),
 * and the next sweep re-runs them under the new version.
 * @param store - the eval storage port.
 * @param currentPolicyVersion - the Policy version now in force.
 * @param now - epoch millis the drop happened.
 * @returns the eval records the drop retired.
 */
export async function dropRunningEvals(
  store: EvalStorePort,
  currentPolicyVersion: string,
  now: number = Date.now(),
): Promise<readonly EvalRecord[]> {
  const dropped: EvalRecord[] = []
  for (const evalRecord of store.listEvals()) {
    if (evalRecord.status !== 'running') continue
    if (evalRecord.policyVersion === currentPolicyVersion) continue
    dropped.push(await abandonEval(store, evalRecord.id, 'failed', now))
  }
  return dropped
}
