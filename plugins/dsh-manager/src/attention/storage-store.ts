/** The attention store over the board domain's attentions table. */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import type { AttentionRecord, AttentionStorePort } from './attention-core.ts'

/**
 * The durable {@link AttentionStorePort} adapter: the board domain's
 * attentions table (as-never casts like the eval and dispatch stores).
 */
export function createDomainAttentionStore(domain: Domain<typeof boardDomain>): AttentionStorePort {
  return {
    getAttention: id => domain.table('attentions').get(id as never),
    async putAttention(record) {
      await domain.table('attentions').put(record.id as never, record)
    },
    listAttentions: () => [...domain.table('attentions').entries()].map(([, value]) => value),
  }
}
