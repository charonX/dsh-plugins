/**
 * The review store over the board domain's reviews table: the thin
 * persistence adapter behind the review core (ADR-0003).
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { boardDomain } from '../board-domain.ts'
import type { ReviewRecord, ReviewStorePort } from './review-core.ts'

/** One review store bound to one open board domain. */
export function createDomainReviewStore(domain: Domain<typeof boardDomain>): ReviewStorePort {
  const table = domain.table('reviews')
  return {
    getReview(id) {
      return table.get(id as never) as ReviewRecord | undefined
    },
    async putReview(record) {
      await table.put(record.id as never, record)
    },
    listReviews() {
      return [...table.entries()].map(([, record]) => record as ReviewRecord)
    },
  }
}
