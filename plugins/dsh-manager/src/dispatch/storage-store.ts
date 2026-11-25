/**
 * The storage-domain adapter for the dispatch core: a DispatchStorePort over
 * the board domain's dispatches table.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import type { DispatchRecord, DispatchStorePort } from './dispatch-core.ts'

/** Build the dispatch store over one open board domain. */
export function createDomainDispatchStore(domain: Domain<typeof boardDomain>): DispatchStorePort {
  const dispatches = domain.table('dispatches')
  return {
    getDispatch(id) { return dispatches.get(id as never) },
    async putDispatch(record) { await dispatches.put(record.id as never, record as DispatchRecord) },
    listDispatches() { return [...dispatches.entries()].map(([, record]) => record) },
  }
}
