import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { batchKey, itemKey, ItemArchive, isValidTranslation, type BatchIdentity } from '../src/records.ts'

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

describe('itemKey', () => {
  it('is stable for identical targetLanguage and text', () => {
    expect(itemKey('zh-CN', 'hello world')).toBe(itemKey('zh-CN', 'hello world'))
  })

  it('normalizes whitespace', () => {
    expect(itemKey('zh-CN', '  hello   world  \n')).toBe(itemKey('zh-CN', 'hello world'))
  })

  it('differentiates language and text', () => {
    expect(itemKey('zh-CN', 'hello')).not.toBe(itemKey('ja', 'hello'))
    expect(itemKey('zh-CN', 'hello')).not.toBe(itemKey('zh-CN', 'world'))
  })
})

describe('ItemArchive', () => {
  it('stores and retrieves translations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
    const file = join(dir, 'items.json')
    try {
      const logger = { warn: () => {} }
      const archive = new ItemArchive(file, logger)
      expect(archive.size()).toBe(0)

      archive.setMany('zh-CN', [
        { text: 'hello', translation: '你好' },
        { text: 'world', translation: '世界' },
      ])
      expect(archive.size()).toBe(2)
      expect(archive.get('zh-CN', 'hello')).toBe('你好')
      expect(archive.get('zh-CN', 'world')).toBe('世界')
      expect(archive.get('zh-CN', 'unknown')).toBeUndefined()

      // Reloading from disk preserves entries
      const reloaded = new ItemArchive(file, logger)
      expect(reloaded.size()).toBe(2)
      expect(reloaded.get('zh-CN', 'hello')).toBe('你好')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('can seed from batch files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-seed-'))
    const file = join(dir, 'items.json')
    const batchesDir = join(dir, 'batches')
    try {
      const logger = { warn: () => {} }
      const archive = new ItemArchive(file, logger)

      // Write a fake batch file
      const { mkdirSync } = require('node:fs')
      mkdirSync(batchesDir, { recursive: true })
      writeFileSync(join(batchesDir, 'batch1.json'), JSON.stringify({
        targetLanguage: 'zh-CN',
        items: [{ id: 'b1', text: 'computer' }],
        results: [{ id: 'b1', text: '计算机' }],
      }))

      const count = archive.seedFromBatches(batchesDir)
      expect(count).toBe(1)
      expect(archive.get('zh-CN', 'computer')).toBe('计算机')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to store or seed identical echoes and non-Chinese text for zh-CN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-refuse-'))
    const file = join(dir, 'items.json')
    try {
      const logger = { warn: () => {} }
      const archive = new ItemArchive(file, logger)

      archive.setMany('zh-CN', [
        { text: 'arena', translation: 'arena' },
        { text: 'Spawn N parallel candidates', translation: 'Spawn N parallel candidates' },
        { text: 'hello', translation: 'hi' },
      ])
      expect(archive.size()).toBe(0)
      expect(archive.get('zh-CN', 'arena')).toBeUndefined()
      expect(archive.get('zh-CN', 'Spawn N parallel candidates')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports listing, searching, deleting, and clearing entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-manage-'))
    const file = join(dir, 'items.json')
    try {
      const logger = { warn: () => {} }
      const archive = new ItemArchive(file, logger)

      archive.setMany('zh-CN', [
        { text: 'Hello', translation: '你好' },
        { text: 'World', translation: '世界' },
        { text: 'Computer', translation: '计算机' },
      ])
      archive.setMany('ja', [
        { text: 'Hello', translation: 'こんにちは' },
      ])

      expect(archive.size()).toBe(4)
      const stats = archive.stats()
      expect(stats.totalCount).toBe(4)
      expect(stats.byLanguage['zh-CN']).toBe(3)
      expect(stats.byLanguage['ja']).toBe(1)

      // Search by keyword
      const searchResult = archive.list({ search: 'comp' })
      expect(searchResult.total).toBe(1)
      expect(searchResult.items[0]!.translation).toBe('计算机')

      // Filter by language
      const jaResult = archive.list({ targetLanguage: 'ja' })
      expect(jaResult.total).toBe(1)
      expect(jaResult.items[0]!.translation).toBe('こんにちは')

      // Delete single item
      const keyToDelete = jaResult.items[0]!.key
      expect(archive.delete(keyToDelete)).toBe(true)
      expect(archive.size()).toBe(3)

      // Clear language
      expect(archive.clear('zh-CN')).toBe(3)
      expect(archive.size()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isValidTranslation', () => {
  it('rejects empty strings or identical text', () => {
    expect(isValidTranslation('zh-CN', '', '')).toBe(false)
    expect(isValidTranslation('zh-CN', 'hello', 'hello')).toBe(false)
    expect(isValidTranslation('zh-CN', '  hello  ', 'hello\n')).toBe(false)
  })

  it('rejects non-Chinese translations when target is Chinese', () => {
    expect(isValidTranslation('zh-CN', 'Spawn N parallel candidates', 'Spawn N parallel candidates')).toBe(false)
    expect(isValidTranslation('zh-CN', 'hello', 'world')).toBe(false)
  })

  it('accepts genuine Chinese translations', () => {
    expect(isValidTranslation('zh-CN', 'hello', '你好')).toBe(true)
    expect(isValidTranslation('zh-CN', 'Spawn N candidates', '生成N个候选方案')).toBe(true)
  })

  it('accepts non-Chinese targets when valid', () => {
    expect(isValidTranslation('fr', 'hello', 'bonjour')).toBe(true)
  })
})
