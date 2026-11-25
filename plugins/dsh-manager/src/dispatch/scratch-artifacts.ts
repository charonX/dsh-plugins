/**
 * Shared scratch directory resolution for pipeline stages: keeps intermediate
 * process artifacts (`design.md`, `repro-red.log`, `test-report.log`,
 * `review-report.md`, `verify/`) outside git worktrees so worktree cleanup
 * never destroys evidence and downstream stages read from one stable path.
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_ANCESTOR_HOPS = 4

/**
 * Find the nearest `scratch/tasks` root by walking up from `basePath` (for
 * multi-repo workspaces such as `home-repos/repos/<subrepo>`), or undefined
 * when none exists within {@link MAX_ANCESTOR_HOPS} levels.
 */
export function findScratchTasksRoot(basePath: string): string | undefined {
  let cursor = resolve(basePath)
  for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
    const candidate = join(cursor, 'scratch', 'tasks')
    if (existsSync(candidate)) return candidate
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return undefined
}

/**
 * Extract an explicit `.../scratch/tasks/<slug>` directory when referenced in
 * a ticket's scope or acceptance criteria (for example, `align-card.md`).
 */
export function extractScratchTaskDirFromText(text: string | undefined, basePath?: string): string | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const absMatch = /(\/[^\s"'`<>()]*?\/scratch\/tasks\/[A-Za-z0-9._-]+)/.exec(text)
  if (absMatch?.[1] !== undefined) return absMatch[1]
  const relMatch = /(?:^|[\s"'`([/])(?:home-repos\/)?(scratch\/tasks\/[A-Za-z0-9._-]+)/.exec(text)
  if (relMatch?.[1] === undefined) return undefined
  const slug = relMatch[1].replace(/^scratch\/tasks\//, '')
  if (basePath === undefined) return undefined
  const root = findScratchTasksRoot(basePath)
  return root === undefined ? undefined : join(root, slug)
}

/**
 * Resolve the shared scratch directory for a ticket or flow walk.
 * Precedence: explicit `ticket.scratchDir` -> path referenced in text ->
 * `<nearest scratch/tasks>/<rootTicketId>` -> `<basePath>/.dsh-manager/tasks/<rootTicketId>`.
 */
export function resolveTaskScratchDir(input: {
  readonly scratchDir?: string
  readonly scope?: string
  readonly acceptanceCriteria?: string
  readonly rootTicketId: string
  readonly basePath: string
}): string {
  const explicit = input.scratchDir?.trim()
  if (explicit !== undefined && explicit !== '') {
    return isAbsolute(explicit) ? explicit : resolve(input.basePath, explicit)
  }
  const fromText = extractScratchTaskDirFromText(
    [input.scope, input.acceptanceCriteria].filter(Boolean).join('\n'),
    input.basePath,
  )
  if (fromText !== undefined) return fromText
  const scratchRoot = findScratchTasksRoot(input.basePath)
  if (scratchRoot !== undefined) return join(scratchRoot, input.rootTicketId)
  return join(resolve(input.basePath), '.dsh-manager', 'tasks', input.rootTicketId)
}
