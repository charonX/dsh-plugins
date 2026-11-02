/**
 * Git update checks for library sources.
 *
 * A check fetches the source's remote, compares the local HEAD with its
 * upstream, and records the result for the Web Client. Results are advisory:
 * updating stays an explicit `git pull --ff-only`.
 *
 * @module dsh-skills-manager/updates
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readGitRemote, type WarnLogger } from './library.js'
import { SkillManagerError } from './errors.js'
import { assertGitIdentifier, ensureGitAvailable } from './installer.js'
import { execFileAsync } from './process.js'

/** Result of one update check. */
export interface UpdateCheck {
  /** ISO timestamp of this observation. */
  readonly checkedAt: string
  /** Local HEAD commit. */
  readonly localCommit?: string
  /** Upstream commit, when the source has one. */
  readonly remoteCommit?: string
  /** Commits the local checkout is behind. */
  readonly behind?: number
  /** Commits the local checkout is ahead of upstream. */
  readonly ahead?: number
  /** Whether the working tree has uncommitted changes. */
  readonly dirty?: boolean
  /** Version-ish label of the upstream commit (`git describe`). */
  readonly remoteVersion?: string
  /** Failure recorded instead of throwing, so the UI can show it. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** Persistent last-check results, keyed by source slug. */
export class UpdateStore {
  /**
   * @param path - absolute JSON file path.
   * @param logger - receives warnings for an unreadable file.
   */
  constructor(
    readonly path: string,
    private readonly logger: WarnLogger,
  ) {}

  /**
   * Read the recorded checks.
   * @returns checks keyed by source slug.
   */
  read(): Record<string, UpdateCheck> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return {}
      const record = parsed as { checks?: unknown }
      if (typeof record.checks !== 'object' || record.checks === null) return {}
      return record.checks as Record<string, UpdateCheck>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`skills-manager: ignoring unreadable update record ${this.path}: ${message(error)}`)
      }
      return {}
    }
  }

  /**
   * Record one check.
   * @param slug - source slug.
   * @param check - the observation.
   */
  set(slug: string, check: UpdateCheck): void {
    this.write({ ...this.read(), [slug]: check })
  }

  /**
   * Drop a removed source's check.
   * @param slug - source slug.
   */
  drop(slug: string): void {
    const checks = { ...this.read() }
    if (!(slug in checks)) return
    delete checks[slug]
    this.write(checks)
  }

  private write(checks: Record<string, UpdateCheck>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), `.${Date.now()}-${process.pid}.updates.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, checks }, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

/** Inputs a check needs. */
export interface CheckOptions {
  /** Whether a `file://` remote is accepted. */
  readonly allowFileProtocol: boolean
}

/**
 * Fetch a source and compare its local HEAD with its upstream.
 * @param sourceDir - absolute source directory inside the library.
 * @param options - protocol configuration.
 * @returns the observation; a git failure becomes `error` on the record.
 * @throws {SkillManagerError} when the source is not a git clone or its remote is not allowed.
 */
export async function checkGitSource(sourceDir: string, options: CheckOptions): Promise<UpdateCheck> {
  if (!isGitSource(sourceDir)) {
    throw new SkillManagerError(
      400,
      'SKILL_UPDATE_UNSUPPORTED',
      'Local skill sources have no upstream; reinstall the source with overwrite enabled to pick up changes',
    )
  }
  const remote = readGitRemote(sourceDir)
  if (remote === undefined) {
    throw new SkillManagerError(400, 'SKILL_CHECK_UNSUPPORTED', 'This git source has no origin remote to check')
  }
  assertGitIdentifier(remote, options.allowFileProtocol)
  await ensureGitAvailable()

  const checkedAt = new Date().toISOString()
  const localCommit = await git(sourceDir, ['rev-parse', 'HEAD']).then((value) => value.trim()).catch(() => undefined)
  const dirty = await git(sourceDir, ['status', '--porcelain'])
    .then((value) => value.trim() !== '')
    .catch(() => undefined)
  try {
    await git(sourceDir, ['fetch', '--quiet', '--tags', '--prune', 'origin'], 120_000)
  } catch (error) {
    return { checkedAt, ...(localCommit === undefined ? {} : { localCommit }), ...(dirty === undefined ? {} : { dirty }), error: failureOf(error) }
  }
  const upstream = await resolveUpstream(sourceDir)
  if (upstream === undefined) {
    return {
      checkedAt,
      ...(localCommit === undefined ? {} : { localCommit }),
      ...(dirty === undefined ? {} : { dirty }),
      error: { code: 'SKILL_CHECK_UNSUPPORTED', message: 'The checked-out branch has no upstream to compare with' },
    }
  }
  const remoteCommit = await git(sourceDir, ['rev-parse', upstream]).then((value) => value.trim()).catch(() => undefined)
  const counts = await git(sourceDir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    .then((value) => value.trim().split(/\s+/u))
    .catch(() => undefined)
  const ahead = counts?.[0] === undefined ? undefined : Number(counts[0])
  const behind = counts?.[1] === undefined ? undefined : Number(counts[1])
  const remoteVersion = await git(sourceDir, ['describe', '--tags', '--always', upstream])
    .then((value) => value.trim())
    .catch(() => undefined)
  return {
    checkedAt,
    ...(localCommit === undefined ? {} : { localCommit }),
    ...(remoteCommit === undefined ? {} : { remoteCommit }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    ...(dirty === undefined ? {} : { dirty }),
    ...(remoteVersion === undefined ? {} : { remoteVersion }),
  }
}

function isGitSource(sourceDir: string): boolean {
  try {
    readFileSync(join(sourceDir, '.git', 'HEAD'), 'utf8')
    return true
  } catch {
    // A worktree or submodule keeps `.git` as a file; fall back to the entry.
    try {
      return readFileSync(join(sourceDir, '.git'), 'utf8').length > 0
    } catch {
      return false
    }
  }
}

async function resolveUpstream(sourceDir: string): Promise<string | undefined> {
  const symbolic = await git(sourceDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    .then((value) => value.trim())
    .catch(() => '')
  if (symbolic !== '') return symbolic
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const resolved = await git(sourceDir, ['rev-parse', '--verify', '--quiet', candidate])
      .then((value) => value.trim())
      .catch(() => '')
    if (resolved !== '') return candidate
  }
  return undefined
}

async function git(sourceDir: string, args: readonly string[], timeout = 60_000): Promise<string> {
  const result = await execFileAsync('git', ['-C', sourceDir, ...args], { timeout })
  return result.stdout
}

function failureOf(error: unknown): { code: string; message: string } {
  const failure = error as { stderr?: string; message?: string }
  return {
    code: 'SKILL_CHECK_FAILED',
    message: failure.stderr?.trim() || failure.message || 'git fetch failed',
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
