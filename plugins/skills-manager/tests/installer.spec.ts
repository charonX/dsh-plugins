import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SkillManagerError } from '../src/errors.ts'
import type { JobRecord } from '../src/jobs.ts'
import {
  assertGitIdentifier,
  deriveGitSlug,
  installGitSource,
  installLocalSource,
  removeSourceDirectory,
  resolveFreeSlug,
  updateGitSource,
} from '../src/installer.ts'
import { skillFields, tempTree, writeSkill } from './helpers.ts'

const silentLogger = { warn: () => {} }

function newJob(): JobRecord {
  return { id: 'job', status: 'pending', error: null, log: null }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: process.env.HOME,
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, env: gitEnv(), encoding: 'utf8' })
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', message])
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-b', 'main'])
}

describe('assertGitIdentifier', () => {
  it('accepts https, ssh, scp-like, and optionally file transports', () => {
    expect(assertGitIdentifier('https://example.com/o/r.git', false)).toBe('https://example.com/o/r.git')
    expect(assertGitIdentifier('ssh://git@example.com/o/r.git', false)).toBe('ssh://git@example.com/o/r.git')
    expect(assertGitIdentifier('git@example.com:o/r.git', false)).toBe('git@example.com:o/r.git')
    expect(assertGitIdentifier('file:///tmp/repo', true)).toBe('file:///tmp/repo')
  })

  it('rejects executable transports, option-shaped values, and empty values', () => {
    for (const value of ['ext::sh -c touch% /tmp/pwned', '--upload-pack=evil', '', '   ']) {
      expect(() => assertGitIdentifier(value, true)).toThrow(SkillManagerError)
    }
    expect(() => assertGitIdentifier('file:///tmp/repo', false)).toThrow(/disabled by configuration/)
  })
})

describe('slugs', () => {
  it('derives owner-repo and sanitizes characters', () => {
    expect(deriveGitSlug('https://github.com/mattpocock/skills.git')).toBe('mattpocock-skills')
    expect(deriveGitSlug('git@github.com:Owner/My Repo.git')).toBe('Owner-My-Repo')
    expect(deriveGitSlug('https://example.com/repo')).toBe('example.com-repo')
  })

  it('appends a numeric suffix while a directory exists', () => {
    const tree = tempTree()
    try {
      mkdirSync(tree.path('library', 'owner-repo'), { recursive: true })
      mkdirSync(tree.path('library', 'owner-repo-2'), { recursive: true })
      expect(resolveFreeSlug(tree.path('library'), 'owner-repo')).toBe('owner-repo-3')
    } finally {
      tree.cleanup()
    }
  })
})

describe('installLocalSource', () => {
  it('copies a local source without its .git directory and validates it', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('source', 'skills', 'alpha'), skillFields('alpha'))
      mkdirSync(tree.path('source', '.git'), { recursive: true })
      writeFileSync(tree.path('source', '.git', 'config'), '')
      const job = newJob()
      const slug = await installLocalSource(
        job,
        { libraryDir: tree.path('library'), allowFileProtocol: true },
        tree.path('source'),
        false,
      )
      expect(slug).toBe('source')
      expect(readFileSync(tree.path('library', 'source', 'skills', 'alpha', 'SKILL.md'), 'utf8'))
        .toContain('name: alpha')
      expect(() => readFileSync(tree.path('library', 'source', '.git', 'config'))).toThrow()
    } finally {
      tree.cleanup()
    }
  })

  it('refuses to overwrite without force and replaces with force', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('source'), skillFields('first'))
      const options = { libraryDir: tree.path('library'), allowFileProtocol: true }
      await installLocalSource(newJob(), options, tree.path('source'), false)
      writeSkill(tree.path('source'), skillFields('second'))
      await expect(
        installLocalSource(newJob(), options, tree.path('source'), false),
      ).rejects.toMatchObject({ code: 'SKILL_SLUG_CONFLICT', status: 409 })
      await installLocalSource(newJob(), options, tree.path('source'), true)
      expect(readFileSync(tree.path('library', 'source', 'SKILL.md'), 'utf8')).toContain('name: second')
    } finally {
      tree.cleanup()
    }
  })

  it('rejects sources without skills and directories inside the library', async () => {
    const tree = tempTree()
    try {
      mkdirSync(tree.path('empty'), { recursive: true })
      await expect(
        installLocalSource(newJob(), { libraryDir: tree.path('library'), allowFileProtocol: true }, tree.path('empty'), false),
      ).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' })

      writeSkill(tree.path('library', 'inside'), skillFields('inside'))
      await expect(
        installLocalSource(
          newJob(),
          { libraryDir: tree.path('library'), allowFileProtocol: true },
          tree.path('library', 'inside'),
          false,
        ),
      ).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' })
    } finally {
      tree.cleanup()
    }
  })
})

describe('git sources', () => {
  it('clones a git source, updates it fast-forward, and rejects unsupported transports', async () => {
    const tree = tempTree()
    try {
      initRepo(tree.path('remote'))
      writeSkill(tree.path('remote', 'skills', 'alpha'), skillFields('alpha'))
      commitAll(tree.path('remote'), 'first')
      const identifier = `file://${tree.path('remote')}`
      const options = { libraryDir: tree.path('library'), allowFileProtocol: true }
      const job = newJob()
      const slug = await installGitSource(job, options, identifier)
      expect(slug).toBe('remote')

      writeSkill(tree.path('remote', 'skills', 'beta'), skillFields('beta'))
      commitAll(tree.path('remote'), 'second')
      const updateJob = newJob()
      await updateGitSource(updateJob, options, tree.path('library', slug))
      expect(readFileSync(tree.path('library', slug, 'skills', 'beta', 'SKILL.md'), 'utf8'))
        .toContain('name: beta')

      // A local copy has no upstream to pull from.
      writeSkill(tree.path('local'), skillFields('local'))
      const localSlug = await installLocalSource(newJob(), options, tree.path('local'), false)
      await expect(updateGitSource(newJob(), options, tree.path('library', localSlug)))
        .rejects.toMatchObject({ code: 'SKILL_UPDATE_UNSUPPORTED' })
    } finally {
      tree.cleanup()
    }
  })

  it('reports raw git output in the job log when a pull fails', async () => {
    const tree = tempTree()
    try {
      initRepo(tree.path('remote'))
      writeSkill(tree.path('remote'), skillFields('alpha'))
      commitAll(tree.path('remote'), 'first')
      const options = { libraryDir: tree.path('library'), allowFileProtocol: true }
      const slug = await installGitSource(newJob(), options, `file://${tree.path('remote')}`)

      // Rewrite the clone's history so the pull cannot fast-forward.
      writeSkill(tree.path('remote'), skillFields('conflict'))
      commitAll(tree.path('remote'), 'second')
      const clone = tree.path('library', slug)
      writeSkill(clone, skillFields('local-change'))
      commitAll(clone, 'local change')

      const job = newJob()
      await expect(updateGitSource(job, options, clone)).rejects.toMatchObject({ code: 'SKILL_UPDATE_FAILED' })
      expect(job.log ?? '').not.toBe('')
    } finally {
      tree.cleanup()
    }
  })

  it('rolls the clone back when the repository holds no skill', async () => {
    const tree = tempTree()
    try {
      initRepo(tree.path('remote'))
      writeFileSync(tree.path('remote', 'README.md'), 'no skills here\n')
      commitAll(tree.path('remote'), 'first')
      await expect(
        installGitSource(newJob(), { libraryDir: tree.path('library'), allowFileProtocol: true }, `file://${tree.path('remote')}`),
      ).rejects.toMatchObject({ code: 'SKILL_SOURCE_INVALID' })
      expect(existsSync(tree.path('library', 'remote'))).toBe(false)
    } finally {
      tree.cleanup()
    }
  })
})

describe('removeSourceDirectory', () => {
  it('deletes only the resolved source directory', () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'source'), skillFields('source'))
      removeSourceDirectory(tree.path('library', 'source'))
      expect(() => readFileSync(tree.path('library', 'source', 'SKILL.md'))).toThrow()
    } finally {
      tree.cleanup()
    }
  })
})
