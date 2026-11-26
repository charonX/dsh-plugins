/** Domain-core spec for the ticket timeline ledger over an in-memory port. */
import { describe, expect, test } from 'vitest'
import type { AttentionRecord } from '../../src/attention/attention-core.ts'
import type { DispatchRecord, ReportRecord } from '../../src/dispatch/dispatch-core.ts'
import {
  appendTimelineEvent,
  backfillTimeline,
  eventOfReport,
  recordAttentionTimeline,
  recordDispatchTimeline,
  summarizeActivity,
  timelineEventsOf,
  type TicketTimelineRecord,
  type TimelineEvent,
  type TimelineStorePort,
} from '../../src/timeline/timeline-core.ts'

/** One in-memory timeline store whose update runs synchronously, like the domain write chain. */
function memoryStore(): TimelineStorePort & { ledgers(): readonly TicketTimelineRecord[] } {
  const byTicket = new Map<string, TicketTimelineRecord>()
  return {
    getTimeline: ticketId => byTicket.get(ticketId),
    async putTimeline(record) { byTicket.set(record.ticketId, record) },
    async updateTimeline(ticketId, update) {
      const current = byTicket.get(ticketId)
      if (current === undefined) return undefined
      const next = update(current)
      byTicket.set(ticketId, next)
      return next
    },
    listTimelines: () => [...byTicket.values()],
    ledgers: () => [...byTicket.values()],
  }
}

/** One report fixture. */
function report(id: string, kind: ReportRecord['kind'], message: string, at: number, activity?: ReportRecord['activity']): ReportRecord {
  return { id, kind, message, at, ...(activity === undefined ? {} : { activity }) }
}

/** One dispatch fixture. */
function dispatchOf(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: 'dispatch-1',
    ticketId: 'ticket-1',
    state: 'queued',
    reports: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

describe('timeline ledger', () => {
  test('the first append creates the ledger at seq 0 and later appends stay dense', async () => {
    const store = memoryStore()
    await appendTimelineEvent(store, { ticketId: 'ticket-1', id: 'evt-a', kind: 'instruction', author: 'user', at: 10, body: '继续' })
    await appendTimelineEvent(store, { ticketId: 'ticket-1', kind: 'assistant', author: 'executor', at: 20, body: '收到' })
    await appendTimelineEvent(store, { ticketId: 'ticket-1', kind: 'system', author: 'system', at: 30, code: 'finished' })

    const events = timelineEventsOf(store, 'ticket-1')
    expect(events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(events.map(event => event.kind)).toEqual(['instruction', 'assistant', 'system'])
    expect(events[0]).toMatchObject({ id: 'evt-a', body: '继续', author: 'user' })
    expect(events[2]?.code).toBe('finished')
    expect(store.getTimeline('ticket-1')?.updatedAt).toBe(30)
  })

  test('re-appending the same id is a no-op', async () => {
    const store = memoryStore()
    const first = await appendTimelineEvent(store, { ticketId: 'ticket-1', id: 'evt-a', kind: 'instruction', author: 'user', at: 10, body: 'x' })
    const second = await appendTimelineEvent(store, { ticketId: 'ticket-1', id: 'evt-a', kind: 'instruction', author: 'user', at: 11, body: 'changed' })
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.body).toBe('x')
    expect(second.updatedAt).toBe(first.updatedAt)
  })

  test('concurrent first appends both land on a fresh ticket', async () => {
  const store = memoryStore()
  await Promise.all([
    appendTimelineEvent(store, { ticketId: 'ticket-1', kind: 'instruction', author: 'user', at: 1, body: '甲' }),
    appendTimelineEvent(store, { ticketId: 'ticket-1', kind: 'assistant', author: 'executor', at: 2, body: '乙' }),
  ])
  const events = timelineEventsOf(store, 'ticket-1')
  expect(events.map(event => event.body)).toEqual(['甲', '乙'])
  expect(events.map(event => event.seq)).toEqual([0, 1])
})

test('an unknown ticket reads as empty', () => {
    expect(timelineEventsOf(memoryStore(), 'missing')).toEqual([])
  })

  test('reports map to assistant, tool, and report events by activity', () => {
    expect(eventOfReport(report('r1', 'progress', 'hi', 1, { category: 'message' }))).toEqual({ kind: 'assistant', author: 'executor', code: 'report-progress' })
    expect(eventOfReport(report('r2', 'progress', 'Read x', 1, { category: 'tool', toolName: 'Read' }))).toEqual({ kind: 'tool', author: 'executor', code: 'report-progress' })
    expect(eventOfReport(report('r3', 'ready', 'done', 1))).toEqual({ kind: 'report', author: 'executor', code: 'report-ready' })
  })
})

describe('dispatch mirroring', () => {
  test('start, reports, and end land in order under one turn', async () => {
    const store = memoryStore()
    const queued = dispatchOf()
    const running = { ...queued, state: 'running' as const, sessionId: 'dsh-manager-exec-1', updatedAt: 110 }
    await recordDispatchTimeline(store, queued, running)
    const reported: DispatchRecord = {
      ...running,
      reports: [
        report('r1', 'progress', '开始看代码', 120, { category: 'message' }),
        report('r2', 'progress', 'Read src/index.ts', 130, { category: 'tool', toolName: 'Read' }),
        report('r3', 'ready', '改完了，测试通过', 200),
      ],
      state: 'ended',
      outcome: 'ready',
      updatedAt: 200,
    }
    await recordDispatchTimeline(store, running, reported)

    const events = timelineEventsOf(store, 'ticket-1')
    expect(events.map(event => [event.code, event.kind])).toEqual([
      ['turn-started', 'system'],
      ['report-progress', 'assistant'],
      ['report-progress', 'tool'],
      ['report-ready', 'report'],
      ['turn-ended:ready', 'system'],
    ])
    expect(events[3]?.body).toBe('改完了，测试通过')
    expect(events.every(event => event.turnId === 'dispatch-1')).toBe(true)
    expect(events[2]?.activity).toEqual({ category: 'tool', toolName: 'Read' })
  })

  test('replaying the same transition does not duplicate events', async () => {
    const store = memoryStore()
    const queued = dispatchOf()
    const running = { ...queued, state: 'running' as const, updatedAt: 110 }
    await recordDispatchTimeline(store, queued, running)
    await recordDispatchTimeline(store, queued, running)
    await recordDispatchTimeline(store, undefined, running)
    expect(timelineEventsOf(store, 'ticket-1')).toHaveLength(1)
  })

  test('a cancelled turn records its reason and its interrupted end', async () => {
    const store = memoryStore()
    const running = dispatchOf({ state: 'running', updatedAt: 110 })
    const ended: DispatchRecord = {
      ...running,
      state: 'ended',
      outcome: 'interrupted',
      reports: [report('r9', 'progress', 'cancelled by user', 150, { category: 'error', target: 'cancelled' })],
      updatedAt: 150,
    }
    await recordDispatchTimeline(store, running, ended)
    const events = timelineEventsOf(store, 'ticket-1')
    expect(events.map(event => event.code)).toEqual(['report-progress', 'turn-ended:interrupted'])
    expect(events[0]?.kind).toBe('report')
    expect(events[0]?.body).toBe('cancelled by user')
  })
})

describe('attention mirroring', () => {
  test('an ask and its answer become attention + instruction events', async () => {
    const store = memoryStore()
    const asked: AttentionRecord = {
      id: 'att-1',
      ticketId: 'ticket-1',
      dispatchId: 'dispatch-1',
      kind: 'question',
      question: '要不要改 approval policy？',
      status: 'pending',
      createdAt: 120,
      updatedAt: 120,
    }
    await recordAttentionTimeline(store, undefined, asked)
    await recordAttentionTimeline(store, asked, { ...asked, status: 'answered', answer: '按工单配置', updatedAt: 160 })

    const events = timelineEventsOf(store, 'ticket-1')
    expect(events.map(event => [event.kind, event.author, event.code])).toEqual([
      ['attention', 'executor', 'attention-question'],
      ['instruction', 'user', 'answered'],
    ])
    expect(events[1]?.body).toBe('按工单配置')
    expect(events[1]?.attentionId).toBe('att-1')
    expect(events[1]?.turnId).toBe('dispatch-1')
  })

  test('re-mirroring an answered attention does not duplicate', async () => {
    const store = memoryStore()
    const asked: AttentionRecord = {
      id: 'att-1', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'question', question: 'q', status: 'pending', createdAt: 1, updatedAt: 1,
    }
    const answered: AttentionRecord = { ...asked, status: 'answered', answer: 'a', updatedAt: 2 }
    await recordAttentionTimeline(store, undefined, asked)
    await recordAttentionTimeline(store, asked, answered)
    await recordAttentionTimeline(store, asked, answered)
    expect(timelineEventsOf(store, 'ticket-1')).toHaveLength(2)
  })
})

describe('backfill of pre-ledger tickets', () => {
  test('folds dispatches and attentions chronologically with stable ids', () => {
    const dispatches: DispatchRecord[] = [
      dispatchOf({
        state: 'ended',
        outcome: 'ready',
        updatedAt: 300,
        reports: [
          report('r1', 'progress', '开始', 140, { category: 'message' }),
          report('r2', 'ready', '完成', 300),
        ],
      }),
    ]
    const attentions: AttentionRecord[] = [{
      id: 'att-1', ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'question', question: '问一句', status: 'answered', answer: '答', createdAt: 150, updatedAt: 200,
    }]

    const first = backfillTimeline('ticket-1', dispatches, attentions, 999)
    expect(first.events.map(event => event.at)).toEqual([100, 140, 150, 200, 300, 300])
    expect(first.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(first.events.map(event => event.code)).toEqual(['turn-started', 'report-progress', 'attention-question', 'answered', 'report-ready', 'turn-ended:ready'])
    expect(first.events.every(event => event.backfilled === true)).toBe(true)

    const second = backfillTimeline('ticket-1', dispatches, attentions, 1000)
    expect(second.events.map(event => event.id)).toEqual(first.events.map(event => event.id))
    expect(second.events.map(event => event.seq)).toEqual(first.events.map(event => event.seq))
  })

  test('a ticket with no history folds to an empty ledger', () => {
    expect(backfillTimeline('ticket-x', [], [], 1).events).toEqual([])
  })

  test('activity summary prefers a human-facing event over tool traffic', () => {
    const events: TimelineEvent[] = [
      { id: 'e1', seq: 0, kind: 'assistant', author: 'executor', body: '改完了', at: 100 },
      { id: 'e2', seq: 1, kind: 'tool', author: 'executor', body: 'Read src/index.ts', at: 200 },
    ]
    expect(summarizeActivity(events)).toEqual({ at: 100, kind: 'assistant', author: 'executor', text: '改完了' })
  })

  test('activity summary falls back to the newest event and truncates long text', () => {
    const long = '很'.repeat(120)
    const events: TimelineEvent[] = [
      { id: 'e2', seq: 1, kind: 'tool', author: 'executor', body: long, at: 200 },
    ]
    const summary = summarizeActivity(events)
    expect(summary?.kind).toBe('tool')
    expect(summary?.text?.endsWith('…')).toBe(true)
    expect(summary!.text!.length).toBe(72)
    expect(summarizeActivity([])).toBeUndefined()
  })
})
