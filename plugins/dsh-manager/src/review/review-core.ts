/**
 * The review domain core: what the Steward's main Session records when a
 * dispatch reports ready (spec stories 58–60, 64/65). A pass mints an
 * acceptance Attention for the human; a rework re-enters execution with the
 * opinion as input; automatic reworks are capped per ticket, and only the
 * human's acceptance can end a ticket. Pure functions over the
 * {@link ReviewStorePort} — persistence is a thin adapter, so tests drive
 * this core in memory (ADR-0003).
 */
import { z } from 'zod'

/** Automatic reworks a ticket allows before the decision goes to a human. */
export const MAX_AUTO_REWORKS = 2

/** The review verdicts the Steward can record on a finished dispatch. */
export const REVIEW_VERDICTS = ['pass', 'rework'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Who made the call: the Steward's automatic review, or the human's return. */
export const REVIEW_ORIGINS = ['steward', 'human'] as const
export type ReviewOrigin = (typeof REVIEW_ORIGINS)[number]

/** One recorded review verdict over one finished dispatch. */
export const reviewRecord = z.object({
  id: z.string(),
  /** The ticket the reviewed dispatch worked on. */
  ticketId: z.string(),
  /** The dispatch whose result was reviewed. */
  dispatchId: z.string(),
  /** The review round for the ticket: 1, 2, 3… in decision order. */
  round: z.number(),
  verdict: z.enum(REVIEW_VERDICTS),
  /** The rework opinion, or the acceptance summary on a pass. */
  feedback: z.string(),
  origin: z.enum(REVIEW_ORIGINS).default('steward'),
  decidedAt: z.number(),
})

export type ReviewRecord = z.infer<typeof reviewRecord>

/** Durable review storage; synchronous reads. */
export interface ReviewStorePort {
  getReview(id: string): ReviewRecord | undefined
  putReview(record: ReviewRecord): Promise<void>
  listReviews(): readonly ReviewRecord[]
}

/** One verdict the Steward (or the human, on a return) submits. */
export interface ReviewInput {
  readonly ticketId: string
  readonly dispatchId: string
  readonly verdict: ReviewVerdict
  readonly feedback: string
  readonly origin?: ReviewOrigin
}

/**
 * Record one review verdict. The round numbers the ticket's reviews in
 * decision order, so the audit trail reads like the conversation it was.
 */
export async function recordReview(store: ReviewStorePort, input: ReviewInput, now: number): Promise<ReviewRecord> {
  const prior = store.listReviews().filter(record => record.ticketId === input.ticketId)
  const record: ReviewRecord = {
    id: `review-${crypto.randomUUID()}`,
    ticketId: input.ticketId,
    dispatchId: input.dispatchId,
    round: prior.length + 1,
    verdict: input.verdict,
    feedback: input.feedback,
    origin: input.origin ?? 'steward',
    decidedAt: now,
  }
  await store.putReview(record)
  return record
}

/** The Steward reworks so far on a ticket; a human return does not consume the automatic budget. */
export function autoReworkCount(reviews: readonly ReviewRecord[], ticketId: string): number {
  return reviews.filter(record =>
    record.ticketId === ticketId && record.verdict === 'rework' && record.origin === 'steward').length
}

/** What a verdict does next: mint an acceptance, re-dispatch, or ask the human. */
export const REVIEW_PATHS = ['acceptance', 'auto-rework', 'human'] as const
export type ReviewPath = (typeof REVIEW_PATHS)[number]

/**
 * The path one verdict takes: a pass always mints an acceptance; a rework
 * re-dispatches while the automatic budget lasts, then goes to a human.
 */
export function reviewPath(verdict: ReviewVerdict, autoReworks: number): ReviewPath {
  if (verdict === 'pass') return 'acceptance'
  return autoReworks < MAX_AUTO_REWORKS ? 'auto-rework' : 'human'
}

/** The events that could close a ticket; only the human's own calls do. */
export type TicketEndEvent = 'dispatch-ready' | 'dispatch-failed' | 'rework' | 'acceptance-passed' | 'suggest-end-confirmed'

/**
 * Whether a ticket may end on this event: the human's acceptance over a
 * passed review, or their confirmation of a suggested close — the Steward's
 * verdict paths and the dispatch outcomes never end a ticket.
 */
export function canEndTicket(reviews: readonly ReviewRecord[], ticketId: string, event: TicketEndEvent): boolean {
  if (event === 'suggest-end-confirmed') return true
  if (event !== 'acceptance-passed') return false
  return reviews.some(record => record.ticketId === ticketId && record.verdict === 'pass')
}
