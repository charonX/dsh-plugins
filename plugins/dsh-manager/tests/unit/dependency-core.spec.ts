import { describe, expect, test } from 'vitest'
import type { TicketRecord } from '../../src/board-domain.ts'
import { unresolvedDependencies, validateDependencies } from '../../src/board/dependency-core.ts'

function ticket(id: string, overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id,
    title: `Title ${id}`,
    threadId: '',
    state: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('dependency-core', () => {
  test('validates acyclic dependencies and deduplicates', () => {
    const tickets = [ticket('t1'), ticket('t2'), ticket('t3')]
    expect(validateDependencies(tickets, 't3', ['t1', 't2', 't1'])).toEqual(['t1', 't2'])
  })

  test('rejects self-dependency, unknown ticket, and indirect cycles', () => {
    const tickets = [
      ticket('t1', { dependsOn: ['t2'] }),
      ticket('t2', { dependsOn: ['t3'] }),
      ticket('t3'),
    ]
    expect(() => validateDependencies(tickets, 't3', ['t3'])).toThrow(/cannot depend on itself/)
    expect(() => validateDependencies(tickets, 't3', ['missing'])).toThrow(/does not exist/)
    expect(() => validateDependencies(tickets, 't3', ['t1'])).toThrow(/cycle detected/)
  })

  test('unresolvedDependencies ignores ended prerequisites and inherits root dependsOn for stages', () => {
    const tickets = [
      ticket('t1', { state: 'ended' }),
      ticket('t2', { state: 'todo' }),
      ticket('root', {
        dependsOn: ['t1', 't2'],
        flow: { pipelineId: 'p', pipelineName: 'P', stageIndex: 0, stageCount: 2 },
      }),
      ticket('stage2', {
        followUpOf: 'root',
        flow: { pipelineId: 'p', pipelineName: 'P', stageIndex: 1, stageCount: 2 },
      }),
    ]
    expect(unresolvedDependencies(tickets, tickets[2]!)).toEqual([
      { id: 't2', title: 'Title t2', state: 'todo' },
    ])
    expect(unresolvedDependencies(tickets, tickets[3]!)).toEqual([
      { id: 't2', title: 'Title t2', state: 'todo' },
    ])
  })

  test('keeps downstream waiting when root stage handed off (ended) while successor flow stages remain active', () => {
    const tickets = [
      ticket('prereq-root', {
        state: 'ended',
        flow: { pipelineId: 'p', pipelineName: 'P', stageIndex: 0, stageCount: 2 },
      }),
      ticket('prereq-stage2', {
        followUpOf: 'prereq-root',
        state: 'running',
        flow: { pipelineId: 'p', pipelineName: 'P', stageIndex: 1, stageCount: 2 },
      }),
      ticket('downstream', { dependsOn: ['prereq-root'] }),
    ]
    expect(unresolvedDependencies(tickets, tickets[2]!)).toEqual([
      { id: 'prereq-root', title: 'Title prereq-root', state: 'running' },
    ])
    const allEnded = [
      tickets[0]!,
      { ...tickets[1]!, state: 'ended' as const },
      tickets[2]!,
    ]
    expect(unresolvedDependencies(allEnded, allEnded[2]!)).toEqual([])
  })
})
