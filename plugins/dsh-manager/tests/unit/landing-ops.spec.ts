/**
 * Real-git integration & unit tests for Slice 3 & Slice 4:
 * - Dynamic repository discovery (`AGENTS.md`, project-local PR skills, remotes, branches, safe fallback).
 * - Non-destructive `checkBranchRebaseStatus` + per-project `withProjectLandingLock`.
 * - `localMergeBranch` (rebase-then-ff success + worktree cleanup, and clean abort on conflict).
 * - `pushBranch` against a real bare git remote and `createMrOrPr` via fake `gh`/`glab` CLI shims.
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, describe, expect, test } from 'vitest'
import { discoverProjectLandingFacts, formatLandingDiscoveryPromptLines } from '../../src/dispatch/landing-discovery.ts'
import { checkBranchRebaseStatus, createMrOrPr, localMergeBranch, pushBranch, withProjectLandingLock } from '../../src/dispatch/landing-ops.ts'
import { ensureTicketWorktree, worktreeBranchFor } from '../../src/dispatch/worktree.ts'

const tempDirs: string[] = []

function createNodeSubprocess(extraPath?: string): SubprocessRuntime {
  return {
    resolveExecutable: async (command: string) => command,
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...spec.env,
          ...(extraPath === undefined ? {} : { PATH: `${extraPath}:${process.env.PATH ?? ''}` }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const outChunks: Buffer[] = []
      const errChunks: Buffer[] = []
      child.stdout?.on('data', c => outChunks.push(c as Buffer))
      child.stderr?.on('data', c => errChunks.push(c as Buffer))

      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })

      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: {
            readFrom: (offset: number) => {
              const text = Buffer.concat(outChunks).toString('utf8').slice(offset)
              return { text, nextOffset: offset + text.length, lossy: false }
            },
          },
          stderr: {
            readFrom: (offset: number) => {
              const text = Buffer.concat(errChunks).toString('utf8').slice(offset)
              return { text, nextOffset: offset + text.length, lossy: false }
            },
          },
        },
        done,
        terminate: () => child.kill(),
        waitForExit: async () => {
          await done.catch(() => {})
          return true
        },
      }
    },
  } as unknown as SubprocessRuntime
}

async function git(subprocess: SubprocessRuntime, cwd: string, ...args: string[]): Promise<string> {
  const handle = subprocess.spawn({
    argv: ['git', ...args],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000_000 }, stderr: { maxBytes: 100_000 } },
    graceMs: 5_000,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  const res = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${String(res.exitCode)}): ${stderr || stdout}`)
  }
  return stdout.trim()
}

async function createSeededRepo(prefix: string): Promise<{ subprocess: SubprocessRuntime; repoDir: string }> {
  const subprocess = createNodeSubprocess()
  const repoDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(repoDir)
  await git(subprocess, repoDir, 'init', '-b', 'main')
  await git(subprocess, repoDir, 'config', 'user.email', 'test@example.com')
  await git(subprocess, repoDir, 'config', 'user.name', 'Test User')
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf8')
  await git(subprocess, repoDir, 'add', '.')
  await git(subprocess, repoDir, 'commit', '-m', 'init')
  return { subprocess, repoDir }
}

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

describe('adaptive landing discovery & git landing ops', () => {
  test('discovers AGENTS.md, project-local PR skills, forge type, and safe manual fallback', async () => {
    const { subprocess, repoDir } = await createSeededRepo('dsh-land-disc-')

    // Without AGENTS.md, skills, or remotes -> safe manual fallback.
    const bareFacts = await discoverProjectLandingFacts(subprocess, repoDir)
    expect(bareFacts.hasExplicitLandingPolicy).toBe(false)
    expect(bareFacts.recommendedFallback).toBe('manual')
    expect(bareFacts.forge).toBe('none')
    expect(bareFacts.existingBaseBranches).toEqual(['main'])

    // Add repo AGENTS.md + project-local PR skill + GitHub origin remote.
    await writeFile(join(repoDir, 'AGENTS.md'), '# Repo Guide\nLanding: Open a Pull Request on GitHub via project /release-pr skill.\n', 'utf8')
    await mkdir(join(repoDir, '.agents/skills/release-pr'), { recursive: true })
    await writeFile(
      join(repoDir, '.agents/skills/release-pr/SKILL.md'),
      '---\nname: release-pr\ndescription: Custom PR checklist and template for this repo\n---\nInstructions\n',
      'utf8',
    )
    await git(subprocess, repoDir, 'remote', 'add', 'origin', 'git@github.com:org/app.git')

    const richFacts = await discoverProjectLandingFacts(subprocess, repoDir)
    expect(richFacts.hasExplicitLandingPolicy).toBe(true)
    expect(richFacts.forge).toBe('github')
    expect(richFacts.recommendedFallback).toBe('remote-pr')
    expect(richFacts.deliverySkills.some(s => s.name === 'release-pr')).toBe(true)
    const promptText = formatLandingDiscoveryPromptLines(richFacts).join('\n')
    expect(promptText).toContain('/release-pr')
    expect(promptText).toContain('Open a Pull Request on GitHub')
  })

  test('checks rebase readiness, aborts conflicts cleanly, and lands via localMergeBranch + cleanup', async () => {
    const { subprocess, repoDir } = await createSeededRepo('dsh-land-merge-')

    // Clean ticket worktree #1 that commits a new non-conflicting file.
    const wt1 = await ensureTicketWorktree(subprocess, repoDir, 'ticket-1')
    await writeFile(join(wt1, 'feature.txt'), 'feat-1\n', 'utf8')
    await git(subprocess, wt1, 'add', 'feature.txt')
    await git(subprocess, wt1, 'commit', '-m', 'add feature 1')

    // Ticket worktree #2 modifies shared.txt -> main also modifies shared.txt to simulate drift/conflict.
    const wt2 = await ensureTicketWorktree(subprocess, repoDir, 'ticket-2')
    await writeFile(join(wt2, 'shared.txt'), 'from ticket 2\n', 'utf8')
    await git(subprocess, wt2, 'add', 'shared.txt')
    await git(subprocess, wt2, 'commit', '-m', 'wt2 shared')

    // Advance main with shared.txt conflict.
    await writeFile(join(repoDir, 'shared.txt'), 'from main\n', 'utf8')
    await git(subprocess, repoDir, 'add', 'shared.txt')
    await git(subprocess, repoDir, 'commit', '-m', 'main shared')

    // Ticket #1 rebases and merges cleanly onto updated main, and removes its worktree.
    const probe1 = await checkBranchRebaseStatus(subprocess, wt1, 'main')
    expect(probe1.ok).toBe(true)
    expect(probe1.behind).toBe(1)
    expect(probe1.ahead).toBe(1)
    expect(probe1.rebaseNeeded).toBe(true)
    expect(probe1.rebaseWouldConflict).toBe(false)

    const merged1 = await localMergeBranch(subprocess, {
      repoRoot: repoDir,
      sourceBranch: worktreeBranchFor('ticket-1'),
      targetBranch: 'main',
      worktreeCwd: wt1,
      strategy: 'rebase-then-ff',
      removeWorktreeOnSuccess: true,
      ticketId: 'ticket-1',
    })
    expect(merged1.merged).toBe(true)
    expect(merged1.aborted).toBe(false)
    expect(merged1.worktreeRemoved).toBe(true)
    expect(await readFile(join(repoDir, 'feature.txt'), 'utf8')).toBe('feat-1\n')

    // Ticket #2 conflicts with main -> non-destructive check detects it AND localMergeBranch aborts cleanly.
    const probe2 = await checkBranchRebaseStatus(subprocess, wt2, 'main')
    expect(probe2.ok).toBe(true)
    expect(probe2.rebaseWouldConflict).toBe(true)
    expect(probe2.conflictFiles).toContain('shared.txt')

    const merged2 = await localMergeBranch(subprocess, {
      repoRoot: repoDir,
      sourceBranch: worktreeBranchFor('ticket-2'),
      targetBranch: 'main',
      worktreeCwd: wt2,
      strategy: 'rebase-then-ff',
    })
    expect(merged2.merged).toBe(false)
    expect(merged2.aborted).toBe(true)
    expect(merged2.conflictFiles).toContain('shared.txt')
    // Worktree must NOT be left in a half-rebased dirty state.
    expect(await git(subprocess, wt2, 'status', '--porcelain')).toBe('')
  })

  test('serializes per-project lock, pushes branch to real bare remote, and invokes gh/glab CLIs cleanly', async () => {
    const events: string[] = []
    await Promise.all([
      withProjectLandingLock('proj-lock', async () => {
        events.push('1-start')
        await new Promise(resolve => { setTimeout(resolve, 25) })
        events.push('1-end')
      }),
      withProjectLandingLock('proj-lock', async () => {
        events.push('2-start')
        events.push('2-end')
      }),
    ])
    expect(events).toEqual(['1-start', '1-end', '2-start', '2-end'])

    // Real bare remote push test + temp PATH CLI shims for gh/glab.
    const binDir = await mkdtemp(join(tmpdir(), 'dsh-fake-cli-'))
    const bareDir = await mkdtemp(join(tmpdir(), 'dsh-bare-remote-'))
    tempDirs.push(binDir, bareDir)
    const { repoDir } = await createSeededRepo('dsh-land-push-')
    const subprocess = createNodeSubprocess(binDir)
    await git(subprocess, bareDir, 'init', '--bare')
    await git(subprocess, repoDir, 'remote', 'add', 'origin', bareDir)

    const wt = await ensureTicketWorktree(subprocess, repoDir, 'ticket-push')
    await writeFile(join(wt, 'pushed.txt'), 'ok\n', 'utf8')
    await git(subprocess, wt, 'add', 'pushed.txt')
    await git(subprocess, wt, 'commit', '-m', 'push commit')

    const pushed = await pushBranch(subprocess, { cwd: wt })
    expect(pushed.pushed).toBe(true)
    expect(pushed.branch).toBe(worktreeBranchFor('ticket-push'))
    const remoteBranches = await git(subprocess, bareDir, 'branch')
    expect(remoteBranches).toContain(worktreeBranchFor('ticket-push'))

    // Fake `gh` and `glab` scripts verify invocation args & URL capture.
    const ghPath = join(binDir, 'gh')
    const glabPath = join(binDir, 'glab')
    await writeFile(ghPath, '#!/bin/sh\necho "https://github.com/org/repo/pull/99"\n', 'utf8')
    await writeFile(glabPath, '#!/bin/sh\necho "https://gitlab.example.com/org/repo/-/merge_requests/12"\n', 'utf8')
    await chmod(ghPath, 0o755)
    await chmod(glabPath, 0o755)

    const prRes = await createMrOrPr(subprocess, {
      cwd: wt,
      forge: 'github',
      title: 'feat: add landing',
      body: 'Summary + evidence',
      baseBranch: 'main',
    })
    expect(prRes.created).toBe(true)
    expect(prRes.url).toBe('https://github.com/org/repo/pull/99')

    const mrRes = await createMrOrPr(subprocess, {
      cwd: wt,
      forge: 'gitlab',
      title: 'fix: crash',
      body: 'Before Red -> After Green',
      baseBranch: 'main',
    })
    expect(mrRes.created).toBe(true)
    expect(mrRes.url).toBe('https://gitlab.example.com/org/repo/-/merge_requests/12')
  })

  test('ensureTicketWorktree cuts feat-* from main and localMergeBranch merges into test without touching main', async () => {
    const { subprocess, repoDir } = await createSeededRepo('dsh-land-feat-test-')
    const mainBranch = await git(subprocess, repoDir, 'symbolic-ref', '--short', 'HEAD')
    await git(subprocess, repoDir, 'branch', 'test', mainBranch)

    const featBranch = 'feat-dsh-manager-worktree-flow'
    const wt = await ensureTicketWorktree(subprocess, repoDir, 'ticket-feat-1', {
      branch: featBranch,
      baseBranch: mainBranch,
    })
    const checkedBranch = await git(subprocess, wt, 'symbolic-ref', '--short', 'HEAD')
    expect(checkedBranch).toBe(featBranch)

    await writeFile(join(wt, 'feature.txt'), 'feat ok\n', 'utf8')
    await git(subprocess, wt, 'add', 'feature.txt')
    await git(subprocess, wt, 'commit', '-m', 'feat(dsh-manager): add feat branch workflow')

    const merged = await localMergeBranch(subprocess, {
      repoRoot: repoDir,
      sourceBranch: featBranch,
      targetBranch: 'test',
      worktreeCwd: wt,
      removeWorktreeOnSuccess: true,
      ticketId: 'ticket-feat-1',
      worktreeBranch: featBranch,
      worktreePath: wt,
    })
    expect(merged.merged).toBe(true)
    expect(merged.targetBranch).toBe('test')
    expect(merged.worktreeRemoved).toBe(true)

    const testFiles = await git(subprocess, repoDir, 'ls-tree', '--name-only', 'test')
    expect(testFiles).toContain('feature.txt')
    const mainFiles = await git(subprocess, repoDir, 'ls-tree', '--name-only', mainBranch)
    expect(mainFiles).not.toContain('feature.txt')
  })
})
