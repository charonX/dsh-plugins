import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrefsStore } from '../src/prefs.ts'
import type { TranslatePrefs } from '../src/shared/api.ts'

const defaults: TranslatePrefs = { targetLanguage: 'zh-CN', followDefaultModel: true, submitKey: 'enter' }
const logger = { warn: (): void => {} }
const temporary: string[] = []

/** A store over a fresh state file that does not exist yet. */
function store(path = join(mkdtempSync(join(tmpdir(), 'dsh-tr-prefs-')), 'prefs.json')): PrefsStore {
  temporary.push(join(path, '..'))
  return new PrefsStore(path, logger, defaults)
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PrefsStore', () => {
  it('fills every field from the defaults', () => {
    expect(store().read()).toEqual(defaults)
  })

  it('keeps a recognised submit key', () => {
    expect(store().update({ submitKey: 'mod-enter' }).submitKey).toBe('mod-enter')
  })

  it('falls back to the default for an unrecognised submit key', () => {
    // A patch reaches a running store from the HTTP body, so it can carry any string.
    expect(store().update({ submitKey: 'shift-enter' as never }).submitKey).toBe('enter')
  })

  it('reads back what it wrote', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-tr-prefs-')), 'prefs.json')
    temporary.push(join(path, '..'))
    store(path).update({ targetLanguage: 'ja', submitKey: 'mod-enter' })
    expect(new PrefsStore(path, logger, defaults).read()).toEqual({
      targetLanguage: 'ja',
      followDefaultModel: true,
      submitKey: 'mod-enter',
    })
  })
})
