/**
 * Deterministic target-repo detection for one ticket.
 *
 * Semantic decisions stay with the Steward (it fills the worktree plan). This
 * module only refuses the silent wrong-root case: a ticket whose text names
 * `repos/<name>` while the plan points at the aggregate workspace. That root is
 * itself a git repo, so nothing fails loudly — the worktree is created there and
 * the sub-repo shows up as an untracked directory, so its changes can never be
 * committed from inside the worktree.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The ticket fields whose text names the target repository. */
export interface TicketTargetText {
  readonly title: string
  readonly mandateScope?: string | undefined
  readonly acceptanceCriteria?: string | undefined
}

/** How many ancestor levels to probe above a workspace base (workspace -> repos/<name>). */
const MAX_ANCESTOR_HOPS = 4

/** Ticket prose naming a sibling checkout: `repos/<name>` or `references/<name>`. */
const NAMED_REPO_PATTERN = /(?:^|[\s`'"(（【[])((?:repos|references)\/[A-Za-z0-9._-]+)/g

export type TargetRepoDetection =
  | { readonly kind: 'named'; readonly relativePath: string; readonly repoRoot: string }
  | { readonly kind: 'missing'; readonly relativePath: string; readonly triedPaths: readonly string[] }
  | { readonly kind: 'none' }

/** The first repository path named by the ticket text, in reading order. */
export function namedRepoTargetOf(text: TicketTargetText): string | undefined {
  const haystack = [text.title, text.mandateScope ?? '', text.acceptanceCriteria ?? ''].join('\n')
  const matches: string[] = []
  for (const match of haystack.matchAll(NAMED_REPO_PATTERN)) {
    const candidate = match[1]!.replace(/[.,;:]$/, '')
    if (!matches.includes(candidate)) matches.push(candidate)
  }
  return matches[0]
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'))
}

/** Resolve one relative repo path against each base and its ancestors. */
function resolveNamedRepo(relativePath: string, basePaths: readonly string[]): string | undefined {
  const tried = new Set<string>()
  for (const base of basePaths) {
    let cursor = resolve(base)
    for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
      const candidate = join(cursor, relativePath)
      if (!tried.has(candidate)) {
        tried.add(candidate)
        if (isGitRepo(candidate)) return candidate
      }
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return undefined
}

/**
 * Detect the repo the ticket talks about. `named` carries a resolved git root,
 * `missing` means the ticket names a checkout that does not exist (the caller
 * must refuse the dispatch), `none` means the text names no sub-repo at all.
 */
export function detectTicketTargetRepo(
  text: TicketTargetText,
  basePaths: readonly (string | undefined)[],
): TargetRepoDetection {
  const relativePath = namedRepoTargetOf(text)
  if (relativePath === undefined) return { kind: 'none' }
  const bases = basePaths.filter((base): base is string => base !== undefined && base !== '')
  const repoRoot = resolveNamedRepo(relativePath, bases)
  if (repoRoot !== undefined) return { kind: 'named', relativePath, repoRoot }
  return {
    kind: 'missing',
    relativePath,
    triedPaths: bases.map(base => resolve(base, relativePath)),
  }
}

/** Precedence when the plan root, the workspace root, and the ticket text disagree. */
export interface RepoRootDecision {
  readonly repoRoot: string | undefined
  /** Set when the dispatch must be refused instead of editing the wrong checkout. */
  readonly targetRepoError?: string
  /** True when the ticket text overrode a plan/workspace root. */
  readonly corrected: boolean
}

/**
 * Choose the repo root for one dispatch.
 *
 * Precedence: a `repos/<name>` target named by the ticket (it is the only root
 * that can commit that code) > the Steward's plan root > the mapped workspace
 * root. A named target that does not resolve is an error, because falling back
 * to the aggregate workspace silently produces an uncommittable worktree.
 */
export function decideRepoRoot(input: {
  readonly detection: TargetRepoDetection
  readonly planRepoRoot?: string | undefined
  readonly mappedRoot?: string | undefined
}): RepoRootDecision {
  const plan = input.planRepoRoot?.trim() === '' ? undefined : input.planRepoRoot?.trim()
  if (input.detection.kind === 'named') {
    return {
      repoRoot: input.detection.repoRoot,
      corrected: plan !== undefined && resolve(plan) !== resolve(input.detection.repoRoot),
    }
  }
  if (input.detection.kind === 'missing') {
    if (plan !== undefined && isGitRepo(plan)) return { repoRoot: plan, corrected: false }
    return {
      repoRoot: plan ?? input.mappedRoot,
      corrected: false,
      targetRepoError: `ticket names ${input.detection.relativePath} but no git repository was found there (tried: ${input.detection.triedPaths.join(', ')})`,
    }
  }
  return { repoRoot: plan ?? input.mappedRoot, corrected: false }
}
