/**
 * The per-ticket git worktree (spec §8): preparation runs through the
 * harness subprocess — never a shell script, no tmux, no POSIX-only paths —
 * and both the directory and the branch trace back to the ticket. Reuse is
 * deterministic: a re-dispatched ticket finds its worktree still registered.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorktreeInspectionView } from './wire-types.ts'

/** The settled facts of one git command. */
export interface GitRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run one command via `git` / CLI to completion through the subprocess seam.
 * The argv is never shell-interpreted, so every path argument travels as a
 * literal and Windows backslashes are safe.
 */
export async function runGit(subprocess: SubprocessRuntime, executable: string, args: readonly string[], cwd: string): Promise<GitRunResult> {
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1_000_000 },
      stderr: { maxBytes: 100_000 },
    },
    graceMs: 5_000,
    signal: AbortSignal.timeout(30_000),
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  // A signal-terminated run has no exit code; treat it as a failure code.
  return { exitCode: outcome.exitCode ?? -1, stdout: stdout.text, stderr }
}

/** Options overriding default ticket-derived worktree directory and branch naming. */
export interface WorktreeTargetOptions {
  readonly branch?: string | undefined
  readonly baseBranch?: string | undefined
  readonly path?: string | undefined
}

/** Normalize a git branch name into a safe single directory segment under `.dsh-worktrees/`. */
function safeWorktreeDirSegment(raw: string): string {
  const cleaned = raw.trim().replaceAll(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'worktree' : cleaned
}

/** The worktree directory of one ticket, under the mapped repo's root. */
export function worktreePathFor(repoRoot: string, ticketId: string, options?: { readonly branch?: string | undefined; readonly path?: string | undefined }): string {
  if (options?.path !== undefined && options.path.trim() !== '') return resolve(repoRoot, options.path.trim())
  const segment = options?.branch !== undefined && options.branch.trim() !== ''
    ? safeWorktreeDirSegment(options.branch)
    : ticketId
  return join(repoRoot, '.dsh-worktrees', segment)
}

/** The worktree branch of one ticket. */
export function worktreeBranchFor(ticketId: string, branchOverride?: string | undefined): string {
  if (branchOverride !== undefined && branchOverride.trim() !== '') return branchOverride.trim()
  return `dsh-manager/${ticketId}`
}

/**
 * Keep `.dsh-worktrees/` ignored in local `.git/info/exclude` so linked
 * worktrees never pollute `git status` in the main checkout and `workspace-changes`
 * captures file-tool edits inside them cleanly.
 */
async function ensureWorktreeExclude(subprocess: SubprocessRuntime, git: string, repoRoot: string): Promise<void> {
  const pathRes = await runGit(subprocess, git, ['rev-parse', '--git-path', 'info/exclude'], repoRoot)
  if (pathRes.exitCode !== 0) return
  const rel = pathRes.stdout.trim()
  if (rel === '') return
  const excludeFile = resolve(repoRoot, rel)
  const existing = await readFile(excludeFile, 'utf8').catch(() => '')
  if (existing.split(/\r?\n/).some(line => line.trim() === '.dsh-worktrees' || line.trim() === '.dsh-worktrees/')) return
  await mkdir(dirname(excludeFile), { recursive: true })
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await writeFile(excludeFile, `${existing}${prefix}.dsh-worktrees/\n`, 'utf8').catch(() => {})
}

/**
 * Resolve (create or reuse) the per-ticket worktree of a mapped project.
 * @param subprocess - the harness subprocess runtime running git.
 * @param repoRoot - the mapped workspace's repository root.
 * @param ticketId - the ticket the worktree belongs to.
 * @returns the worktree's absolute path.
 */
export async function ensureTicketWorktree(
  subprocess: SubprocessRuntime,
  repoRoot: string,
  ticketId: string,
  options?: WorktreeTargetOptions,
): Promise<string> {
  const git = await subprocess.resolveExecutable('git')
  await ensureWorktreeExclude(subprocess, git, repoRoot)
  const branch = worktreeBranchFor(ticketId, options?.branch)
  const worktreePath = worktreePathFor(repoRoot, ticketId, { branch: options?.branch, path: options?.path })
  if (existsSync(worktreePath)) {
    const probe = await runGit(subprocess, git, ['rev-parse', '--is-inside-work-tree'], worktreePath)
    if (probe.exitCode === 0 && probe.stdout.trim() === 'true') return worktreePath
    // A stale directory without git metadata cannot serve; rebuild it.
    await rm(worktreePath, { recursive: true, force: true })
  }
  await mkdir(dirname(worktreePath), { recursive: true })
  const baseCandidate = options?.baseBranch?.trim()
  let startPoint: string | undefined
  if (baseCandidate !== undefined && baseCandidate !== '') {
    const checkBase = await runGit(subprocess, git, ['rev-parse', '--verify', '--quiet', baseCandidate], repoRoot)
    if (checkBase.exitCode === 0) startPoint = baseCandidate
  }
  const addArgs = startPoint === undefined
    ? ['worktree', 'add', worktreePath, '-b', branch]
    : ['worktree', 'add', worktreePath, '-b', branch, startPoint]
  const created = await runGit(subprocess, git, addArgs, repoRoot)
  // A branch left behind by a pruned worktree is reused, not recreated.
  const settled = created.exitCode === 0
    ? created
    : await runGit(subprocess, git, ['worktree', 'add', worktreePath, branch], repoRoot)
  if (settled.exitCode !== 0) {
    throw new Error(`the worktree for ticket ${ticketId} failed to prepare: ${settled.stderr.trim()}`)
  }
  return worktreePath
}

const MAX_DIFF_CHARS = 16_000

/**
 * Inspect the per-ticket git worktree (`git status --porcelain`, `--stat`, and
 * unified diff against `HEAD`). Missing or invalid directories read cleanly as
 * `exists: false`.
 */
export async function inspectTicketWorktree(
  subprocess: SubprocessRuntime,
  repoRoot: string,
  ticketId: string,
  options?: { readonly branch?: string | undefined; readonly path?: string | undefined },
): Promise<WorktreeInspectionView> {
  const worktreePath = worktreePathFor(repoRoot, ticketId, options)
  const branch = worktreeBranchFor(ticketId, options?.branch)
  const empty: WorktreeInspectionView = {
    exists: false,
    path: worktreePath,
    branch,
    dirtyFiles: [],
    stat: '',
    diff: '',
    truncated: false,
  }
  if (!existsSync(worktreePath)) return empty
  const git = await subprocess.resolveExecutable('git')
  const probe = await runGit(subprocess, git, ['rev-parse', '--is-inside-work-tree'], worktreePath)
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') return empty

  const [statusRes, statRes, diffRes] = await Promise.all([
    runGit(subprocess, git, ['status', '--porcelain'], worktreePath),
    runGit(subprocess, git, ['diff', '--stat', 'HEAD'], worktreePath),
    runGit(subprocess, git, ['diff', '--no-color', 'HEAD'], worktreePath),
  ])
  const dirtyFiles = statusRes.exitCode === 0
    ? statusRes.stdout.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '').slice(0, 80)
    : []
  const rawDiff = diffRes.exitCode === 0 ? diffRes.stdout : ''
  const truncated = rawDiff.length > MAX_DIFF_CHARS
  return {
    exists: true,
    path: worktreePath,
    branch,
    dirtyFiles,
    stat: statRes.exitCode === 0 ? statRes.stdout.trimEnd() : '',
    diff: truncated ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n... [truncated]` : rawDiff,
    truncated,
  }
}

/**
 * Remove one ticket's git worktree from disk and prune its git metadata.
 * Safe when the directory is already gone.
 */
export async function removeTicketWorktree(
  subprocess: SubprocessRuntime,
  repoRoot: string,
  ticketId: string,
  options?: { readonly branch?: string | undefined; readonly path?: string | undefined },
): Promise<{ readonly removed: boolean }> {
  const worktreePath = worktreePathFor(repoRoot, ticketId, options)
  const existed = existsSync(worktreePath)
  const git = await subprocess.resolveExecutable('git')
  if (existed) {
    const removed = await runGit(subprocess, git, ['worktree', 'remove', '--force', worktreePath], repoRoot)
    if (removed.exitCode !== 0 && existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true })
    }
  }
  await runGit(subprocess, git, ['worktree', 'prune'], repoRoot)
  return { removed: existed }
}
