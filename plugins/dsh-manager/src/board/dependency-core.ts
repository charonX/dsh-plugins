/**
 * Pure ticket-dependency domain logic: validates acyclic `dependsOn` links
 * and resolves which prerequisite tickets still block dispatch.
 */
import type { TicketRecord } from '../board-domain.ts'
import { flowChain } from '../flow/flow-core.ts'

export interface WaitingDependencyView {
  readonly id: string
  readonly title: string
  readonly state: TicketRecord['state']
}

/**
 * Validate and normalize `dependsOn` for `ticketId`, rejecting self-links,
 * unknown target tickets, and dependency cycles.
 */
export function validateDependencies(
  tickets: readonly TicketRecord[],
  ticketId: string,
  rawDependsOn: readonly string[],
): string[] {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const raw of rawDependsOn) {
    const depId = raw.trim()
    if (depId === '' || seen.has(depId)) continue
    if (depId === ticketId) {
      throw new Error(`ticket ${ticketId} cannot depend on itself`)
    }
    if (!byId.has(depId)) {
      throw new Error(`dependency ticket ${depId} does not exist`)
    }
    seen.add(depId)
    normalized.push(depId)
  }

  // Detect cycles: `ticketId` must not be reachable from any dependency in `normalized`.
  const visiting = new Set<string>()
  const stack = [...normalized]
  while (stack.length > 0) {
    const currentId = stack.pop()!
    if (currentId === ticketId) {
      throw new Error(`dependency cycle detected involving ticket ${ticketId}`)
    }
    if (visiting.has(currentId)) continue
    visiting.add(currentId)
    const current = byId.get(currentId)
    for (const nextDep of current?.dependsOn ?? []) {
      stack.push(nextDep)
    }
  }

  return normalized
}

/**
 * Resolve all prerequisite tickets that have not yet reached `ended`.
 * Checks both `ticket.dependsOn` and (for pipeline stage tickets) the flow root's `dependsOn`.
 */
export function unresolvedDependencies(
  tickets: readonly TicketRecord[],
  ticket: TicketRecord,
): readonly WaitingDependencyView[] {
  const byId = new Map(tickets.map(entry => [entry.id, entry]))
  const rootId = ticket.flow === undefined ? undefined : flowChain(tickets, ticket.id)?.root.id
  const root = rootId === undefined || rootId === ticket.id ? undefined : byId.get(rootId)
  const rawIds = [...(ticket.dependsOn ?? []), ...(root?.dependsOn ?? [])]
  const waiting: WaitingDependencyView[] = []
  const seen = new Set<string>()
  for (const depId of rawIds) {
    if (seen.has(depId)) continue
    seen.add(depId)
    const target = byId.get(depId)
    if (target === undefined) continue
    if (target.flow !== undefined) {
      const chain = flowChain(tickets, target.id)
      const incompleteStage = chain?.stages.find(stage => stage.state !== 'ended')
      if (incompleteStage !== undefined) {
        waiting.push({ id: target.id, title: target.title, state: incompleteStage.state })
        continue
      }
      if (target.state === 'ended') continue
    } else if (target.state === 'ended') {
      continue
    }
    waiting.push({ id: target.id, title: target.title, state: target.state })
  }
  return waiting
}
