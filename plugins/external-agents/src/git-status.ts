/**
 * Lightweight read-only Git and worktree inspection for the active session cwd.
 * Detects linked worktrees created externally (e.g. by skills or CLI agents).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceGitStatus, WorkspaceWorktreeEntry } from './types.ts'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 3_000
const GIT_MAX_BYTES = 128_000

const GIT_SAFE_PREFIX_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'gc.auto=0',
] as const

async function runGit(
  cwd: string,
  args: readonly string[],
  subprocess?: SubprocessRuntime,
): Promise<{ ok: boolean; stdout: string }> {
  const fullArgs = [...GIT_SAFE_PREFIX_ARGS, ...args]
  if (subprocess !== undefined) {
    try {
      const handle = subprocess.spawn({
        argv: ['git', ...fullArgs],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: GIT_MAX_BYTES }, stderr: { maxBytes: 16_384 } },
        graceMs: 1_000,
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      return { ok: outcome.exitCode === 0, stdout }
    } catch {
      return { ok: false, stdout: '' }
    }
  }
  try {
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BYTES,
      encoding: 'utf8',
    })
    return { ok: true, stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/** Parse `git worktree list --porcelain -z` output into worktree entries. */
export function parseWorktreePorcelainZ(
  raw: string,
  currentRepoRoot: string,
  mainRepoRoot: string | undefined,
): readonly WorkspaceWorktreeEntry[] {
  const tokens = raw.split('\0')
  const entries: WorkspaceWorktreeEntry[] = []
  let currentPath: string | undefined
  let head: string | undefined
  let branch: string | undefined
  let bare = false

  const flush = (): void => {
    if (currentPath === undefined) return
    const resolved = resolve(currentPath)
    if (!bare) {
      const isCurrent = resolved === resolve(currentRepoRoot)
      const isMain = mainRepoRoot !== undefined
        ? resolved === resolve(mainRepoRoot)
        : entries.length === 0
      entries.push({
        path: resolved,
        ...(branch === undefined ? {} : { branch }),
        ...(head === undefined ? {} : { head }),
        isCurrent,
        isMain,
      })
    }
    currentPath = undefined
    head = undefined
    branch = undefined
    bare = false
  }

  for (const token of tokens) {
    if (token === '') {
      flush()
      continue
    }
    if (token.startsWith('worktree ')) {
      flush()
      currentPath = token.slice('worktree '.length)
    } else if (token.startsWith('HEAD ')) {
      head = token.slice('HEAD '.length).slice(0, 8)
    } else if (token.startsWith('branch ')) {
      const ref = token.slice('branch '.length)
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (token === 'bare') {
      bare = true
    }
  }
  flush()
  return entries
}

/** Count changed/untracked paths from `git status --porcelain -z`. */
export function countPorcelainZEntries(raw: string): number {
  if (raw === '') return 0
  const tokens = raw.split('\0')
  let count = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token === '') continue
    count += 1
    // Rename/copy records emit an extra NUL-separated source path right after the entry.
    const status = token.slice(0, 2)
    if (status.includes('R') || status.includes('C')) {
      i += 1
    }
  }
  return count
}

/** Inspect Git repository, linked worktree posture, and dirty file count for `cwd`. */
export async function inspectWorkspaceGitStatus(
  cwd: string,
  subprocess?: SubprocessRuntime,
): Promise<WorkspaceGitStatus> {
  if (cwd.trim() === '' || !existsSync(cwd)) {
    return { cwd, isGitRepo: false, isWorktree: false, dirtyCount: 0, worktrees: [] }
  }

  const rev = await runGit(
    cwd,
    ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD', '--short', 'HEAD'],
    subprocess,
  )
  if (!rev.ok) {
    return { cwd, isGitRepo: false, isWorktree: false, dirtyCount: 0, worktrees: [] }
  }
  const lines = rev.stdout.trim().split(/\r?\n/u)
  const topLevel = lines[0]?.trim()
  const rawGitDir = lines[1]?.trim()
  const rawCommonDir = lines[2]?.trim()
  const rawBranch = lines[3]?.trim()
  const shortHead = lines[4]?.trim()
  if (topLevel === undefined || topLevel === '' || rawGitDir === undefined || rawCommonDir === undefined) {
    return { cwd, isGitRepo: false, isWorktree: false, dirtyCount: 0, worktrees: [] }
  }

  const resolvedTop = resolve(topLevel)
  const resolvedGitDir = resolve(cwd, rawGitDir)
  const resolvedCommonDir = resolve(cwd, rawCommonDir)
  const isWorktree = resolvedGitDir !== resolvedCommonDir
  const mainRepoRoot = basename(resolvedCommonDir) === '.git'
    ? dirname(resolvedCommonDir)
    : resolvedTop
  const branch = rawBranch !== undefined && rawBranch !== '' && rawBranch !== 'HEAD' ? rawBranch : undefined

  const [worktreeRes, statusRes] = await Promise.all([
    runGit(resolvedTop, ['worktree', 'list', '--porcelain', '-z'], subprocess),
    runGit(resolvedTop, ['status', '--porcelain', '-z'], subprocess),
  ])

  const worktrees = worktreeRes.ok
    ? parseWorktreePorcelainZ(worktreeRes.stdout, resolvedTop, mainRepoRoot)
    : []
  const dirtyCount = statusRes.ok ? countPorcelainZEntries(statusRes.stdout) : 0

  return {
    cwd,
    isGitRepo: true,
    ...(branch === undefined ? {} : { branch }),
    ...(shortHead === undefined || shortHead === '' ? {} : { shortHead }),
    isWorktree,
    repoRoot: resolvedTop,
    mainRepoRoot,
    dirtyCount,
    worktrees,
  }
}
