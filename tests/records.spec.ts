import { describe, expect, it } from 'vitest'
import { batchKey, type BatchIdentity } from '../src/records.ts'

const identity: BatchIdentity = {
  recipe: 'immersive-translate/batch-v2',
  targetLanguage: 'zh-CN',
  provider: 'siliconflow',
  model: 'Qwen/Qwen3-8B',
  items: [{ id: 'a', text: 'computer' }],
}

describe('batchKey', () => {
  it('is stable for the same identity', () => {
    expect(batchKey(identity)).toBe(batchKey({ ...identity, items: [{ id: 'a', text: 'computer' }] }))
  })

  it('separates the recipe, so a prompt change cannot reuse an old answer', () => {
    expect(batchKey({ ...identity, recipe: 'immersive-translate/batch-v1' })).not.toBe(batchKey(identity))
  })

  it('separates language, route, and text', () => {
    const base = batchKey(identity)
    expect(batchKey({ ...identity, targetLanguage: 'ja' })).not.toBe(base)
    expect(batchKey({ ...identity, provider: 'other' })).not.toBe(base)
    expect(batchKey({ ...identity, model: 'other' })).not.toBe(base)
    expect(batchKey({ ...identity, items: [{ id: 'a', text: 'keyboard' }] })).not.toBe(base)
  })

  it('keeps item order significant', () => {
    const ordered = batchKey({ ...identity, items: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }] })
    const reversed = batchKey({ ...identity, items: [{ id: 'b', text: '2' }, { id: 'a', text: '1' }] })
    expect(ordered).not.toBe(reversed)
  })
})
