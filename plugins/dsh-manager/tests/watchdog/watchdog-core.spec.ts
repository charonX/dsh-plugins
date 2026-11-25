/** Watchdog core: stall detection, consecutive-failure counting, finding keys, dedupe. */
import { describe, expect, test } from 'vitest'
import { dispatchRecord, type DispatchRecord } from '../../src/dispatch/dispatch-core.ts'
import {
  consecutiveFailures,
  hasPendingFinding,
  stalledDispatches,
  watchdogFindings,
  type WatchdogFinding,
} from '../../src/watchdog/watchdog-core.ts'

/** One dispatch record built from its meaningful fields. */
function dispatchOf(overrides: Partial<DispatchRecord> & Pick<DispatchRecord, 'id' | 'ticketId' | 'state'>): DispatchRecord {
  return dispatchRecord.parse({
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  })
}

describe('stalledDispatches', () => {
  test('a live dispatch silent past the timeout stalls; fresh and ended ones do not', () => {
    const now = 100_000
    const dispatches = [
      // Running and silent well past the 60s timeout.
      dispatchOf({ id: 'd-silent', ticketId: 't-1', state: 'running', createdAt: 10_000, updatedAt: 20_000 }),
      // Running but recently progressed.
      dispatchOf({ id: 'd-fresh', ticketId: 't-2', state: 'running', createdAt: 90_000, updatedAt: 95_000 }),
      // Ended dispatches never stall.
      dispatchOf({ id: 'd-ended', ticketId: 't-3', state: 'ended', createdAt: 10_000, updatedAt: 20_000 }),
      // Queued dispatch waiting past the timeout stalls too.
      dispatchOf({ id: 'd-queued', ticketId: 't-4', state: 'queued', createdAt: 10_000, updatedAt: 20_000 }),
    ]
    const stalled = stalledDispatches(dispatches, now, 60_000)
    expect(stalled.map(entry => entry.id).sort()).toEqual(['d-queued', 'd-silent'])
  })

  test('the timeout boundary is exclusive: exactly at the limit is not yet stalled', () => {
    const now = 100_000
    const dispatches = [dispatchOf({ id: 'd-edge', ticketId: 't-1', state: 'running', createdAt: 40_000, updatedAt: 40_000 })]
    expect(stalledDispatches(dispatches, now, 60_000)).toHaveLength(0)
    expect(stalledDispatches(dispatches, now + 1, 60_000)).toHaveLength(1)
  })
})

describe('consecutiveFailures', () => {
  /** One ended dispatch for t-1 with an explicit createdAt (larger = newer). */
  const mk = (id: string, outcome: DispatchRecord['outcome'], createdAt: number) =>
    dispatchOf({ id, ticketId: 't-1', state: 'ended', outcome, createdAt, updatedAt: createdAt + 500 })

  test('counts trailing failed dispatches newest first and stops at any other outcome', () => {
    // Storage order is irrelevant: the read walks createdAt, newest first.
    const storage = [mk('d-3', 'failed', 3000), mk('d-2', 'failed', 2000), mk('d-1', 'ready', 1000)]
    expect(consecutiveFailures(storage, 't-1')).toBe(2)
    expect(consecutiveFailures([...storage].reverse(), 't-1')).toBe(2)
  })

  test('a live dispatch resets the count to zero: work is in progress again', () => {
    const live = dispatchOf({ id: 'd-run', ticketId: 't-1', state: 'running', createdAt: 3000, updatedAt: 3500 })
    expect(consecutiveFailures([live, mk('d-2', 'failed', 2000), mk('d-1', 'failed', 1000)], 't-1')).toBe(0)
  })

  test('a clean ending breaks the run at its length', () => {
    expect(consecutiveFailures([mk('d-2', 'failed', 2000), mk('d-1', 'not-needed', 1000)], 't-1')).toBe(1)
  })

  test('only the ticket\'s own dispatches count', () => {
    const other = dispatchOf({ id: 'd-2', ticketId: 't-other', state: 'ended', outcome: 'failed', createdAt: 2000, updatedAt: 2500 })
    expect(consecutiveFailures([mk('d-1', 'failed', 1000), other], 't-1')).toBe(1)
    expect(consecutiveFailures([mk('d-1', 'failed', 1000)], 't-empty')).toBe(0)
  })
})

describe('watchdogFindings', () => {
  test('stalls and failure runs above threshold become findings with stable keys', () => {
    const now = 100_000
    const dispatches = [
      dispatchOf({ id: 'd-silent', ticketId: 't-1', state: 'running', createdAt: 10_000, updatedAt: 20_000 }),
      dispatchOf({ id: 'd-f1', ticketId: 't-2', state: 'ended', outcome: 'failed', createdAt: 50_000, updatedAt: 51_000 }),
      dispatchOf({ id: 'd-f2', ticketId: 't-2', state: 'ended', outcome: 'failed', createdAt: 60_000, updatedAt: 61_000 }),
    ]
    const findings = watchdogFindings({ dispatches, now, progressTimeoutMs: 60_000, failureThreshold: 2 })
    expect(findings.map(finding => finding.key).sort()).toEqual(['watchdog:failures:t-2', 'watchdog:stall:d-silent'])
    const stall = findings.find(finding => finding.key === 'watchdog:stall:d-silent')!
    expect(stall.ticketId).toBe('t-1')
    expect(stall.question).toContain('d-silent')
    expect(stall.question).toContain('no progress')
    const failures = findings.find(finding => finding.key === 'watchdog:failures:t-2')!
    expect(failures.ticketId).toBe('t-2')
    expect(failures.question).toContain('2 consecutive failed dispatches')
  })

  test('a failure run below threshold stays silent', () => {
    const dispatches = [
      dispatchOf({ id: 'd-f1', ticketId: 't-1', state: 'ended', outcome: 'failed', createdAt: 50_000, updatedAt: 51_000 }),
    ]
    const findings = watchdogFindings({ dispatches, now: 100_000, progressTimeoutMs: 60_000, failureThreshold: 2 })
    expect(findings).toEqual([])
  })
})

describe('hasPendingFinding', () => {
  const finding: WatchdogFinding = {
    key: 'watchdog:stall:d-1',
    ticketId: 't-1',
    question: 'no progress',
    details: 'watchdog:stall:d-1',
  }

  test('a pending attention carrying the key dedupes; answered ones do not', () => {
    const pending = { id: 'att-1', ticketId: 't-1', dispatchId: 'watchdog', kind: 'question' as const, question: 'no progress', details: 'watchdog:stall:d-1', status: 'pending' as const, createdAt: 1, updatedAt: 1 }
    expect(hasPendingFinding([pending], finding)).toBe(true)
    expect(hasPendingFinding([{ ...pending, status: 'answered' }], finding)).toBe(false)
    expect(hasPendingFinding([{ ...pending, details: 'watchdog:stall:d-other' }], finding)).toBe(false)
    expect(hasPendingFinding([], finding)).toBe(false)
  })
})
