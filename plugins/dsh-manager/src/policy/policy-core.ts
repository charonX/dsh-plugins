/**
 * The policy domain core: the Policy is versioned as a whole — the approval
 * categories and the decision records (long-term preferences and explicit
 * rejections) travel together. Versions are immutable: a change mints the
 * next version, and the Steward only proposes — the user's confirmation (or
 * their own page edit) mints it (spec stories 45–48).
 */
import { z } from 'zod'
import { ACTION_CATEGORIES, type ActionCategory } from '../approval/approval-policy.ts'

/** The decision-record kinds: how the user wants similar work handled. */
export const POLICY_ENTRY_KINDS = ['preference', 'rejection'] as const
export type PolicyEntryKind = (typeof POLICY_ENTRY_KINDS)[number]

/** One decision record: a standing preference or an explicit rejection. */
export const policyEntry = z.object({
  id: z.string(),
  kind: z.enum(POLICY_ENTRY_KINDS),
  /** The standing instruction, verbatim. */
  statement: z.string(),
  createdAt: z.number(),
})

export type PolicyEntry = z.infer<typeof policyEntry>

/** One Policy version: the whole of the rules, immutable once minted. */
export const policyRecord = z.object({
  version: z.string(),
  /** The action categories that need approval under this version. */
  approvalCategories: z.array(z.enum(ACTION_CATEGORIES)),
  /** The decision records this version carries, in confirmation order. */
  decisions: z.array(policyEntry),
  createdAt: z.number(),
})

export type PolicyRecord = z.infer<typeof policyRecord>

/** The changes the Steward can propose; only the human's confirmation applies one. */
export const POLICY_PROPOSAL_CHANGES = ['add-preference', 'add-rejection', 'relax-approval'] as const
export type PolicyProposalChange = (typeof POLICY_PROPOSAL_CHANGES)[number]

/** One proposal the Steward submitted through its propose_policy tool. */
export interface PolicyProposal {
  readonly change: PolicyProposalChange
  /** The entry's statement, or the approval category to relax. */
  readonly statement: string
}

/** The Policy every boot starts from: version 1, every category, no records. */
export function defaultPolicy(now: number): PolicyRecord {
  return policyRecord.parse({
    version: '1',
    approvalCategories: [...ACTION_CATEGORIES],
    decisions: [],
    createdAt: now,
  })
}

/** The next version number: numeric versions increment. */
export function nextVersionOf(current: string): string {
  const parsed = Number.parseInt(current, 10)
  return Number.isFinite(parsed) ? String(parsed + 1) : `${current}+1`
}

/**
 * Apply one confirmed proposal as the next version. The current record is
 * never mutated; a statement already on record is refused so confirming a
 * proposal twice never mints twice.
 */
export function applyProposal(current: PolicyRecord, proposal: PolicyProposal, now: number): PolicyRecord {
  if (proposal.change === 'relax-approval') {
    if (!ACTION_CATEGORIES.includes(proposal.statement as ActionCategory)) {
      throw new Error(`unknown approval category: ${proposal.statement}`)
    }
    return policyRecord.parse({
      version: nextVersionOf(current.version),
      approvalCategories: current.approvalCategories.filter(category => category !== proposal.statement),
      decisions: current.decisions,
      createdAt: now,
    })
  }
  if (current.decisions.some(entry => entry.statement === proposal.statement)) {
    throw new Error(`decision record already on file: ${proposal.statement}`)
  }
  const kind: PolicyEntryKind = proposal.change === 'add-rejection' ? 'rejection' : 'preference'
  return policyRecord.parse({
    version: nextVersionOf(current.version),
    approvalCategories: current.approvalCategories,
    decisions: [...current.decisions, { id: `entry-${crypto.randomUUID()}`, kind, statement: proposal.statement, createdAt: now }],
    createdAt: now,
  })
}

/** What moved between two versions, for the history diff. */
export interface PolicyDiff {
  readonly entriesAdded: readonly PolicyEntry[]
  readonly entriesRemoved: readonly PolicyEntry[]
  readonly categoriesAdded: readonly ActionCategory[]
  readonly categoriesRemoved: readonly ActionCategory[]
}

/** Compare two versions by decision-record statement and approval category. */
export function diffPolicies(from: PolicyRecord, to: PolicyRecord): PolicyDiff {
  const fromStatements = new Set(from.decisions.map(entry => entry.statement))
  const toStatements = new Set(to.decisions.map(entry => entry.statement))
  const fromCategories = new Set(from.approvalCategories)
  const toCategories = new Set(to.approvalCategories)
  return {
    entriesAdded: to.decisions.filter(entry => !fromStatements.has(entry.statement)),
    entriesRemoved: from.decisions.filter(entry => !toStatements.has(entry.statement)),
    categoriesAdded: to.approvalCategories.filter(category => !fromCategories.has(category)),
    categoriesRemoved: from.approvalCategories.filter(category => !toCategories.has(category)),
  }
}
