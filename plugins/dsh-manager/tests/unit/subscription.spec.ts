/** Subscription core spec: ticket fan-in derivation over its Thread. */
import { describe, expect, test } from 'vitest'
import { fanInViewOf } from '../../src/evals/subscription.ts'

const BATCH = ['trg-1', 'trg-2']

const threadTriggers = [
  { id: 'trg-3', externalKey: 'group/alpha!12', url: 'https://gl.example.com/mr/12#note_3', collectedAt: 300 },
  { id: 'trg-2', externalKey: 'group/alpha!12', url: 'https://gl.example.com/mr/12', occurredAt: 200, collectedAt: 200 },
  { id: 'trg-1', externalKey: 'group/alpha!12', url: 'https://gl.example.com/mr/12', occurredAt: 100, collectedAt: 100 },
]

describe('fanInViewOf', () => {
  test('a live ticket receives the triggers its accepting batch did not cover', () => {
    const fanIn = fanInViewOf({ threadId: 'thr-1', state: 'running' }, BATCH, threadTriggers)
    expect(fanIn.map(item => item.id)).toEqual(['trg-3'])
    expect(fanIn[0]).toMatchObject({
      externalKey: 'group/alpha!12',
      url: 'https://gl.example.com/mr/12#note_3',
      collectedAt: 300,
    })
  })

  test('an ended ticket receives nothing', () => {
    expect(fanInViewOf({ threadId: 'thr-1', state: 'ended' }, BATCH, threadTriggers)).toEqual([])
  })

  test('a ticket without a thread receives nothing', () => {
    expect(fanInViewOf({ threadId: '', state: 'todo' }, [], threadTriggers)).toEqual([])
  })

  test('every uncovered trigger fans in, newest first, capped', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `trg-x-${index}`,
      externalKey: 'group/alpha!12',
      url: 'https://gl.example.com/mr/12',
      collectedAt: index,
    }))
    const fanIn = fanInViewOf({ threadId: 'thr-1', state: 'todo' }, [], many, 5)
    expect(fanIn).toHaveLength(5)
    expect(fanIn.map(item => item.id)).toEqual(['trg-x-0', 'trg-x-1', 'trg-x-2', 'trg-x-3', 'trg-x-4'])
  })
})
