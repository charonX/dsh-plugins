/**
 * Planning-field revisions for tickets that have not been dispatched yet.
 *
 * The board owns every ticket write; this module is the pure decision layer so
 * the "which fields, which states, what changed" contract stays unit-testable.
 * History is not rewritten: the caller appends one timeline event per revision.
 */
import type { TicketRecord, TicketWorktreePlan } from './board-domain.ts'

/** Fields a human may rewrite on a not-yet-dispatched ticket. */
export interface TicketRevisionPatch {
  readonly title?: string | undefined
  readonly mandateScope?: string | undefined
  readonly acceptanceCriteria?: string | undefined
  readonly scratchDir?: string | undefined
  readonly worktree?: Partial<TicketWorktreePlan> | undefined
}

export type TicketRevisionResult =
  | { readonly ok: true; readonly record: TicketRecord; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** Revision is only safe before the executor has picked the ticket up. */
const REVISABLE_STATES: ReadonlySet<string> = new Set(['todo'])

function mergeWorktreePlan(
  current: TicketWorktreePlan | undefined,
  patch: Partial<TicketWorktreePlan>,
): TicketWorktreePlan {
  return {
    mode: patch.mode ?? current?.mode ?? 'worktree',
    ...((patch.repoRoot ?? current?.repoRoot) === undefined ? {} : { repoRoot: patch.repoRoot ?? current?.repoRoot }),
    ...((patch.baseBranch ?? current?.baseBranch) === undefined ? {} : { baseBranch: patch.baseBranch ?? current?.baseBranch }),
    ...((patch.branch ?? current?.branch) === undefined ? {} : { branch: patch.branch ?? current?.branch }),
    ...((patch.mergeTarget ?? current?.mergeTarget) === undefined ? {} : { mergeTarget: patch.mergeTarget ?? current?.mergeTarget }),
    ...((patch.path ?? current?.path) === undefined ? {} : { path: patch.path ?? current?.path }),
  }
}

/**
 * Apply one revision patch to a ticket record. Refuses running/ended tickets
 * and empty patches, and reports exactly which fields moved so the timeline
 * entry is auditable.
 */
export function applyTicketRevision(
  record: TicketRecord,
  patch: TicketRevisionPatch,
  now: number,
): TicketRevisionResult {
  if (!REVISABLE_STATES.has(record.state)) {
    return { ok: false, reason: `ticket ${record.id} is ${record.state}; only todo tickets can be revised` }
  }
  const changed: string[] = []
  let next: TicketRecord = record

  const title = patch.title?.trim()
  if (title !== undefined && title !== '' && title !== record.title) {
    next = { ...next, title }
    changed.push('title')
  }

  const scope = patch.mandateScope?.trim()
  if (scope !== undefined && scope !== '' && scope !== record.mandate?.scope) {
    next = {
      ...next,
      mandate: {
        strength: next.mandate?.strength ?? 'explicit',
        policyVersion: next.mandate?.policyVersion ?? '1',
        scope,
      },
    }
    changed.push('mandate.scope')
  }

  if (patch.acceptanceCriteria !== undefined) {
    const acceptance = patch.acceptanceCriteria.trim()
    const normalized = acceptance === '' ? undefined : acceptance
    if (normalized !== record.acceptanceCriteria) {
      if (normalized === undefined) {
        const cleared: TicketRecord = { ...next }
        delete cleared.acceptanceCriteria
        next = cleared
      } else {
        next = { ...next, acceptanceCriteria: normalized }
      }
      changed.push('acceptanceCriteria')
    }
  }

  const scratchDir = patch.scratchDir?.trim()
  if (scratchDir !== undefined && scratchDir !== '' && scratchDir !== record.scratchDir) {
    next = { ...next, scratchDir }
    changed.push('scratchDir')
  }

  if (patch.worktree !== undefined) {
    const merged = mergeWorktreePlan(record.worktree, patch.worktree)
    if (JSON.stringify(merged) !== JSON.stringify(record.worktree)) {
      next = { ...next, worktree: merged }
      changed.push('worktree')
    }
  }

  if (changed.length === 0) {
    return { ok: false, reason: `no field of ticket ${record.id} would change` }
  }
  return { ok: true, record: { ...next, updatedAt: now }, changed }
}
