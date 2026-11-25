import { describe, expect, it } from 'vitest'
import {
  blockText,
  isAlreadyInTargetLanguage,
  isTranslatableText,
  planPage,
  type PageLimits,
} from '../src/shared/page.ts'

const limits: PageLimits = { maxItemsPerBatch: 2, maxCharsPerItem: 10 }

describe('blockText', () => {
  it('collapses whitespace into one line', () => {
    expect(blockText('  hello\n\n  world  ')).toBe('hello world')
  })

  it('keeps a block with no text empty, so the planner can drop it', () => {
    expect(blockText('   \n ')).toBe('')
  })
})

describe('isTranslatableText', () => {
  it('identifies linguistic text as translatable', () => {
    expect(isTranslatableText('Hello world')).toBe(true)
    expect(isTranslatableText('你好')).toBe(true)
    expect(isTranslatableText('Settings')).toBe(true)
  })

  it('rejects empty, pure numbers, and punctuation', () => {
    expect(isTranslatableText('')).toBe(false)
    expect(isTranslatableText('   ')).toBe(false)
    expect(isTranslatableText('12345')).toBe(false)
    expect(isTranslatableText('---')).toBe(false)
    expect(isTranslatableText('159******03')).toBe(false)
  })

  it('rejects standalone URLs, versions, commit hashes, package slugs, and dev tool keywords', () => {
    expect(isTranslatableText('https://github.com/deepseek-ai')).toBe(false)
    expect(isTranslatableText('http://localhost:3080')).toBe(false)
    expect(isTranslatableText('v1.2.0')).toBe(false)
    expect(isTranslatableText('0.2.2-alpha.3')).toBe(false)
    expect(isTranslatableText('4ae1636')).toBe(false)
    expect(isTranslatableText('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(false)
    expect(isTranslatableText('backnotprop-pstack')).toBe(false)
    expect(isTranslatableText('skills-manager')).toBe(false)
    expect(isTranslatableText('git')).toBe(false)
    expect(isTranslatableText('npm')).toBe(false)
  })

  it('preserves real English words that happen to contain hex letters', () => {
    expect(isTranslatableText('defaced')).toBe(true)
    expect(isTranslatableText('feedback')).toBe(true)
  })
})

describe('isAlreadyInTargetLanguage', () => {
  it('detects text already primarily in Chinese when target is zh-CN', () => {
    expect(isAlreadyInTargetLanguage('新会话', 'zh-CN')).toBe(true)
    expect(isAlreadyInTargetLanguage('DSH 本地构建', 'zh-CN')).toBe(true)
    expect(isAlreadyInTargetLanguage('技能目录 : skills/architect', 'zh-CN')).toBe(true)
    expect(isAlreadyInTargetLanguage('2 个来源 · 97 个技能', 'zh-CN')).toBe(true)
    expect(isAlreadyInTargetLanguage('版本 4ae1636', 'zh-CN')).toBe(true)
  })

  it('returns false for foreign text when target is zh-CN', () => {
    expect(isAlreadyInTargetLanguage('Translate this page', 'zh-CN')).toBe(false)
    expect(isAlreadyInTargetLanguage('Sketch types, signatures, and module structure.', 'zh-CN')).toBe(false)
    expect(isAlreadyInTargetLanguage('Settings', 'zh-CN')).toBe(false)
  })

  it('handles English target language', () => {
    expect(isAlreadyInTargetLanguage('Hello world', 'en')).toBe(true)
    expect(isAlreadyInTargetLanguage('你好世界', 'en')).toBe(false)
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

  it('skips text already in target language or untranslatable when targetLanguage is set', () => {
    const plan = planPage([
      { key: 'zh1', text: '新会话' },
      { key: 'zh2', text: 'DSH 本地构建' },
      { key: 'en1', text: 'Settings' },
      { key: 'num', text: '159******03' },
      { key: 'en2', text: 'Create workspace' },
    ], { maxItemsPerBatch: 10, maxCharsPerItem: 100, targetLanguage: 'zh-CN' })

    expect(plan.skipped).toEqual(['zh1', 'zh2', 'num'])
    expect(plan.batches.flat()).toEqual([
      { id: 'b0', text: 'Settings' },
      { id: 'b1', text: 'Create workspace' },
    ])
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
