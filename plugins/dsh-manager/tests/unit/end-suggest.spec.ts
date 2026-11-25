/**
 * The suggest-end domain decisions (spec story 66): which trigger payloads
 * say the external object has ended, and the human's confirmation of a
 * suggested close ends the ticket on its own authority.
 */
import { expect, test } from 'vitest'
import { canEndTicket, type ReviewRecord } from '../../src/review/review-core.ts'
import { externalObjectEnded } from '../../src/triggers/trigger-core.ts'

test('a merged or closed MR payload says the external object has ended', () => {
  expect(externalObjectEnded({ kind: 'mr', state: 'merged' })).toBe(true)
  expect(externalObjectEnded({ kind: 'mr', state: 'closed' })).toBe(true)
  expect(externalObjectEnded({ kind: 'mr', state: 'opened' })).toBe(false)
})

test('a resolved, closed, or done Jira issue says the external object has ended', () => {
  expect(externalObjectEnded({ kind: 'jira', key: 'PROJ-1', status: 'Resolved' })).toBe(true)
  expect(externalObjectEnded({ kind: 'jira', key: 'PROJ-1', status: 'Closed' })).toBe(true)
  expect(externalObjectEnded({ kind: 'jira', key: 'PROJ-1', status: 'Done' })).toBe(true)
  expect(externalObjectEnded({ kind: 'jira', key: 'PROJ-1', resolution: 'Done' })).toBe(true)
  expect(externalObjectEnded({ kind: 'jira', key: 'PROJ-1', status: 'In Progress' })).toBe(false)
})

test('other payloads never say the external object has ended', () => {
  expect(externalObjectEnded({ kind: 'comment', body: 'looks done' })).toBe(false)
  expect(externalObjectEnded({ kind: 'manual', description: 'close it please' })).toBe(false)
  expect(externalObjectEnded({ kind: 'pipeline' })).toBe(false)
  expect(externalObjectEnded('merged')).toBe(false)
  expect(externalObjectEnded(undefined)).toBe(false)
})

test('the human\'s confirmation of a suggested close ends a ticket on its own authority', () => {
  const passed: ReviewRecord[] = [{
    id: 'review-1', ticketId: 'ticket-a', dispatchId: 'dispatch-1', round: 1,
    verdict: 'pass', feedback: '', origin: 'steward', decidedAt: 1,
  }]
  // No Steward review is needed: the user decided themselves.
  expect(canEndTicket([], 'ticket-a', 'suggest-end-confirmed')).toBe(true)
  expect(canEndTicket(passed, 'ticket-a', 'suggest-end-confirmed')).toBe(true)
})
