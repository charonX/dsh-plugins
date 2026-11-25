/** Board column projection unit tests (domain core, in-memory). */
import { describe, expect, test } from 'vitest'
import { boardSummaryOf, ticketRecord, type TicketRecord } from '../../src/board-domain.ts'

function ticket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return ticketRecord.parse({ id: 't-1', title: 'A ticket', createdAt: 0, ...overrides })
}

describe('boardSummaryOf', () => {
  test('returns the fixed column order', () => {
    const summary = boardSummaryOf([])
    expect(summary.columns.map(column => column.id)).toEqual(['inbox', 'pool', 'todo', 'running', 'attention', 'ended'])
  })

  test('reads zero for a board without tickets', () => {
    const summary = boardSummaryOf([])
    expect(summary.columns.every(column => column.count === 0)).toBe(true)
  })

  test('derives the columns from ticket state, never stored separately', () => {
    const summary = boardSummaryOf([
      ticket({ id: 'a', state: 'todo' }),
      ticket({ id: 'b', state: 'running' }),
      ticket({ id: 'c', state: 'running' }),
      ticket({ id: 'd', state: 'attention' }),
      ticket({ id: 'e', state: 'ended' }),
    ], 3, 2)
    expect(summary.columns).toEqual([
      { id: 'inbox', count: 3 },
      { id: 'pool', count: 2 },
      { id: 'todo', count: 1 },
      { id: 'running', count: 2 },
      { id: 'attention', count: 1 },
      { id: 'ended', count: 1 },
    ])
  })

  test('accepts stored ticket records without changing column shape', () => {
    const summary = boardSummaryOf([ticket()])
    expect(summary.columns).toHaveLength(6)
  })

  test('rejects a ticket record without a title', () => {
    expect(() => ticketRecord.parse({ id: 't-2', createdAt: 0 })).toThrow()
  })
})
