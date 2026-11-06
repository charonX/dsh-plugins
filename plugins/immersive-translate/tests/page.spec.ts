import { describe, expect, it } from 'vitest'
import { blockText, planPage, type PageLimits } from '../src/shared/page.ts'

const limits: PageLimits = { maxItemsPerBatch: 2, maxCharsPerItem: 10 }

describe('blockText', () => {
  it('collapses whitespace into one line', () => {
    expect(blockText('  hello\n\n  world  ')).toBe('hello world')
  })

  it('keeps a block with no text empty, so the planner can drop it', () => {
    expect(blockText('   \n ')).toBe('')
  })
})

describe('planPage', () => {
  it('splits blocks into batches of the configured size, in page order', () => {
    const plan = planPage([
      { key: 'a', text: 'one' },
      { key: 'b', text: 'two' },
      { key: 'c', text: 'three' },
    ], limits)
    expect(plan.batches).toEqual([
      [{ id: 'b0', text: 'one' }, { id: 'b1', text: 'two' }],
      [{ id: 'b2', text: 'three' }],
    ])
  })

  it('sends identical text once and shares the answer', () => {
    const plan = planPage([
      { key: 'a', text: 'Save' },
      { key: 'b', text: 'Cancel' },
      { key: 'c', text: 'Save' },
    ], { maxItemsPerBatch: 20, maxCharsPerItem: 4000 })
    expect(plan.batches.flat()).toEqual([
      { id: 'b0', text: 'Save' },
      { id: 'b1', text: 'Cancel' },
    ])
    expect(plan.requestOf.get('a')).toBe('b0')
    expect(plan.requestOf.get('c')).toBe('b0')
    // One answer paints both blocks that carried the same string.
    expect(plan.blocksByRequest.get('b0')).toEqual(['a', 'c'])
    expect(plan.blocksByRequest.get('b1')).toEqual(['b'])
  })

  it('skips empty and oversized blocks instead of truncating them', () => {
    const plan = planPage([
      { key: 'empty', text: '' },
      { key: 'long', text: 'x'.repeat(11) },
      { key: 'ok', text: 'ok' },
    ], limits)
    expect(plan.skipped).toEqual(['empty', 'long'])
    expect(plan.batches.flat()).toEqual([{ id: 'b0', text: 'ok' }])
    expect(plan.requestOf.has('long')).toBe(false)
  })

  it('plans nothing for a page with nothing to translate', () => {
    expect(planPage([], limits)).toEqual({
      batches: [],
      requestOf: new Map(),
      blocksByRequest: new Map(),
      skipped: [],
    })
  })

  it('treats a nonsensical batch size as one item per batch', () => {
    const plan = planPage([{ key: 'a', text: '1' }, { key: 'b', text: '2' }], { maxItemsPerBatch: 0, maxCharsPerItem: 10 })
    expect(plan.batches).toHaveLength(2)
  })
})
