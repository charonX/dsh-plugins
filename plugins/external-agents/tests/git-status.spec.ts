import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectWorkspaceGitStatus } from '../src/git-status.ts'

describe('inspectWorkspaceGitStatus', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes main checkout and externally created git worktrees plus dirty count', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ext-git-status-')))
    dirs.push(root)
    const mainDir = join(root, 'repo')
    const worktreeDir = join(root, 'wt-feature')

    execFileSync('git', ['init', '-b', 'main', mainDir])
    execFileSync('git', ['-C', mainDir, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', mainDir, 'config', 'user.name', 'Test User'])
    writeFileSync(join(mainDir, 'README.md'), 'hello\n', 'utf8')
    execFileSync('git', ['-C', mainDir, 'add', 'README.md'])
    execFileSync('git', ['-C', mainDir, 'commit', '-m', 'init'])
    execFileSync('git', ['-C', mainDir, 'worktree', 'add', '-b', 'feat/worktree-ui', worktreeDir])

    const mainStatus = await inspectWorkspaceGitStatus(mainDir)
    expect(mainStatus.isGitRepo).toBe(true)
    expect(mainStatus.isWorktree).toBe(false)
    expect(mainStatus.branch).toBe('main')
    expect(mainStatus.dirtyCount).toBe(0)
    expect(mainStatus.worktrees).toHaveLength(2)
    expect(mainStatus.worktrees.find(wt => wt.isCurrent)?.path).toBe(mainDir)

    writeFileSync(join(worktreeDir, 'draft.txt'), 'dirty\n', 'utf8')
    const wtStatus = await inspectWorkspaceGitStatus(worktreeDir)
    expect(wtStatus.isGitRepo).toBe(true)
    expect(wtStatus.isWorktree).toBe(true)
    expect(wtStatus.branch).toBe('feat/worktree-ui')
    expect(wtStatus.mainRepoRoot).toBe(mainDir)
    expect(wtStatus.dirtyCount).toBe(1)
    expect(wtStatus.worktrees.find(wt => wt.isCurrent)?.path).toBe(worktreeDir)

    const nonGit = await inspectWorkspaceGitStatus(tmpdir())
    expect(nonGit.isGitRepo).toBe(false)
    expect(nonGit.worktrees).toEqual([])
  })
})
