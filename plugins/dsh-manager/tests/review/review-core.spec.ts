/**
 * Domain-core spec for review, rework, and acceptance (spec stories 58–60,
 * 64/65): the Steward's verdict paths, the automatic rework ceiling, and the
 * rule that only the human's acceptance can end a ticket.
 */
import { expect, test } from 'vitest'
import {
  MAX_AUTO_REWORKS,
  autoReworkCount,
  canEndTicket,
  recordReview,
  reviewPath,
  type ReviewRecord,
  type ReviewStorePort,
} from '../../src/review/review-core.ts'

/** In-memory review storage the core drives directly (ADR-0003). */
function memoryStore(): ReviewStorePort & { readonly records: readonly ReviewRecord[] } {
  const records: ReviewRecord[] = []
  return {
    records,
    getReview(id) { return records.find(record => record.id === id) },
    async putReview(record) { records.push(record) },
    listReviews() { return [...records] },
  }
}

function review(overrides: Partial<ReviewRecord>): ReviewRecord {
  return {
    id: `review-${records.length + 1}`,
    ticketId: 'ticket-a',
    dispatchId: 'dispatch-1',
    round: 1,
    verdict: 'rework',
    feedback: 'the analysis misses the error path',
    origin: 'steward',
    decidedAt: records.length + 1,
    ...overrides,
  }
}
const records: ReviewRecord[] = []

test('two automatic reworks are allowed; the third non-passing verdict goes to a human', () => {
  expect(MAX_AUTO_REWORKS).toBe(2)
  expect(reviewPath('rework', 0)).toBe('auto-rework')
  expect(reviewPath('rework', 1)).toBe('auto-rework')
  expect(reviewPath('rework', 2)).toBe('human')
})

test('a pass always mints an acceptance, at any rework count', () => {
  expect(reviewPath('pass', 0)).toBe('acceptance')
  expect(reviewPath('pass', 2)).toBe('acceptance')
})

test('the automatic rework count covers only Steward reworks; a human return does not consume it', () => {
  const reviews = [
    review({ verdict: 'rework', origin: 'steward' }),
    review({ verdict: 'rework', origin: 'human' }),
    review({ verdict: 'rework', origin: 'steward' }),
  ]
  expect(autoReworkCount(reviews, 'ticket-a')).toBe(2)
  expect(autoReworkCount(reviews, 'ticket-b')).toBe(0)
})

test('a verdict recorded through the store numbers its round and keeps its origin', async () => {
  const store = memoryStore()
  const first = await recordReview(store, { ticketId: 'ticket-a', dispatchId: 'dispatch-1', verdict: 'rework', feedback: 'fix the scope' }, 100)
  expect(first.round).toBe(1)
  expect(first.origin).toBe('steward')
  const second = await recordReview(store, { ticketId: 'ticket-a', dispatchId: 'dispatch-2', verdict: 'rework', feedback: 'the user says otherwise', origin: 'human' }, 200)
  expect(second.round).toBe(2)
  expect(second.origin).toBe('human')
  const third = await recordReview(store, { ticketId: 'ticket-b', dispatchId: 'dispatch-3', verdict: 'pass', feedback: 'meets the mandate' }, 300)
  expect(third.round).toBe(1)
})

test('only a passed acceptance can end a ticket', () => {
  const reworked = [review({ verdict: 'rework' })]
  const passed = [review({ verdict: 'pass' })]
  // No verdict path ends a ticket on its own.
  expect(canEndTicket(reworked, 'ticket-a', 'dispatch-ready')).toBe(false)
  expect(canEndTicket(reworked, 'ticket-a', 'acceptance-passed')).toBe(false)
  expect(canEndTicket(passed, 'ticket-a', 'dispatch-ready')).toBe(false)
  expect(canEndTicket(passed, 'ticket-a', 'rework')).toBe(false)
  // Only the human's acceptance over a passed review does.
  expect(canEndTicket(passed, 'ticket-a', 'acceptance-passed')).toBe(true)
  // A pass on another ticket never ends this one.
  expect(canEndTicket(passed, 'ticket-b', 'acceptance-passed')).toBe(false)
})
