/** The timeline store over the board domain's timelines table (one ledger per ticket). */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import type { TicketTimelineRecord, TimelineStorePort } from './timeline-core.ts'

/**
 * Build the durable {@link TimelineStorePort} adapter over one open board
 * domain. `updateTimeline` runs in the domain write chain, which is what makes
 * `seq` allocation and the dedupe check atomic.
 * @param domain - the open board domain.
 * @returns the timeline store.
 */
export function createDomainTimelineStore(domain: Domain<typeof boardDomain>): TimelineStorePort {
  const timelines = domain.table('timelines')
  return {
    getTimeline: ticketId => timelines.get(ticketId as never),
    async putTimeline(record) {
      await timelines.put(record.ticketId as never, record)
    },
    async updateTimeline(ticketId, update) {
      if (timelines.get(ticketId as never) === undefined) return undefined
      return await timelines.update(ticketId as never, update)
    },
    listTimelines: () => [...timelines.entries()].map(([, value]) => value as TicketTimelineRecord),
  }
}
