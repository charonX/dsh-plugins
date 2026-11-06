import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LibrarySkillProvider } from '../src/provider.ts'
import { StateStore } from '../src/state.ts'
import { tempTree, writeSkill, skillFields } from './helpers.ts'

const silentLogger = { warn: () => {} }

function providerFor(libraryDir: string, statePath: string, rank = 450): {
  provider: LibrarySkillProvider
  invalidateCount: () => number
} {
  const state = new StateStore(statePath, silentLogger)
  let invalidations = 0
  const provider = new LibrarySkillProvider(
    {
      libraryDir,
      providerName: 'skills-manager',
      rank,
      readState: () => state.read(),
      logger: silentLogger,
    },
    { signal: new AbortController().signal, invalidate: () => { invalidations += 1 } },
  )
  return { provider, invalidateCount: () => invalidations }
}

describe('LibrarySkillProvider', () => {
  it('exposes valid enabled skills with rank, source, and a directory resource base', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src', 'skills', 'alpha'), skillFields('alpha', 'Alpha does A.'), '# Alpha')
      writeSkill(tree.path('library', 'src', 'skills', 'beta'), skillFields('beta'))
      const { provider } = providerFor(tree.path('library'), tree.path('state.json'))
      const candidates = await provider.list({})
      expect(candidates.map((candidate) => candidate.name)).toEqual(['alpha', 'beta'])
      const alpha = candidates[0]
      expect(alpha?.rank).toBe(450)
      expect(alpha?.source).toBe('skills-manager')
      expect(alpha?.provider).toBe('skills-manager')
      expect(alpha?.resourceBase).toEqual({ kind: 'directory', path: tree.path('library', 'src', 'skills', 'alpha') })
      expect(alpha?.path).toBe(tree.path('library', 'src', 'skills', 'alpha', 'SKILL.md'))
    } finally {
      tree.cleanup()
    }
  })

  it('honors source and skill disablement and reloads state per observation', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src', 'skills', 'alpha'), skillFields('alpha'))
      writeSkill(tree.path('library', 'src', 'skills', 'beta'), skillFields('beta'))
      const state = new StateStore(tree.path('state.json'), silentLogger)
      const { provider } = providerFor(tree.path('library'), tree.path('state.json'))
      expect((await provider.list({})).length).toBe(2)

      state.patchSkill('src', 'alpha', { enabled: false })
      expect((await provider.list({})).map((candidate) => candidate.name)).toEqual(['beta'])

      state.patchSource('src', { enabled: false })
      expect(await provider.list({})).toEqual([])
    } finally {
      tree.cleanup()
    }
  })

  it('skips invalid files and keeps the first owner of a duplicated catalog name', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'a', 'skills', 'first'), skillFields('shared'))
      writeSkill(tree.path('library', 'b', 'skills', 'second'), skillFields('shared'))
      writeSkill(tree.path('library', 'b', 'skills', 'invalid'), ['name: invalid'])
      const warnings: string[] = []
      const state = new StateStore(tree.path('state.json'), silentLogger)
      const provider = new LibrarySkillProvider(
        {
          libraryDir: tree.path('library'),
          providerName: 'skills-manager',
          rank: 450,
          readState: () => state.read(),
          logger: { warn: (message) => { warnings.push(message) } },
        },
        { signal: new AbortController().signal, invalidate: () => {} },
      )
      const candidates = await provider.list({})
      expect(candidates.map((candidate) => candidate.name)).toEqual(['shared'])
      expect(warnings.some((warning) => warning.includes('already provided'))).toBe(true)
    } finally {
      tree.cleanup()
    }
  })

  it('returns the body from get() and undefined once the file is gone', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src'), skillFields('alpha', 'Alpha does A.'), 'Follow these steps.')
      const { provider } = providerFor(tree.path('library'), tree.path('state.json'))
      const [candidate] = await provider.list({})
      expect(candidate).toBeDefined()
      const definition = await provider.get(candidate!, {})
      expect(definition?.content).toBe('Follow these steps.')
      expect(definition?.description).toBe('Alpha does A.')
      expect(definition?.resourceBase).toEqual({ kind: 'directory', path: tree.path('library', 'src') })

      mkdirSync(tree.path('library', 'src', 'empty'), { recursive: true })
      const missing = await provider.get({ ...candidate!, locator: { dir: tree.path('library', 'gone'), name: 'alpha' } }, {})
      expect(missing).toBeUndefined()
    } finally {
      tree.cleanup()
    }
  })

  it('carries the invocation policy from frontmatter', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src', 'skills', 'user-only'), [
        'name: user-only',
        'description: user only',
        'disable-model-invocation: true',
      ])
      const { provider } = providerFor(tree.path('library'), tree.path('state.json'))
      const [candidate] = await provider.list({})
      expect(candidate?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    } finally {
      tree.cleanup()
    }
  })

  it('invalidates the registry catalog on request', () => {
    const tree = tempTree()
    try {
      const { provider, invalidateCount } = providerFor(tree.path('library'), tree.path('state.json'))
      provider.invalidate()
      expect(invalidateCount()).toBe(1)
    } finally {
      tree.cleanup()
    }
  })
})
