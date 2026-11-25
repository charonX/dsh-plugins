/**
 * The EffectStorePort adapter over one open effects domain (ADR-0003): reads
 * come from validated in-memory state, writes are durable, and subscribers
 * hear the domain's in-order change events.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { EffectStorePort } from './effect-queue.ts'
import { effectsDomain, type EffectId, type EffectRecord } from './effects-domain.ts'

/**
 * Bind the store port to one open domain on the given context: the change
 * subscription rides the context's `domain/changed` events, filtered to this
 * domain's table.
 * @param ctx - context whose events carry the domain's changes.
 * @param domain - the open effects domain handle.
 * @returns the store port for the effect queue.
 */
export function createDomainEffectStore(ctx: Context, domain: Domain<typeof effectsDomain>): EffectStorePort {
  const table = () => domain.table('effects')
  return {
    list(): readonly EffectRecord[] {
      return [...table().entries()].map(([, value]) => value)
    },
    async put(record: EffectRecord): Promise<void> {
      await table().put(record.id as EffectId, record)
    },
    subscribe(listener: () => void): () => void {
      return ctx.on('domain/changed', (change) => {
        if (change.domain === effectsDomain.name && change.table === 'effects') listener()
      })
    },
  }
}
