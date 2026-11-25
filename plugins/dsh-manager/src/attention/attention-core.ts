/**
 * The attention domain core: what the executor raises when the work needs a
 * human (spec stories 55/77/78) — a question now; approval and review join
 * in later slices and are reserved in the kind union. Pure state machine
 * over the {@link AttentionStorePort} — persistence is a thin adapter, so
 * tests drive this core in memory (ADR-0003).
 */
import { z } from 'zod'
import { ACTION_CATEGORIES, type ActionCategory } from '../approval/approval-policy.ts'

/** What a human is asked for: the executor's question or approval, the Steward's acceptance or suggested close, or its policy proposal. */
export const ATTENTION_KINDS = ['question', 'approval', 'review', 'suggest-end', 'policy'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

/** Lifecycle of one attention: waiting for the human, or answered. */
export const ATTENTION_STATUSES = ['pending', 'answered'] as const
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number]

/** The structured external action an approval carries; the Channel replays it verbatim on approval. */
export const attentionAction = z.object({
  category: z.enum(ACTION_CATEGORIES),
  /** The executor tool the action came from. */
  tool: z.string(),
  /** The tool's parsed arguments, replayed verbatim. */
  payload: z.any(),
})

export type AttentionAction = z.infer<typeof attentionAction> & { readonly category: ActionCategory }

/** One attention on a ticket: the executor's structured ask and the user's answer. */
export const attentionRecord = z.object({
  id: z.string(),
  /** The ticket the attention belongs to. */
  ticketId: z.string(),
  /** The dispatch whose Executor Session raised it. */
  dispatchId: z.string(),
  kind: z.enum(ATTENTION_KINDS).default('question'),
  /** The structured question, verbatim from the executor. */
  question: z.string(),
  /** Optional background that helps the user answer. */
  details: z.string().optional(),
  /** The structured external action, present on approvals. */
  action: attentionAction.optional(),
  status: z.enum(ATTENTION_STATUSES).default('pending'),
  /** The user's answer, set exactly when the status is `answered`. */
  answer: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number().default(0),
})

export type AttentionRecord = z.infer<typeof attentionRecord>

/** Durable attention storage; synchronous reads. */
export interface AttentionStorePort {
  getAttention(id: string): AttentionRecord | undefined
  putAttention(record: AttentionRecord): Promise<void>
  listAttentions(): readonly AttentionRecord[]
}

/** The structured ask the executor submits through its `ask_user` tool. */
export interface AttentionAskInput {
  readonly ticketId: string
  readonly dispatchId: string
  readonly kind?: AttentionKind
  readonly question: string
  readonly details?: string
  /** The structured external action, present on approvals. */
  readonly action?: AttentionAction
}

/**
 * Record one new pending attention.
 * @param store - durable attention storage.
 * @param input - the structured ask; the kind defaults to `question`.
 * @param now - epoch millis.
 */
export async function askAttention(store: AttentionStorePort, input: AttentionAskInput, now: number): Promise<AttentionRecord> {
  const record: AttentionRecord = {
    id: `att-${crypto.randomUUID()}`,
    ticketId: input.ticketId,
    dispatchId: input.dispatchId,
    kind: input.kind ?? 'question',
    question: input.question,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.action === undefined ? {} : { action: input.action }),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  await store.putAttention(record)
  return record
}

/**
 * Record the user's answer on one pending attention. Unknown ids and
 * already-answered attentions are refused (the record stays untouched).
 */
export async function answerAttention(store: AttentionStorePort, id: string, answer: string, now: number): Promise<AttentionRecord | undefined> {
  const record = store.getAttention(id)
  if (record === undefined || record.status !== 'pending') return undefined
  const updated: AttentionRecord = { ...record, status: 'answered', answer, updatedAt: now }
  await store.putAttention(updated)
  return updated
}

/**
 * Classify a human's free-form or button reply to a Steward confirmation question:
 * supports UI button values (`confirmed`, `reroute`, `rejected`) as well as natural
 * Chinese/English confirmation/rejection replies entered in free-text fields or IM.
 */
export function classifyConfirmationAnswer(raw: string): 'reroute' | 'reject' | 'confirm' | 'custom' {
  const normalized = raw.trim().toLowerCase()
  if (normalized === '') return 'custom'
  if (/^(?:reroute|re-route)\b|重新路由|重算路由/.test(normalized)) return 'reroute'
  if (/^(?:rejected?|ignored?|no|cancel|abort|decline)\b|^(?:拒绝|取消|放弃|退回|忽略|不跳过|暂不派工|暂不执行|中止|停止)/.test(normalized)) {
    return 'reject'
  }
  if (/^(?:confirmed?|approved?|confirm|approve|yes|ok|go|proceed|continue|skip|wait)\b|^(?:确认|同意|通过|好的|好|可以|继续|允许|跳过|单次派工|直接派工|等待)/.test(normalized)) {
    return 'confirm'
  }
  return 'custom'
}

/** Whether `record` is a Steward auto-rework escalation waiting for human accept/rework decision. */
export function isEscalationAttention(record: Pick<AttentionRecord, 'kind' | 'question'>): boolean {
  return record.kind === 'question' && record.question.includes('decide whether to accept it or rework it yourself')
}

/** Resolve matching pending attentions across the board (or scoped to `ticketId`). */
export async function settleMatchingPendingAttentions(
  store: AttentionStorePort,
  predicate: (record: AttentionRecord) => boolean,
  resolution: string,
  now: number,
  ticketId?: string,
): Promise<readonly AttentionRecord[]> {
  const settled: AttentionRecord[] = []
  for (const record of store.listAttentions()) {
    if (record.status !== 'pending') continue
    if (ticketId !== undefined && record.ticketId !== ticketId) continue
    if (!predicate(record)) continue
    const updated = await answerAttention(store, record.id, resolution, now)
    if (updated !== undefined) settled.push(updated)
  }
  return settled
}

/** Resolve any remaining pending escalation attentions on `ticketId` so duplicates/stale prompts never stack in `待人工`. */
export function settlePendingEscalationAttentions(
  store: AttentionStorePort,
  ticketId: string,
  resolution: string,
  now: number,
): Promise<readonly AttentionRecord[]> {
  return settleMatchingPendingAttentions(store, isEscalationAttention, resolution, now, ticketId)
}
