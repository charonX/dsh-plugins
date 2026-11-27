/** Unit tests for the pure ticket-revision decision layer. */
import { describe, expect, test } from 'vitest'
import type { TicketRecord } from '../../src/board-domain.ts'
import { applyTicketRevision } from '../../src/ticket-revision.ts'

const todoTicket: TicketRecord = {
  id: 'ticket-1',
  title: 'Old title',
  threadId: 'thread-1',
  state: 'todo',
  mandate: { strength: 'explicit', scope: 'old scope', policyVersion: '1' },
  acceptanceCriteria: '1. run tests',
  scratchDir: 'home-repos/scratch/tasks/old',
  worktree: { mode: 'worktree', repoRoot: '/workspace', baseBranch: 'main', branch: 'dsh-manager/ticket-1' },
  createdAt: 1,
  updatedAt: 1,
}

describe('ticket-revision', () => {
  test('rewrites planning fields and reports what changed', () => {
    const result = applyTicketRevision(todoTicket, {
      title: 'New title',
      mandateScope: 'new scope',
      acceptanceCriteria: '1. pnpm test\n2. real run logged to scratch/test-report.log',
      scratchDir: '/abs/scratch/tasks/new',
      worktree: { repoRoot: '/workspace/repos/dsh', baseBranch: 'main', mergeTarget: 'test' },
    }, 42)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toEqual(['title', 'mandate.scope', 'acceptanceCriteria', 'scratchDir', 'worktree'])
    expect(result.record.title).toBe('New title')
    expect(result.record.mandate).toEqual({ strength: 'explicit', scope: 'new scope', policyVersion: '1' })
    expect(result.record.worktree).toMatchObject({
      mode: 'worktree',
      repoRoot: '/workspace/repos/dsh',
      baseBranch: 'main',
      branch: 'dsh-manager/ticket-1',
      mergeTarget: 'test',
    })
    expect(result.record.updatedAt).toBe(42)
  })

  test('refuses tickets that are no longer waiting for dispatch', () => {
    for (const state of ['running', 'attention', 'ended'] as const) {
      const result = applyTicketRevision({ ...todoTicket, state }, { title: 'x' }, 42)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('only todo tickets can be revised')
    }
  })

  test('refuses a patch that changes nothing and an empty acceptance gate clears the field', () => {
    expect(applyTicketRevision(todoTicket, { title: 'Old title' }, 42).ok).toBe(false)
    expect(applyTicketRevision(todoTicket, {}, 42).ok).toBe(false)

    const cleared = applyTicketRevision(todoTicket, { acceptanceCriteria: '   ' }, 42)
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.record.acceptanceCriteria).toBeUndefined()
  })

  test('keeps the original record untouched', () => {
    applyTicketRevision(todoTicket, { title: 'Changed' }, 42)
    expect(todoTicket.title).toBe('Old title')
    expect(todoTicket.updatedAt).toBe(1)
  })
})
