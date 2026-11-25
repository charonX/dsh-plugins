import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable effect identity; doubles as the target-side idempotency key. */
export type EffectId = Branded<'EffectId'>

/** One durable side effect awaiting delivery; the queue owns its transitions. */
export const effectRecord = z.object({
  /** Stable effect id (idempotency key). */
  id: z.string(),
  /** Dispatch discriminator the host registry resolves. */
  kind: z.string(),
  /** JSON payload handed to the deliverer. */
  payload: z.unknown(),
  /** pending → in-flight → done | pending[backoff] | failed. */
  status: z.enum(['pending', 'in-flight', 'done', 'failed']),
  /** Deliverer invocations so far; the cap moves the record to failed. */
  attempts: z.number().int().nonnegative(),
  /** Epoch millis the record next becomes deliverable; 0 = immediately due. */
  nextAttemptAt: z.number(),
  /** Last delivery failure message, for queryable diagnosis. */
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type EffectRecord = z.infer<typeof effectRecord>

/**
 * Durable outbound side effects (ADR-0003): one row per effect, per-record
 * atomic writes; crash recovery is a boot-time sweep, not a transaction.
 */
export const effectsDomain = defineDomain({
  name: 'dsh_manager_effects',
  version: 1,
  tables: {
    effects: domainTable<EffectId, EffectRecord>(effectRecord),
  },
})
