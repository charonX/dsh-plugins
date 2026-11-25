/**
 * The storage-domain adapter for the trigger core: a TriggerStorePort plus
 * the list reads the browse page needs, all backed by the triggers domain.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { triggersDomain, ThreadRecord, TriggerRecord } from './triggers-domain.ts'
import type { TriggerStorePort } from './trigger-core.ts'

/** The trigger store over one open triggers domain. */
export interface DomainTriggerStore extends TriggerStorePort {
  /** Every trigger, newest collection first. */
  listTriggers(): readonly TriggerRecord[]
  /** Every trigger of one thread, newest collection first. */
  listThreadTriggers(threadId: string): readonly TriggerRecord[]
  /** Every thread, most recently updated first. */
  listThreads(): readonly ThreadRecord[]
}

/** Build the store over one open domain. */
export function createDomainTriggerStore(domain: Domain<typeof triggersDomain>): DomainTriggerStore {
  const triggers = domain.table('triggers')
  const threads = domain.table('threads')
  return {
    listTriggers() {
      return [...triggers.entries()]
        .map(([, record]) => record)
        .sort((left, right) => right.collectedAt - left.collectedAt)
    },
    listThreadTriggers(threadId: string) {
      return [...triggers.entries()]
        .map(([, record]) => record)
        .filter(record => record.threadId === threadId)
        .sort((left, right) => right.collectedAt - left.collectedAt)
    },
    listThreads() {
      return [...threads.entries()]
        .map(([, record]) => record)
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },
    getTrigger(id) { return triggers.get(id as never) },
    async putTrigger(record) {
      await triggers.put(record.id as never, record as TriggerRecord)
    },
    getThread(id) { return threads.get(id as never) },
    async putThread(record) {
      await threads.put(record.id as never, record as ThreadRecord)
    },
  }
}
