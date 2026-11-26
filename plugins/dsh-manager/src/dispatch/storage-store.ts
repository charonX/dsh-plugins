/**
 * The storage-domain adapter for the dispatch core: a DispatchStorePort over
 * the board domain's dispatches table. Every durable transition is mirrored
 * into the ticket ledger — the dispatch record stays authoritative for
 * scheduling, the ledger for history.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import { createDomainTimelineStore } from '../timeline/storage-store.ts'
import { recordDispatchTimeline } from '../timeline/timeline-core.ts'
import type { DispatchRecord, DispatchStorePort } from './dispatch-core.ts'

/** Options for the durable dispatch store. */
export interface DispatchStoreOptions {
  /**
   * Reported when mirroring a transition into the ticket ledger fails. The
   * dispatch write already landed, so with a reporter the ledger loss goes to
   * the host log instead of failing the state transition that produced it;
   * without one the failure propagates (the test-visible default).
   */
  readonly onTimelineError?: (error: unknown) => void
}

/**
 * Build the dispatch store over one open board domain.
 * @param domain - the open board domain.
 * @param options - error reporting for ledger mirroring.
 * @returns the dispatch store.
 */
export function createDomainDispatchStore(
  domain: Domain<typeof boardDomain>,
  options: DispatchStoreOptions = {},
): DispatchStorePort {
  const dispatches = domain.table('dispatches')
  const timelines = createDomainTimelineStore(domain)
  return {
    getDispatch(id) { return dispatches.get(id as never) },
    async putDispatch(record) {
      const previous = dispatches.get(record.id as never) as DispatchRecord | undefined
      await dispatches.put(record.id as never, record as DispatchRecord)
      try {
        await recordDispatchTimeline(timelines, previous, record)
      } catch (error) {
        if (options.onTimelineError === undefined) throw error
        options.onTimelineError(error)
      }
    },
    listDispatches() { return [...dispatches.entries()].map(([, record]) => record) },
  }
}
