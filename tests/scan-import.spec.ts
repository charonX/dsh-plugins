import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImportStore, importSkills } from '../src/imports.ts'
import { scanGlobalSkills } from '../src/scan.ts'
import { skillFields, tempTree, writeSkill, type TempTree } from './helpers.ts'

const silentLogger = { warn: () => {} }

interface Fixture {
  readonly tree: TempTree
  readonly libraryDir: string
  readonly globalRoot: string
  readonly store: ImportStore
  readonly options: {
    libraryDir: string
    store: ImportStore
    extraRoots: readonly string[]
    logger: typeof silentLogger
  }
}

function fixture(): Fixture {
  const tree = tempTree()
  const libraryDir = tree.path('library')
  const globalRoot = tree.path('global-skills')
  mkdirSync(libraryDir, { recursive: true })
  mkdirSync(join(globalRoot, 'alpha'), { recursive: true })
  writeFileSync(join(globalRoot, 'alpha', 'SKILL.md'), `---\n${skillFields('alpha', 'Alpha from another agent.').join('\n')}\n---\n\nAlpha body.\n`)
  writeFileSync(join(globalRoot, 'beta.md'), `---\n${skillFields('beta', 'Flat beta.').join('\n')}\n---\n\nBeta body.\n`)
  const store = new ImportStore(tree.path('imports.json'), silentLogger)
  return {
    tree,
    libraryDir,
    globalRoot,
    store,
    options: { libraryDir, store, extraRoots: [globalRoot], logger: silentLogger },
  }
}

function scan(fixtureValue: Fixture) {
  return scanGlobalSkills({
    extraRoots: fixtureValue.options.extraRoots,
    libraryDir: fixtureValue.libraryDir,
    importedKeys: fixtureValue.store.keys(),
    logger: silentLogger,
  })
}

function globalPath(fixtureValue: Fixture, name: string): string {
  return join(fixtureValue.globalRoot, name, 'SKILL.md')
}

describe('scanGlobalSkills', () => {
  it('finds directory bundles and flat files, with importability status', () => {
    const value = fixture()
    try {
      const result = scan(value)
      const custom = result.roots.find((root) => root.key === 'custom-1')
      expect(custom).toMatchObject({ path: value.globalRoot, exists: true })
      expect(result.roots.some((root) => root.key === 'dsh')).toBe(true)
      const rows = result.skills.filter((skill) => skill.originKey === 'custom-1')
      expect(rows.map((skill) => [skill.name, skill.dirName, skill.status])).toEqual([
        ['alpha', 'alpha', 'importable'],
        ['beta', 'beta', 'importable'],
      ])
    } finally {
      value.tree.cleanup()
    }
  })

  it('marks an identical library copy as imported and a different one as a conflict', () => {
    const value = fixture()
    try {
      importSkills(value.options, { paths: [globalPath(value, 'alpha')] })
      let rows = scan(value).skills.filter((skill) => skill.originKey === 'custom-1')
      expect(rows.find((skill) => skill.name === 'alpha')?.status).toBe('imported')

      writeSkill(join(value.libraryDir, 'local', 'skills', 'beta'), skillFields('beta', 'A different beta.'), 'other body')
      rows = scan(value).skills.filter((skill) => skill.originKey === 'custom-1')
      expect(rows.find((skill) => skill.name === 'beta')?.status).toBe('conflict')
    } finally {
      value.tree.cleanup()
    }
  })

  it('ignores files that are not skills and reports invalid frontmatter', () => {
    const value = fixture()
    try {
      writeFileSync(join(value.globalRoot, 'README.txt'), 'not a skill')
      writeFileSync(join(value.globalRoot, 'broken.md'), 'no frontmatter')
      const rows = scan(value).skills.filter((skill) => skill.originKey === 'custom-1')
      expect(rows.some((skill) => skill.name === 'README')).toBe(false)
      expect(rows.find((skill) => skill.name === 'broken')?.status).toBe('invalid')
    } finally {
      value.tree.cleanup()
    }
  })
})

describe('importSkills', () => {
  it('copies a directory skill into an imported source and records provenance', () => {
    const value = fixture()
    try {
      const result = importSkills(value.options, { paths: [globalPath(value, 'alpha')] })
      expect(result.outcomes).toEqual([expect.objectContaining({ status: 'imported', source: 'imported-custom-1', skillName: 'alpha' })])
      const target = join(value.libraryDir, 'imported-custom-1', 'skills', 'alpha', 'SKILL.md')
      expect(readFileSync(target, 'utf8')).toContain('name: alpha')
      const record = value.store.read()['imported-custom-1/alpha']
      expect(record).toMatchObject({ originKey: 'custom-1', originPath: globalPath(value, 'alpha') })
      expect(record?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      value.tree.cleanup()
    }
  })

  it('imports a flat markdown skill as a directory bundle', () => {
    const value = fixture()
    try {
      const result = importSkills(value.options, { paths: [join(value.globalRoot, 'beta.md')] })
      expect(result.outcomes[0]?.status).toBe('imported')
      expect(existsSync(join(value.libraryDir, 'imported-custom-1', 'skills', 'beta', 'SKILL.md'))).toBe(true)
    } finally {
      value.tree.cleanup()
    }
  })

  it('skips an identical copy and refuses a conflicting one unless it is an overwritable import', () => {
    const value = fixture()
    try {
      importSkills(value.options, { paths: [globalPath(value, 'alpha')] })
      const again = importSkills(value.options, { paths: [globalPath(value, 'alpha')] })
      expect(again.outcomes[0]).toMatchObject({ status: 'skipped', code: 'ALREADY_IMPORTED' })

      writeFileSync(globalPath(value, 'alpha'), `---\n${skillFields('alpha', 'Changed upstream.').join('\n')}\n---\n\nChanged body.\n`)
      const conflict = importSkills(value.options, { paths: [globalPath(value, 'alpha')] })
      expect(conflict.outcomes[0]).toMatchObject({ status: 'conflict', code: 'SKILL_NAME_CONFLICT' })
      expect(readFileSync(join(value.libraryDir, 'imported-custom-1', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('Alpha body')

      const overwritten = importSkills(value.options, { paths: [globalPath(value, 'alpha')], overwrite: true })
      expect(overwritten.outcomes[0]?.status).toBe('overwritten')
      expect(readFileSync(join(value.libraryDir, 'imported-custom-1', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('Changed body')
    } finally {
      value.tree.cleanup()
    }
  })

  it('never overwrites a library skill that was not imported', () => {
    const value = fixture()
    try {
      writeSkill(join(value.libraryDir, 'local', 'skills', 'alpha'), skillFields('alpha', 'Locally managed.'), 'local body')
      const result = importSkills(value.options, { paths: [globalPath(value, 'alpha')], overwrite: true })
      expect(result.outcomes[0]).toMatchObject({ status: 'conflict', source: 'local' })
      expect(readFileSync(join(value.libraryDir, 'local', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('local body')
    } finally {
      value.tree.cleanup()
    }
  })

  it('rejects paths outside every scan root', () => {
    const value = fixture()
    try {
      const outside = join(value.tree.root, 'outside', 'SKILL.md')
      writeFileSync(join(value.tree.root, 'outside.md'), 'x')
      mkdirSync(join(value.tree.root, 'outside'), { recursive: true })
      writeFileSync(outside, `---\n${skillFields('outside').join('\n')}\n---\n`)
      const result = importSkills(value.options, { paths: [outside] })
      expect(result.outcomes[0]).toMatchObject({ status: 'failed', code: 'IMPORT_PATH_INVALID' })
    } finally {
      value.tree.cleanup()
    }
  })

  it('rejects an empty selection', () => {
    const value = fixture()
    try {
      expect(() => importSkills(value.options, { paths: [] })).toThrow(/at least one/)
    } finally {
      value.tree.cleanup()
    }
  })
})

describe('ImportStore', () => {
  it('drops the provenance of a removed source', () => {
    const value = fixture()
    try {
      importSkills(value.options, { paths: [globalPath(value, 'alpha'), join(value.globalRoot, 'beta.md')] })
      expect(Object.keys(value.store.read())).toHaveLength(2)
      value.store.dropSource('imported-custom-1')
      expect(value.store.read()).toEqual({})
    } finally {
      value.tree.cleanup()
    }
  })
})
