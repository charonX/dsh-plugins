/** The attention store over the board domain's attentions table; asks and answers are mirrored into the ticket ledger. */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import { createDomainTimelineStore } from '../timeline/storage-store.ts'
import { recordAttentionTimeline } from '../timeline/timeline-core.ts'
import type { AttentionRecord, AttentionStorePort } from './attention-core.ts'

/** Options for the durable attention store. */
export interface AttentionStoreOptions {
  /**
   * Reported when mirroring an ask/answer into the ticket ledger fails. Without
   * a reporter the failure propagates (the test-visible default).
   */
  readonly onTimelineError?: (error: unknown) => void
}

/**
 * The durable {@link AttentionStorePort} adapter: the board domain's
 * attentions table (as-never casts like the eval and dispatch stores).
 * @param domain - the open board domain.
 * @param options - error reporting for ledger mirroring.
 * @returns the attention store.
 */
export function createDomainAttentionStore(
  domain: Domain<typeof boardDomain>,
  options: AttentionStoreOptions = {},
): AttentionStorePort {
  const timelines = createDomainTimelineStore(domain)
  return {
    getAttention: id => domain.table('attentions').get(id as never),
    async putAttention(record) {
      const previous = domain.table('attentions').get(record.id as never) as AttentionRecord | undefined
      await domain.table('attentions').put(record.id as never, record)
      try {
        await recordAttentionTimeline(timelines, previous, record)
      } catch (error) {
        if (options.onTimelineError === undefined) throw error
        options.onTimelineError(error)
      }
    },
    listAttentions: () => [...domain.table('attentions').entries()].map(([, value]) => value),
  }
}
