import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillManagerError } from '../src/errors.ts'
import { installGitSource, installLocalSource, updateGitSource } from '../src/installer.ts'
import type { JobRecord } from '../src/jobs.ts'
import { readSourceVersion } from '../src/library.ts'
import { UpdateStore, checkGitSource } from '../src/updates.ts'
import { skillFields, tempTree, writeSkill, type TempTree } from './helpers.ts'

const silentLogger = { warn: () => {} }
const trees: TempTree[] = []

afterEach(() => {
  for (const tree of trees.splice(0)) tree.cleanup()
})

function newJob(): JobRecord {
  return { id: 'job', status: 'pending', error: null, log: null }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', message])
}

async function setup(): Promise<{ tree: TempTree; remote: string; clone: string; libraryDir: string }> {
  const tree = tempTree()
  trees.push(tree)
  const remote = tree.path('remote')
  mkdirSync(remote, { recursive: true })
  git(remote, ['init', '-b', 'main'])
  writeSkill(`${remote}/skills/alpha`, skillFields('alpha'))
  commitAll(remote, 'first')
  git(remote, ['tag', 'v1.0.0'])
  const libraryDir = tree.path('library')
  const slug = await installGitSource(newJob(), { libraryDir, allowFileProtocol: true }, `file://${remote}`)
  return { tree, remote, clone: `${libraryDir}/${slug}`, libraryDir }
}

describe('readSourceVersion', () => {
  it('prefers package.json, then a git tag, then the short hash', async () => {
    const { clone } = await setup()
    expect(readSourceVersion(clone, true)).toBe('v1.0.0')
    writeFileSync(`${clone}/package.json`, JSON.stringify({ version: '2.3.4' }))
    expect(readSourceVersion(clone, true)).toBe('2.3.4')
  })
})

describe('checkGitSource', () => {
  it('reports an up-to-date clone, then commits behind after the remote moves', async () => {
    const { tree, remote, clone } = await setup()
    const clean = await checkGitSource(clone, { allowFileProtocol: true })
    expect(clean.error).toBeUndefined()
    expect(clean.behind).toBe(0)
    expect(clean.dirty).toBe(false)
    expect(clean.remoteVersion).toContain('v1.0.0')
    expect(clean.localCommit).toBe(clean.remoteCommit)

    writeSkill(`${remote}/skills/beta`, skillFields('beta'))
    commitAll(remote, 'second')
    const behind = await checkGitSource(clone, { allowFileProtocol: true })
    expect(behind.behind).toBe(1)
    expect(behind.localCommit).not.toBe(behind.remoteCommit)

    await updateGitSource(newJob(), { libraryDir: tree.path('library'), allowFileProtocol: true }, clone)
    const refreshed = await checkGitSource(clone, { allowFileProtocol: true })
    expect(refreshed.behind).toBe(0)
  })

  it('flags uncommitted working-tree changes', async () => {
    const { clone } = await setup()
    writeSkill(`${clone}/skills/alpha`, skillFields('alpha', 'edited in place'))
    const check = await checkGitSource(clone, { allowFileProtocol: true })
    expect(check.dirty).toBe(true)
  })

  it('rejects local sources and unreadable remotes', async () => {
    const tree = tempTree()
    trees.push(tree)
    writeSkill(tree.path('local'), skillFields('local'))
    await installLocalSource(newJob(), { libraryDir: tree.path('library'), allowFileProtocol: true }, tree.path('local'), false)
    await expect(
      checkGitSource(tree.path('library', 'local'), { allowFileProtocol: true }),
    ).rejects.toBeInstanceOf(SkillManagerError)

    const { clone } = await setup()
    await expect(checkGitSource(clone, { allowFileProtocol: false })).rejects.toMatchObject({
      code: 'SKILL_SOURCE_INVALID',
    })
  })

  it('records a fetch failure instead of throwing', async () => {
    const { clone } = await setup()
    git(clone, ['remote', 'set-url', 'origin', 'https://127.0.0.1:1/does-not-exist.git'])
    const check = await checkGitSource(clone, { allowFileProtocol: true })
    expect(check.error?.code).toBe('SKILL_CHECK_FAILED')
    expect(check.behind).toBeUndefined()
  })
})

describe('UpdateStore', () => {
  it('persists, updates, and drops checks', () => {
    const tree = tempTree()
    trees.push(tree)
    const store = new UpdateStore(tree.path('updates.json'), silentLogger)
    expect(store.read()).toEqual({})
    store.set('a', { checkedAt: '2026-01-01T00:00:00.000Z', behind: 2 })
    expect(store.read()).toEqual({ a: { checkedAt: '2026-01-01T00:00:00.000Z', behind: 2 } })
    store.set('b', { checkedAt: '2026-01-02T00:00:00.000Z', behind: 0 })
    store.drop('a')
    expect(Object.keys(store.read())).toEqual(['b'])
    writeFileSync(tree.path('updates.json'), '{ broken')
    expect(store.read()).toEqual({})
  })
})
