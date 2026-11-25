import { describe, expect, test } from 'vitest'
import type { TicketRecord } from '../../src/board-domain.ts'
import { buildPortfolioSnapshot, formatPortfolioPromptLines } from '../../src/steward/portfolio-context.ts'

function ticket(overrides: Partial<TicketRecord> & Pick<TicketRecord, 'id' | 'title' | 'state'>): TicketRecord {
  return {
    threadId: 'thr-1',
    mandate: { strength: 'explicit', scope: 'board feature', policyVersion: '1' },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('portfolio-context', () => {
  test('filters by projectId, excludes listed tickets, and caps old ended tickets', () => {
    const now = 10_000_000_000
    const oldEndedAt = now - 10 * 24 * 60 * 60 * 1000
    const recentEndedAt = now - 2 * 60 * 60 * 1000

    const snapshot = buildPortfolioSnapshot([
      ticket({ id: 't-cur', title: 'Current work', state: 'todo', projectId: 'p1', updatedAt: now }),
      ticket({ id: 't-active', title: 'Refactor SettingsPage', state: 'running', projectId: 'p1', dependsOn: ['t-ended'], updatedAt: now - 100 }),
      ticket({ id: 't-other', title: 'Other repo task', state: 'running', projectId: 'p2', updatedAt: now }),
      ticket({ id: 't-ended', title: 'Clean up legacy tabs', state: 'ended', projectId: 'p1', updatedAt: recentEndedAt }),
      ticket({ id: 't-stale', title: 'Old migration', state: 'ended', projectId: 'p1', updatedAt: oldEndedAt }),
    ], {
      projectId: 'p1',
      excludeTicketIds: ['t-cur'],
      now,
    })

    expect(snapshot.active.map(entry => entry.id)).toEqual(['t-active'])
    expect(snapshot.recentEnded.map(entry => entry.id)).toEqual(['t-ended'])

    const lines = formatPortfolioPromptLines(snapshot).join('\n')
    expect(lines).toContain('Portfolio tickets (project p1):')
    expect(lines).toContain('[t-active] | state=running | project=p1 | title="Refactor SettingsPage"')
    expect(lines).toContain('dependsOn=[t-ended]')
    expect(lines).toContain('[t-ended] | state=ended | project=p1 | title="Clean up legacy tabs"')
    expect(lines).not.toContain('t-other')
    expect(lines).not.toContain('t-cur')
    expect(lines).not.toContain('t-stale')
  })

  test('renders clean empty marker when no relevant tickets exist', () => {
    const snapshot = buildPortfolioSnapshot([], { projectId: 'p1' })
    expect(formatPortfolioPromptLines(snapshot)).toEqual(['Portfolio tickets (project p1): none'])
  })
})
