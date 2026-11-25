/**
 * The storage-domain adapter for the eval core: an EvalStorePort over the
 * board domain's tickets and evals tables, plus the arrival-ordered trigger
 * read the backlog derivation needs.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain, EvalRecord, TicketRecord } from '../board-domain.ts'
import type { EvalStorePort } from './eval-core.ts'

/** The eval store over one open board domain. */
export interface DomainEvalStore extends EvalStorePort {
  /** Every eval record, oldest start first. */
  listEvalsOrdered(): readonly EvalRecord[]
}

/** Build the store over one open board domain. */
export function createDomainEvalStore(domain: Domain<typeof boardDomain>): DomainEvalStore {
  const tickets = domain.table('tickets')
  const evals = domain.table('evals')
  return {
    listEvalsOrdered() {
      return [...evals.entries()]
        .map(([, record]) => record)
        .sort((left, right) => left.startedAt - right.startedAt)
    },
    getEval(id) { return evals.get(id as never) },
    async putEval(record) { await evals.put(record.id as never, record as EvalRecord) },
    listThreadEvals(threadId) {
      return [...evals.entries()]
        .map(([, record]) => record)
        .filter(record => record.threadId === threadId)
    },
    listEvals() { return [...evals.entries()].map(([, record]) => record) },
    getTicket(id) { return tickets.get(id as never) },
    async putTicket(record) { await tickets.put(record.id as never, record as TicketRecord) },
    listTickets() { return [...tickets.entries()].map(([, record]) => record) },
  }
}
