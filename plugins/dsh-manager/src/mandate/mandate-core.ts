/**
 * The mandate inheritance core: what a follow-up ticket may carry (spec
 * stories 61–63). A follow-up inherits its parent's Mandate — the evidence
 * strength and policy version ride along unchanged — and its scope may only
 * narrow the parent's: the mandate's surfaces are the comma-separated items
 * of its scope, and a proposed scope stays inside the parent's when every
 * surface it names is already covered. Widening the mandate is overreach and
 * goes to the human as an Approval before the follow-up mints.
 */
import { mandateRecord, type Mandate } from '../board-domain.ts'

export type { Mandate }

/** The surfaces a mandate's scope names: comma-separated, trimmed, case-folded. */
export function scopeItems(scope: string): readonly string[] {
  return scope.split(',').map(item => item.trim().toLowerCase()).filter(item => item !== '')
}

/**
 * Whether a proposed scope stays inside the parent mandate's scope.
 * @param parentScope - the mandate the follow-up inherits from.
 * @param proposedScope - the scope the follow-up asks for.
 */
export function mandateCovers(parentScope: string, proposedScope: string): boolean {
  const parent = new Set(scopeItems(parentScope))
  const proposed = scopeItems(proposedScope)
  if (proposed.length === 0) return false
  return proposed.every(item => parent.has(item))
}

/** What a follow-up inherits: the parent's mandate with the proposed scope. */
export type FollowUpDecision =
  | { readonly path: 'direct'; readonly mandate: Mandate }
  | { readonly path: 'needs-approval'; readonly mandate: Mandate }

/**
 * Inherit the parent's mandate for one follow-up: an equal-or-narrower scope
 * mints directly; a widened scope needs the human's approval, and the
 * proposed mandate rides the decision so approving it mints exactly what
 * was proposed.
 */
export function inheritMandate(parent: Mandate, proposedScope: string): FollowUpDecision {
  const mandate = mandateRecord.parse({
    strength: parent.strength,
    scope: proposedScope,
    policyVersion: parent.policyVersion,
  })
  return mandateCovers(parent.scope, proposedScope)
    ? { path: 'direct', mandate }
    : { path: 'needs-approval', mandate }
}
