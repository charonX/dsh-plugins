/**
 * Deterministic git landing primitives and per-project serialization lock:
 * - Serializes rebase / merge / push operations per repository (`projectId` or `repoRoot`)
 *   so parallel Executor dispatches never race against each other.
 * - Keeps worktrees healthy by immediately aborting failed rebases/merges and
 *   reporting exact conflicted file paths so the Executor can rework safely.
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { removeTicketWorktree, runGit } from './worktree.ts'

const projectLocks = new Map<string, Promise<void>>()

/**
 * Run `fn` exclusively per `projectKey` within this host process so parallel
 * ticket pipelines never rebase, merge, or push the same repo concurrently.
 */
export async function withProjectLandingLock<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
  const key = projectKey.trim() || 'default'
  const previous = projectLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const chained = previous.then(() => gate, () => gate)
  projectLocks.set(key, chained)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (projectLocks.get(key) === chained) {
      projectLocks.delete(key)
    }
  }
}

/** Snapshot of how the current branch compares to a landing target branch. */
export interface RebaseStatusResult {
  readonly ok: boolean
  readonly currentBranch?: string
  readonly targetBranch: string
  readonly cleanWorkingTree: boolean
  readonly behind: number
  readonly ahead: number
  readonly mergeBase?: string
  readonly rebaseNeeded: boolean
  readonly rebaseWouldConflict?: boolean
  readonly conflictFiles: readonly string[]
  readonly error?: string
}

/**
 * Non-destructive check comparing `HEAD` against `targetBranch`. Uses
 * `git merge-tree --write-tree` (when supported) to detect merge/rebase
 * conflicts without mutating the working tree or index.
 */
export async function checkBranchRebaseStatus(
  subprocess: SubprocessRuntime,
  cwd: string,
  targetBranch: string,
): Promise<RebaseStatusResult> {
  const [branchRes, statusRes, verifyTarget] = await Promise.all([
    runGit(subprocess, 'git', ['symbolic-ref', '--short', 'HEAD'], cwd),
    runGit(subprocess, 'git', ['status', '--porcelain'], cwd),
    runGit(subprocess, 'git', ['rev-parse', '--verify', '--quiet', targetBranch], cwd),
  ])
  const currentBranch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : undefined
  const cleanWorkingTree = statusRes.exitCode === 0 && statusRes.stdout.trim() === ''
  if (verifyTarget.exitCode !== 0) {
    return {
      ok: false,
      ...(currentBranch === undefined ? {} : { currentBranch }),
      targetBranch,
      cleanWorkingTree,
      behind: 0,
      ahead: 0,
      rebaseNeeded: false,
      conflictFiles: [],
      error: `target branch "${targetBranch}" not found`,
    }
  }

  const [mergeBaseRes, revListRes, mergeTreeRes] = await Promise.all([
    runGit(subprocess, 'git', ['merge-base', 'HEAD', targetBranch], cwd),
    runGit(subprocess, 'git', ['rev-list', '--left-right', '--count', `${targetBranch}...HEAD`], cwd),
    runGit(subprocess, 'git', ['merge-tree', '--write-tree', targetBranch, 'HEAD'], cwd),
  ])

  const mergeBase = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.trim() : undefined
  const counts = revListRes.exitCode === 0 ? revListRes.stdout.trim().split(/\s+/) : ['0', '0']
  const behind = Number.parseInt(counts[0] ?? '0', 10) || 0
  const ahead = Number.parseInt(counts[1] ?? '0', 10) || 0

  let rebaseWouldConflict: boolean | undefined
  const conflictFiles: string[] = []
  if (mergeTreeRes.exitCode === 0) {
    rebaseWouldConflict = false
  } else if (mergeTreeRes.exitCode === 1) {
    rebaseWouldConflict = true
    for (const line of `${mergeTreeRes.stdout}\n${mergeTreeRes.stderr}`.split('\n')) {
      const match = /^CONFLICT\s*\([^)]+\):\s*.*?\bin\s+(.+?)\s*$/.exec(line.trim())
      if (match?.[1] !== undefined && !conflictFiles.includes(match[1])) {
        conflictFiles.push(match[1])
      }
    }
  }

  return {
    ok: true,
    ...(currentBranch === undefined ? {} : { currentBranch }),
    targetBranch,
    cleanWorkingTree,
    behind,
    ahead,
    ...(mergeBase === undefined ? {} : { mergeBase }),
    rebaseNeeded: behind > 0,
    ...(rebaseWouldConflict === undefined ? {} : { rebaseWouldConflict }),
    conflictFiles,
  }
}

export interface RebaseResult {
  readonly ok: boolean
  readonly rebased: boolean
  readonly aborted: boolean
  readonly conflictFiles: readonly string[]
  readonly error?: string
}

/**
 * Rebase the worktree branch onto `targetBranch`, immediately running
 * `git rebase --abort` if any conflict occurs so the worktree stays clean.
 */
export async function rebaseBranchOnto(
  subprocess: SubprocessRuntime,
  worktreeCwd: string,
  targetBranch: string,
  lockKey: string = worktreeCwd,
): Promise<RebaseResult> {
  return withProjectLandingLock(lockKey, async () => {
    const statusRes = await runGit(subprocess, 'git', ['status', '--porcelain'], worktreeCwd)
    if (statusRes.exitCode !== 0) {
      return { ok: false, rebased: false, aborted: false, conflictFiles: [], error: statusRes.stderr.trim() || 'git status failed' }
    }
    if (statusRes.stdout.trim() !== '') {
      return {
        ok: false,
        rebased: false,
        aborted: false,
        conflictFiles: [],
        error: 'working tree has uncommitted changes; commit or stash before rebase',
      }
    }
    const rebaseRes = await runGit(subprocess, 'git', ['rebase', targetBranch], worktreeCwd)
    if (rebaseRes.exitCode === 0) {
      return { ok: true, rebased: true, aborted: false, conflictFiles: [] }
    }
    const conflicted = await runGit(subprocess, 'git', ['diff', '--name-only', '--diff-filter=U'], worktreeCwd)
    const conflictFiles = conflicted.stdout.split('\n').map(s => s.trim()).filter(Boolean)
    await runGit(subprocess, 'git', ['rebase', '--abort'], worktreeCwd)
    return {
      ok: false,
      rebased: false,
      aborted: true,
      conflictFiles,
      error: rebaseRes.stderr.trim() || rebaseRes.stdout.trim() || 'git rebase conflicted and was aborted cleanly',
    }
  })
}

export interface LocalMergeInput {
  readonly repoRoot: string
  readonly sourceBranch: string
  readonly targetBranch: string
  /** Optional ticket worktree cwd used to rebase `sourceBranch` cleanly prior to `--ff-only`. */
  readonly worktreeCwd?: string
  readonly strategy?: 'rebase-then-ff' | 'ff-only' | 'merge-commit'
  readonly removeWorktreeOnSuccess?: boolean
  readonly ticketId?: string
  readonly worktreeBranch?: string
  readonly worktreePath?: string
  readonly lockKey?: string
}

export interface LocalMergeResult {
  readonly merged: boolean
  readonly aborted: boolean
  readonly targetBranch: string
  readonly sourceBranch: string
  readonly commitSha?: string
  readonly conflictFiles: readonly string[]
  readonly worktreeRemoved: boolean
  readonly error?: string
}

/**
 * Land `sourceBranch` onto `targetBranch` locally under a per-project lock.
 * Rebases inside `worktreeCwd` first when requested, verifies clean target repo
 * state, merges without leaving dirty conflicts behind, and optionally removes the worktree.
 */
export async function localMergeBranch(
  subprocess: SubprocessRuntime,
  input: LocalMergeInput,
): Promise<LocalMergeResult> {
  const strategy = input.strategy ?? 'rebase-then-ff'
  const lockKey = input.lockKey ?? input.repoRoot

  if (strategy === 'rebase-then-ff' && input.worktreeCwd !== undefined) {
    const rebase = await rebaseBranchOnto(subprocess, input.worktreeCwd, input.targetBranch, lockKey)
    if (!rebase.ok) {
      return {
        merged: false,
        aborted: rebase.aborted,
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        conflictFiles: rebase.conflictFiles,
        worktreeRemoved: false,
        error: rebase.error ?? 'rebase failed',
      }
    }
  }

  return withProjectLandingLock(lockKey, async () => {
    const statusRes = await runGit(subprocess, 'git', ['status', '--porcelain', '--', '.', ':!.dsh-worktrees'], input.repoRoot)
    if (statusRes.exitCode !== 0 || statusRes.stdout.trim() !== '') {
      return {
        merged: false,
        aborted: false,
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        conflictFiles: [],
        worktreeRemoved: false,
        error: statusRes.exitCode !== 0
          ? statusRes.stderr.trim() || 'git status failed in repoRoot'
          : `target repository ${input.repoRoot} has uncommitted changes; aborting local merge`,
      }
    }

    const checkoutRes = await runGit(subprocess, 'git', ['checkout', input.targetBranch], input.repoRoot)
    if (checkoutRes.exitCode !== 0) {
      return {
        merged: false,
        aborted: false,
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        conflictFiles: [],
        worktreeRemoved: false,
        error: checkoutRes.stderr.trim() || `failed to checkout ${input.targetBranch}`,
      }
    }

    const mergeArgs = strategy === 'merge-commit'
      ? ['merge', '--no-ff', '--no-edit', input.sourceBranch]
      : ['merge', '--ff-only', input.sourceBranch]
    const mergeRes = await runGit(subprocess, 'git', mergeArgs, input.repoRoot)
    if (mergeRes.exitCode !== 0) {
      const conflicted = await runGit(subprocess, 'git', ['diff', '--name-only', '--diff-filter=U'], input.repoRoot)
      const conflictFiles = conflicted.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      await runGit(subprocess, 'git', ['merge', '--abort'], input.repoRoot)
      return {
        merged: false,
        aborted: true,
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        conflictFiles,
        worktreeRemoved: false,
        error: mergeRes.stderr.trim() || mergeRes.stdout.trim() || 'git merge failed and was aborted cleanly',
      }
    }

    const shaRes = await runGit(subprocess, 'git', ['rev-parse', 'HEAD'], input.repoRoot)
    const commitSha = shaRes.exitCode === 0 ? shaRes.stdout.trim() : undefined

    let worktreeRemoved = false
    if (input.removeWorktreeOnSuccess === true && input.ticketId !== undefined) {
      try {
        await removeTicketWorktree(subprocess, input.repoRoot, input.ticketId, {
          ...(input.worktreeBranch === undefined ? {} : { branch: input.worktreeBranch }),
          ...(input.worktreePath === undefined ? {} : { path: input.worktreePath }),
        })
        worktreeRemoved = true
      } catch {
        worktreeRemoved = false
      }
    }

    return {
      merged: true,
      aborted: false,
      targetBranch: input.targetBranch,
      sourceBranch: input.sourceBranch,
      ...(commitSha === undefined ? {} : { commitSha }),
      conflictFiles: [],
      worktreeRemoved,
    }
  })
}

export interface PushBranchInput {
  readonly cwd: string
  readonly remote?: string
  readonly branch?: string
  readonly setUpstream?: boolean
  readonly forceWithLease?: boolean
  readonly lockKey?: string
}

export interface PushBranchResult {
  readonly pushed: boolean
  readonly remote: string
  readonly branch: string
  readonly output: string
  readonly error?: string
}

/** Push a branch to a remote under the per-project lock (never uses raw `--force`). */
export async function pushBranch(subprocess: SubprocessRuntime, input: PushBranchInput): Promise<PushBranchResult> {
  return withProjectLandingLock(input.lockKey ?? input.cwd, async () => {
    const remote = input.remote?.trim() || 'origin'
    let branch = input.branch?.trim()
    if (!branch) {
      const branchRes = await runGit(subprocess, 'git', ['symbolic-ref', '--short', 'HEAD'], input.cwd)
      branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : ''
    }
    if (!branch) {
      return { pushed: false, remote, branch: '', output: '', error: 'cannot resolve current branch name for push' }
    }
    const args = ['push']
    if (input.setUpstream !== false) args.push('-u')
    if (input.forceWithLease === true) args.push('--force-with-lease')
    args.push(remote, branch)
    const res = await runGit(subprocess, 'git', args, input.cwd)
    const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n')
    if (res.exitCode !== 0) {
      return { pushed: false, remote, branch, output, error: output || `git push exited with ${res.exitCode}` }
    }
    return { pushed: true, remote, branch, output }
  })
}

export interface CreateMrOrPrInput {
  readonly cwd: string
  readonly forge?: 'github' | 'gitlab' | 'auto'
  readonly title: string
  readonly body: string
  readonly baseBranch?: string
  readonly headBranch?: string
  readonly draft?: boolean
}

export interface CreateMrOrPrResult {
  readonly created: boolean
  readonly forge: 'github' | 'gitlab' | 'unknown'
  readonly command: string
  readonly url?: string
  readonly output: string
  readonly error?: string
}

/** Create a GitHub PR (`gh`) or GitLab MR (`glab`) via the subprocess seam. */
export async function createMrOrPr(subprocess: SubprocessRuntime, input: CreateMrOrPrInput): Promise<CreateMrOrPrResult> {
  let forge: 'github' | 'gitlab' | 'unknown' = input.forge === undefined || input.forge === 'auto' ? 'unknown' : input.forge
  if (forge === 'unknown') {
    const remoteRes = await runGit(subprocess, 'git', ['remote', 'get-url', 'origin'], input.cwd)
    const remoteUrl = remoteRes.exitCode === 0 ? remoteRes.stdout.toLowerCase() : ''
    if (remoteUrl.includes('github')) forge = 'github'
    else if (remoteUrl.includes('gitlab')) forge = 'gitlab'
  }
  if (forge === 'unknown') {
    return {
      created: false,
      forge,
      command: '',
      output: '',
      error: 'unable to infer forge from origin remote; specify forge: "github" or "gitlab"',
    }
  }

  if (forge === 'github') {
    const args = ['pr', 'create', '--title', input.title, '--body', input.body]
    if (input.baseBranch !== undefined && input.baseBranch !== '') args.push('--base', input.baseBranch)
    if (input.headBranch !== undefined && input.headBranch !== '') args.push('--head', input.headBranch)
    if (input.draft === true) args.push('--draft')
    const res = await runGit(subprocess, 'gh', args, input.cwd)
    const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n')
    const url = output.match(/https?:\/\/\S+/)?.[0]
    return {
      created: res.exitCode === 0,
      forge,
      command: `gh ${args.join(' ')}`,
      ...(url === undefined ? {} : { url }),
      output,
      ...(res.exitCode === 0 ? {} : { error: output || `gh exited with ${res.exitCode}` }),
    }
  }

  const args = ['mr', 'create', '--yes', '--title', input.title, '--description', input.body]
  if (input.baseBranch !== undefined && input.baseBranch !== '') args.push('--target-branch', input.baseBranch)
  if (input.headBranch !== undefined && input.headBranch !== '') args.push('--source-branch', input.headBranch)
  if (input.draft === true) args.push('--draft')
  const res = await runGit(subprocess, 'glab', args, input.cwd)
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n')
  const url = output.match(/https?:\/\/\S+/)?.[0]
  return {
    created: res.exitCode === 0,
    forge,
    command: `glab ${args.join(' ')}`,
    ...(url === undefined ? {} : { url }),
    output,
    ...(res.exitCode === 0 ? {} : { error: output || `glab exited with ${res.exitCode}` }),
  }
}
