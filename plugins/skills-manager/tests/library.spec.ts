import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { discoverSkillDirs, readGitRemote, readSourceVersion, scanLibrary } from '../src/library.ts'
import { skillFields, tempTree, writeSkill } from './helpers.js'

const silentLogger = { warn: () => {} }

describe('discoverSkillDirs', () => {
  it('recognizes a root SKILL.md and names the skill after the source directory', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('single'), skillFields('single'))
      expect(discoverSkillDirs(tree.path('single'))).toEqual([
        { skillName: 'single', dir: tree.path('single'), relativePath: '.' },
      ])
    } finally {
      tree.cleanup()
    }
  })

  it('discovers skills/<name> and one nested skills/<category>/<name> level', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('repo', 'skills', 'flat'), skillFields('flat'))
      writeSkill(tree.path('repo', 'skills', 'engineering', 'nested'), skillFields('nested'))
      const discovered = discoverSkillDirs(tree.path('repo'))
      expect(discovered.map((skill) => skill.skillName).sort()).toEqual(['flat', 'nested'])
      expect(discovered.find((skill) => skill.skillName === 'nested')?.relativePath)
        .toBe('skills/engineering/nested')
    } finally {
      tree.cleanup()
    }
  })

  it('does not rescan a directory already recognized as a skill', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('repo', 'skills', 'outer'), skillFields('outer'))
      writeSkill(tree.path('repo', 'skills', 'outer', 'inner'), skillFields('inner'))
      expect(discoverSkillDirs(tree.path('repo')).map((skill) => skill.skillName)).toEqual(['outer'])
    } finally {
      tree.cleanup()
    }
  })

  it('returns nothing for a directory with no supported layout', () => {
    const tree = tempTree()
    try {
      mkdirSync(tree.path('empty'), { recursive: true })
      expect(discoverSkillDirs(tree.path('empty'))).toEqual([])
    } finally {
      tree.cleanup()
    }
  })
})

describe('scanLibrary', () => {
  it('skips hidden directories and sorts sources and skills', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'zeta', 'skills', 'b-skill'), skillFields('b-skill'))
      writeSkill(tree.path('library', 'zeta', 'skills', 'a-skill'), skillFields('a-skill'))
      writeSkill(tree.path('library', 'alpha'), skillFields('alpha'))
      writeSkill(tree.path('library', '.cache'), skillFields('cache'))
      const scanned = scanLibrary(tree.path('library'), silentLogger)
      expect(scanned.map((source) => source.slug)).toEqual(['alpha', 'zeta'])
      expect(scanned[1]?.skills.map((skill) => skill.skillName)).toEqual(['a-skill', 'b-skill'])
      expect(scanned[1]?.skills[0]?.valid).toBe(true)
      expect(scanned[1]?.skills[0]?.name).toBe('a-skill')
    } finally {
      tree.cleanup()
    }
  })

  it('marks invalid frontmatter, bad names, and duplicate names with a problem', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src', 'skills', 'missing-description'), ['name: missing-description'])
      writeSkill(tree.path('library', 'src', 'skills', 'bad-name'), ['name: Bad_Name', 'description: x'])
      writeSkill(tree.path('library', 'src', 'skills', 'first'), skillFields('shared'))
      writeSkill(tree.path('library', 'src', 'skills', 'second'), skillFields('shared'))
      const scanned = scanLibrary(tree.path('library'), silentLogger)
      const skills = scanned[0]?.skills ?? []
      expect(skills.find((skill) => skill.skillName === 'missing-description')?.valid).toBe(false)
      expect(skills.find((skill) => skill.skillName === 'bad-name')?.problem).toContain('kebab-case')
      expect(skills.find((skill) => skill.skillName === 'first')?.valid).toBe(true)
      expect(skills.find((skill) => skill.skillName === 'second')?.problem).toContain('duplicate skill name')
    } finally {
      tree.cleanup()
    }
  })

  it('reports a source without skills as a problem instead of failing the listing', () => {
    const tree = tempTree()
    try {
      mkdirSync(tree.path('library', 'empty'), { recursive: true })
      writeSkill(tree.path('library', 'good'), skillFields('good'))
      const scanned = scanLibrary(tree.path('library'), silentLogger)
      expect(scanned.map((source) => source.slug)).toEqual(['empty', 'good'])
      expect(scanned[0]?.problem).toContain('no SKILL.md')
      expect(scanned[1]?.problem).toBeUndefined()
    } finally {
      tree.cleanup()
    }
  })

  it('reads invocation flags from frontmatter', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src', 'skills', 'model-only'), [
        'name: model-only',
        'description: model only',
        'user-invocable: false',
      ])
      writeSkill(tree.path('library', 'src', 'skills', 'user-only'), [
        'name: user-only',
        'description: user only',
        'disable-model-invocation: true',
      ])
      const skills = scanLibrary(tree.path('library'), silentLogger)[0]?.skills ?? []
      expect(skills.find((skill) => skill.skillName === 'model-only')?.invocation)
        .toEqual({ modelInvocable: true, userInvocable: false })
      expect(skills.find((skill) => skill.skillName === 'user-only')?.invocation)
        .toEqual({ modelInvocable: false, userInvocable: true })
    } finally {
      tree.cleanup()
    }
  })

  it('returns an empty listing for a missing library root', () => {
    expect(scanLibrary('/nonexistent/dsh-skills-manager/library', silentLogger)).toEqual([])
  })
})

describe('source metadata', () => {
  it('prefers package.json version and falls back to no version for local sources', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('src'), skillFields('src'))
      expect(readSourceVersion(tree.path('src'), false)).toBeUndefined()
      writeFileSync(tree.path('src', 'package.json'), JSON.stringify({ version: '1.2.3' }))
      expect(readSourceVersion(tree.path('src'), false)).toBe('1.2.3')
    } finally {
      tree.cleanup()
    }
  })

  it('reads the origin URL from .git/config and ignores a missing one', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('src'), skillFields('src'))
      expect(readGitRemote(tree.path('src'))).toBeUndefined()
      mkdirSync(tree.path('src', '.git'), { recursive: true })
      writeFileSync(
        tree.path('src', '.git', 'config'),
        '[remote "origin"]\n\turl = https://example.com/owner/repo.git\n',
      )
      expect(readGitRemote(tree.path('src'))).toBe('https://example.com/owner/repo.git')
    } finally {
      tree.cleanup()
    }
  })
})
