import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManagerError } from '../src/errors.ts'
import { LinkManager } from '../src/links.ts'
import { StateStore } from '../src/state.ts'
import { skillFields, tempTree, writeSkill, type TempTree } from './helpers.ts'

const silentLogger = { warn: () => {} }

interface Fixture {
  readonly tree: TempTree
  readonly links: LinkManager
  readonly state: StateStore
  readonly libraryDir: string
  readonly project: string
}

function fixture(options: { withSource?: boolean } = {}): Fixture {
  const tree = tempTree()
  const libraryDir = tree.path('library')
  mkdirSync(libraryDir, { recursive: true })
  if (options.withSource !== false) {
    writeSkill(join(libraryDir, 'src', 'skills', 'alpha'), skillFields('alpha'), 'Alpha body.')
    writeSkill(join(libraryDir, 'src', 'skills', 'beta'), skillFields('beta'), 'Beta body.')
  }
  const state = new StateStore(tree.path('manager-state.json'), silentLogger)
  const links = new LinkManager({
    libraryDir,
    recordPath: tree.path('links.json'),
    logger: silentLogger,
    readState: () => state.read(),
  })
  const project = tree.path('project')
  mkdirSync(project, { recursive: true })
  return { tree, links, state, libraryDir, project }
}

function linkPath(project: string, skillsDir: string, name: string): string {
  return join(project, ...skillsDir.split('/'), name)
}

describe('LinkManager.link', () => {
  it('creates library-targeted symlinks and records the intent', () => {
    const { tree, links, project, libraryDir } = fixture()
    try {
      const report = links.link({ project, source: 'src', agents: ['dsh'] })
      expect(report.counts).toEqual({ linked: 2, missing: 0, broken: 0, conflict: 0, external: 0 })
      const alphaLink = linkPath(project, '.dsh/skills', 'alpha')
      expect(lstatSync(alphaLink).isSymbolicLink()).toBe(true)
      expect(readlinkSync(alphaLink)).toBe(join(libraryDir, 'src', 'skills', 'alpha'))
      expect(report.project.agents).toEqual(['dsh'])
      expect(report.project.entries.map((entry) => entry.skillName)).toEqual(['alpha', 'beta'])
      expect(JSON.parse(readFileSync(tree.path('links.json'), 'utf8'))).toMatchObject({
        projects: { [project]: { agents: ['dsh'] } },
      })
    } finally {
      tree.cleanup()
    }
  })

  it('links one skill into several agents and dedupes a shared directory', () => {
    const { tree, links, project } = fixture()
    try {
      const report = links.link({ project, source: 'src', skillName: 'alpha', agents: ['dsh', 'codex', 'amp'] })
      expect(report.counts.linked).toBe(2)
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(true)
      // codex and amp are both universal agents using `.agents/skills`.
      expect(existsSync(linkPath(project, '.agents/skills', 'alpha'))).toBe(true)
      const shared = report.project.targets.find((target) => target.skillsDir === '.agents/skills')
      expect(shared?.agents).toEqual(['codex', 'amp'])
    } finally {
      tree.cleanup()
    }
  })

  it('is idempotent and leaves real files and foreign links untouched', () => {
    const { tree, links, project } = fixture()
    try {
      mkdirSync(linkPath(project, '.dsh/skills', 'alpha'), { recursive: true })
      writeFileSync(join(linkPath(project, '.dsh/skills', 'alpha'), 'SKILL.md'), '# mine\n')
      symlinkSync(tree.path('elsewhere'), linkPath(project, '.dsh/skills', 'beta'))
      mkdirSync(tree.path('elsewhere'), { recursive: true })

      const report = links.link({ project, source: 'src', agents: ['dsh'] })
      expect(report.counts.conflict).toBe(1)
      expect(report.counts.external).toBe(1)
      expect(readFileSync(join(linkPath(project, '.dsh/skills', 'alpha'), 'SKILL.md'), 'utf8')).toBe('# mine\n')
      expect(readlinkSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(tree.path('elsewhere'))

      const repeat = links.link({ project, source: 'src', agents: ['dsh'] })
      expect(repeat.counts.conflict).toBe(1)
      expect(repeat.counts.external).toBe(1)
    } finally {
      tree.cleanup()
    }
  })

  it('rejects a disabled source, a disabled skill, a relative project, and unknown agents', () => {
    const { tree, links, state, project, libraryDir } = fixture()
    try {
      state.patchSkill('src', 'beta', { enabled: false })
      expect(() => links.link({ project, source: 'src', skillName: 'beta' })).toThrow(SkillManagerError)
      state.patchSource('src', { enabled: false })
      expect(() => links.link({ project, source: 'src' })).toThrow(/disabled/)
      state.patchSource('src', { enabled: true })
      expect(() => links.link({ project: 'relative/path', source: 'src' })).toThrow(/absolute/)
      expect(() => links.link({ project: join(libraryDir, 'src'), source: 'src' })).toThrow(/skill library/)
      expect(() => links.link({ project, source: 'src', agents: ['nope'] })).toThrow(/Unknown agent/)
    } finally {
      tree.cleanup()
    }
  })

  it('links every enabled valid skill and ignores invalid ones', () => {
    const { tree, links, project, libraryDir } = fixture()
    try {
      writeSkill(join(libraryDir, 'src', 'skills', 'broken'), ['name: broken'])
      const report = links.link({ project, source: 'src' })
      expect(report.project.entries.map((entry) => entry.skillName).sort()).toEqual(['alpha', 'beta'])
      expect(existsSync(linkPath(project, '.dsh/skills', 'broken'))).toBe(false)
    } finally {
      tree.cleanup()
    }
  })
})

describe('LinkManager.unlink', () => {
  it('removes only the requested skill links and prunes the record', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      const report = links.unlink({ project, source: 'src', skillName: 'alpha' })
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(true)
      expect(report.project.entries.map((entry) => entry.skillName)).toEqual(['beta'])
    } finally {
      tree.cleanup()
    }
  })

  it('rejects an unrecorded project', () => {
    const { tree, links, project } = fixture()
    try {
      expect(() => links.unlink({ project, source: 'src' })).toThrow(/No linked skills/)
    } finally {
      tree.cleanup()
    }
  })
})

describe('LinkManager.resync', () => {
  it('restores a manually deleted link', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      rmSync(linkPath(project, '.dsh/skills', 'alpha'))
      expect(links.listProjects()[0]?.targets.some((target) => target.state === 'missing')).toBe(true)
      const report = links.resync(project)
      expect(report.counts.linked).toBe(2)
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(true)
    } finally {
      tree.cleanup()
    }
  })

  it('drops a broken link and the stale record after the skill disappears', () => {
    const { tree, links, project, libraryDir } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      rmSync(join(libraryDir, 'src', 'skills', 'beta'), { recursive: true })
      const broken = links.listProjects()[0]
      expect(broken?.stale.map((entry) => entry.skillName)).toEqual(['beta'])
      const report = links.resync(project)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(false)
      expect(report.project.entries.map((entry) => entry.skillName)).toEqual(['alpha'])
    } finally {
      tree.cleanup()
    }
  })

  it('repairs a library link that was repointed by hand', () => {
    const { tree, links, project, libraryDir } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      const link = linkPath(project, '.dsh/skills', 'alpha')
      rmSync(link)
      symlinkSync(join(libraryDir, 'src', 'skills', 'beta'), link)
      expect(links.listProjects()[0]?.targets.some((target) => target.state === 'external')).toBe(true)
      links.resync(project)
      expect(readlinkSync(link)).toBe(join(libraryDir, 'src', 'skills', 'alpha'))
    } finally {
      tree.cleanup()
    }
  })
})

describe('LinkManager.forget', () => {
  it('cascades link and record removal before a source is deleted', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.forgetSource('src')
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(false)
      expect(links.listProjects()).toEqual([])
    } finally {
      tree.cleanup()
    }
  })

  it('removes one disabled skill only', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.forgetSkill('src', 'alpha')
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(true)
      expect(links.listProjects()[0]?.entries.map((entry) => entry.skillName)).toEqual(['beta'])
    } finally {
      tree.cleanup()
    }
  })
})

describe('per-project distribution switch', () => {
  it('disables distribution but keeps the record, then restores it', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      const disabled = links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: false })
      expect(disabled.project.entries).toEqual([
        { source: 'src', skillName: 'alpha', enabled: false },
        { source: 'src', skillName: 'beta', enabled: true },
      ])
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(true)
      // A disabled entry is not reported as a missing link.
      expect(disabled.project.targets.some((target) => target.skillName === 'alpha')).toBe(false)
      expect(disabled.counts.missing).toBe(0)

      const enabled = links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: true })
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(true)
      expect(enabled.project.entries.every((entry) => entry.enabled)).toBe(true)
    } finally {
      tree.cleanup()
    }
  })

  it('keeps disabled entries across resync and never recreates their links', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: false })
      rmSync(linkPath(project, '.dsh/skills', 'beta'))
      const report = links.resync(project)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(true)
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(report.project.entries.map((entry) => [entry.skillName, entry.enabled]))
        .toEqual([['alpha', false], ['beta', true]])
    } finally {
      tree.cleanup()
    }
  })

  it('re-enables a whole source at once', () => {
    const { tree, links, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.setEnabled({ project, source: 'src', enabled: false })
      expect(links.listProjects()[0]?.targets).toEqual([])
      links.setEnabled({ project, source: 'src', enabled: true })
      expect(links.listProjects()[0]?.targets.map((target) => target.state)).toEqual(['linked', 'linked'])
    } finally {
      tree.cleanup()
    }
  })

  it('rejects enabling a globally disabled skill', () => {
    const { tree, links, state, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: false })
      state.patchSkill('src', 'alpha', { enabled: false })
      expect(() => links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: true }))
        .toThrow(/disabled/)
    } finally {
      tree.cleanup()
    }
  })
})

describe('global switch and project records', () => {
  it('detaches links on global disable but keeps records for restore', () => {
    const { tree, links, state, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      state.patchSource('src', { enabled: false })
      links.detach('src')
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(links.listProjects()[0]?.entries).toHaveLength(2)
      state.patchSource('src', { enabled: true })
      links.restore('src')
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(true)
    } finally {
      tree.cleanup()
    }
  })

  it('does not restore a project entry the user switched off', () => {
    const { tree, links, state, project } = fixture()
    try {
      links.link({ project, source: 'src', agents: ['dsh'] })
      links.setEnabled({ project, source: 'src', skillName: 'alpha', enabled: false })
      state.patchSource('src', { enabled: false })
      links.detach('src')
      state.patchSource('src', { enabled: true })
      links.restore('src')
      expect(existsSync(linkPath(project, '.dsh/skills', 'alpha'))).toBe(false)
      expect(existsSync(linkPath(project, '.dsh/skills', 'beta'))).toBe(true)
    } finally {
      tree.cleanup()
    }
  })
})
