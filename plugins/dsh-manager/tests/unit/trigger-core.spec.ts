/** Domain-core spec: trigger dedupe and thread grouping. */
import { describe, expect, test } from 'vitest'
import { ingestTriggers, threadIdOf, triggerIdOf, type IncomingTrigger, type TriggerStorePort } from '../../src/triggers/trigger-core.ts'

/** An in-memory store the core drives. */
function memoryStore(): TriggerStorePort & {
  triggers: Map<string, { fingerprint: string; threadId: string; collectedAt: number }>
  threads: Map<string, { updatedAt: number; title: string }>
} {
  const triggers = new Map<string, { fingerprint: string; threadId: string; collectedAt: number }>()
  const threads = new Map<string, { updatedAt: number; title: string }>()
  return {
    triggers,
    threads,
    getTrigger(id) { return triggers.get(id) },
    async putTrigger(record) {
      triggers.set(record.id, { fingerprint: record.fingerprint, threadId: record.threadId, collectedAt: record.collectedAt })
    },
    getThread(id) { return threads.get(id) },
    async putThread(record) {
      threads.set(record.id, { updatedAt: record.updatedAt, title: record.title })
    },
  }
}

function change(overrides: Partial<IncomingTrigger> = {}): IncomingTrigger {
  return {
    sourceId: 'src-1',
    connectionId: 'conn-1',
    connector: 'jira',
    externalKey: 'PROJ-1',
    fingerprint: '2026-01-01T00:00:00.000+0000',
    title: 'Fix the login flow',
    payload: { key: 'PROJ-1' },
    url: 'https://jira.example.com/browse/PROJ-1',
    ...overrides,
  }
}

describe('ingestTriggers', () => {
  test('a collected change becomes one trigger in its own thread', async () => {
    const store = memoryStore()
    const result = await ingestTriggers(store, [change()], 1000)
    expect(result.added).toHaveLength(1)
    expect(result.duplicates).toBe(0)
    const stored = [...store.triggers.values()][0]
    expect(stored?.fingerprint).toContain('2026-01-01')
    const thread = [...store.threads.values()][0]
    expect(thread?.title).toBe('Fix the login flow')
  })

  test('re-ingesting the same change is a duplicate, never a second trigger', async () => {
    const store = memoryStore()
    await ingestTriggers(store, [change()], 1000)
    const second = await ingestTriggers(store, [change()], 2000)
    expect(second.added).toHaveLength(0)
    expect(second.duplicates).toBe(1)
    expect(store.triggers.size).toBe(1)
    expect([...store.triggers.values()][0]?.collectedAt).toBe(1000)
  })

  test('a changed fingerprint is a new trigger in the same thread', async () => {
    const store = memoryStore()
    await ingestTriggers(store, [change()], 1000)
    const second = await ingestTriggers(store, [change({ fingerprint: '2026-01-02T00:00:00.000+0000' })], 2000)
    expect(second.added).toHaveLength(1)
    expect(store.triggers.size).toBe(2)
    const threadIds = new Set([...store.triggers.values()].map(trigger => trigger.threadId))
    expect(threadIds.size).toBe(1)
    // The second change carries no occurredAt, so the collection time drives the clock.
    expect(store.threads.get(threadIdOf('conn-1', 'PROJ-1'))?.updatedAt).toBe(2000)
  })

  test('different issues land in different threads; the same issue from two sources shares one thread', async () => {
    const store = memoryStore()
    await ingestTriggers(store, [
      change({ externalKey: 'PROJ-1' }),
      change({ externalKey: 'PROJ-2', fingerprint: 'f2' }),
      change({ sourceId: 'src-2', externalKey: 'PROJ-1', fingerprint: 'f3' }),
    ], 1000)
    expect(store.triggers.size).toBe(3)
    expect(store.threads.size).toBe(2)
  })

  test('ids are content-derived and stable across order and instance', () => {
    expect(triggerIdOf('src-1', 'PROJ-1', 'f1')).toBe(triggerIdOf('src-1', 'PROJ-1', 'f1'))
    expect(triggerIdOf('src-1', 'PROJ-1', 'f1')).not.toBe(triggerIdOf('src-1', 'PROJ-1', 'f2'))
    expect(triggerIdOf('src-1', 'PROJ-1', 'f1')).not.toBe(triggerIdOf('src-2', 'PROJ-1', 'f1'))
    expect(threadIdOf('conn-1', 'PROJ-1')).toBe(threadIdOf('conn-1', 'PROJ-1'))
    expect(threadIdOf('conn-1', 'PROJ-1')).not.toBe(threadIdOf('conn-2', 'PROJ-1'))
  })

  test('a batch ingests atomically enough that later duplicates in the same batch are caught', async () => {
    const store = memoryStore()
    const result = await ingestTriggers(store, [change(), change()], 1000)
    expect(result.added).toHaveLength(1)
    expect(result.duplicates).toBe(1)
    expect(store.triggers.size).toBe(1)
  })

  test('an occurred timestamp drives the thread clock when present', async () => {
    const store = memoryStore()
    await ingestTriggers(store, [change({ occurredAt: 500 })], 9000)
    expect(store.threads.get(threadIdOf('conn-1', 'PROJ-1'))?.updatedAt).toBe(500)
    await ingestTriggers(store, [change({ occurredAt: 6000, fingerprint: 'f2' })], 9000)
    expect(store.threads.get(threadIdOf('conn-1', 'PROJ-1'))?.updatedAt).toBe(6000)
  })
})
