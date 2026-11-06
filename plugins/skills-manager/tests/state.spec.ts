import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  StateStore,
  isSkillEnabled,
  isSkillVisible,
  isSourceEnabled,
  skillStateKey,
} from '../src/state.ts'
import { tempTree } from './helpers.ts'

const silentLogger = { warn: () => {} }

describe('StateStore', () => {
  it('starts empty and reads absent files as defaults', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      const state = store.read()
      expect(state).toEqual({ version: 1, sources: {}, skills: {} })
      expect(isSourceEnabled(state, 'anything')).toBe(true)
      expect(isSkillVisible(state, 'anything', 'skill')).toBe(true)
    } finally {
      tree.cleanup()
    }
  })

  it('persists only non-default values', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      store.patchSource('src', { enabled: false, note: 'n', category: 'c' })
      store.patchSkill('src', 'skill', { enabled: false })
      const raw = JSON.parse(readFileSync(tree.path('state.json'), 'utf8'))
      expect(raw).toEqual({
        version: 1,
        sources: { src: { enabled: false, category: 'c', note: 'n' } },
        skills: { [skillStateKey('src', 'skill')]: { enabled: false } },
      })
    } finally {
      tree.cleanup()
    }
  })

  it('drops back to the default by deleting the entry', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      store.patchSource('src', { enabled: false })
      store.patchSource('src', { enabled: true })
      expect(store.read().sources).toEqual({})
      store.patchSkill('src', 'skill', { note: 'hello' })
      store.patchSkill('src', 'skill', { note: '' })
      expect(store.read().skills).toEqual({})
    } finally {
      tree.cleanup()
    }
  })

  it('removes every entry of a dropped source', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      store.patchSource('src', { enabled: false })
      store.patchSkill('src', 'one', { enabled: false })
      store.patchSkill('src', 'two', { note: 'keep me' })
      store.patchSkill('other', 'three', { enabled: false })
      store.dropSource('src')
      const state = store.read()
      expect(state.sources).toEqual({})
      expect(state.skills).toEqual({ 'other/three': { enabled: false } })
    } finally {
      tree.cleanup()
    }
  })

  it('tolerates a malformed state file', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      writeFileSync(tree.path('state.json'), '{ not json')
      expect(store.read()).toEqual({ version: 1, sources: {}, skills: {} })
      expect(store.patchSource('src', { enabled: false }).sources).toEqual({ src: { enabled: false } })
    } finally {
      tree.cleanup()
    }
  })

  it('normalizes junk entries away', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      writeFileSync(tree.path('state.json'), JSON.stringify({
        version: 1,
        sources: { bad: 'nope', ok: { enabled: 'yes', category: '  ' }, off: { enabled: false } },
        skills: { 'a/b': { note: 42 } },
      }))
      expect(store.read()).toEqual({ version: 1, sources: { off: { enabled: false } }, skills: {} })
    } finally {
      tree.cleanup()
    }
  })

  it('resolves skill enablement through its source', () => {
    const tree = tempTree()
    try {
      const store = new StateStore(tree.path('state.json'), silentLogger)
      store.patchSkill('src', 'one', { enabled: false })
      const state = store.read()
      expect(isSkillEnabled(state, 'src', 'one')).toBe(false)
      expect(isSkillVisible(state, 'src', 'one')).toBe(false)
      store.patchSource('src', { enabled: false })
      expect(isSkillEnabled(store.read(), 'src', 'two')).toBe(true)
      expect(isSkillVisible(store.read(), 'src', 'two')).toBe(false)
    } finally {
      tree.cleanup()
    }
  })
})
