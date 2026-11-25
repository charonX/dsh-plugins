/**
 * Wire-level types and input schemas of the policy API — shared by the host
 * service and the client contribution.
 */
import { z as zod } from 'zod'
import { ACTION_CATEGORIES } from '../approval/approval-policy.ts'
import { POLICY_ENTRY_KINDS, type PolicyDiff, type PolicyEntry, type PolicyRecord } from './policy-core.ts'

export type { PolicyDiff, PolicyEntry, PolicyRecord }

export const policyDiffInputSchema = zod.object({
  from: zod.string().min(1),
  to: zod.string().min(1),
})

export type PolicyDiffInput = zod.infer<typeof policyDiffInputSchema>

export const policyUpdateInputSchema = zod.object({
  /** The approval categories the next version carries; absent keeps the current ones. */
  approvalCategories: zod.array(zod.enum(ACTION_CATEGORIES)).optional(),
  /** Decision records to append with this version. */
  addEntries: zod.array(zod.object({
    kind: zod.enum(POLICY_ENTRY_KINDS),
    statement: zod.string().min(1),
  })).optional(),
  /** Decision-record ids to drop with this version. */
  removeEntryIds: zod.array(zod.string()).optional(),
})

export type PolicyUpdateInput = zod.infer<typeof policyUpdateInputSchema>
