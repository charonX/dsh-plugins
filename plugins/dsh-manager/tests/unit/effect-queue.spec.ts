/** The effect queue domain core: state transitions over the store port, in memory. */
import { describe, expect, test, vi } from 'vitest'
import { createEffectQueue, type EffectRecord, type EffectStorePort } from '../../src/effects/effect-queue.ts'

/** One effect in flight, as the deliverer sees it. */
type Delivery = { id: string; kind: string; payload: unknown }

const WAIT_OPTS = { timeout: 5_000, interval: 20 } as const

/** Fresh pending record with a stable id for one test scenario. */
function pendingOf(id: string, overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    id,
    kind: 'test',
    payload: { value: id },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

/** In-memory store port recording every write for assertions. */
function memoryStore(records: EffectRecord[] = []): EffectStorePort & { writes: EffectRecord[] } {
  const byId = new Map(records.map(record => [record.id, record]))
  const listeners = new Set<() => void>()
  return {
    writes: [],
    list: () => [...byId.values()],
    async put(record) {
      byId.set(record.id, record)
      this.writes.push(record)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

describe('effect queue', () => {
  test('a delivered effect settles to done', async () => {
    const store = memoryStore()
    const deliver = vi.fn(async () => {})
    const queue = createEffectQueue({ store, deliver, now: () => 1000 })
    const id = await queue.enqueue({ kind: 'test', payload: { value: 'a' } })
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === id)?.status).toBe('done')
    }, WAIT_OPTS)
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ id, kind: 'test', payload: { value: 'a' } })
    expect(store.list().map(record => [record.id, record.status])).toEqual([[id, 'done']])
    await queue.stop()
  })

  test('a failing delivery backs off and retries, then settles to done', async () => {
    const store = memoryStore()
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error('first try fails'))
      .mockRejectedValueOnce(new Error('second try fails'))
      .mockResolvedValue(undefined)
    const backoffMs = vi.fn(() => 5)
    const queue = createEffectQueue({ store, deliver, backoffMs })
    const id = await queue.enqueue({ kind: 'test', payload: {} })
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === id)?.status).toBe('done')
    }, WAIT_OPTS)
    expect(deliver).toHaveBeenCalledTimes(3)
    expect(backoffMs).toHaveBeenCalledWith(1)
    expect(backoffMs).toHaveBeenCalledWith(2)
    const failedWrites = store.writes.filter(record => record.id === id && record.status === 'pending' && record.attempts > 0)
    expect(failedWrites).toHaveLength(2)
    expect(failedWrites[0]).toMatchObject({ attempts: 1, lastError: 'first try fails' })
    expect(failedWrites[1]).toMatchObject({ attempts: 2, lastError: 'second try fails' })
    await queue.stop()
  })

  test('retries past the attempt cap settle to failed and stay queryable', async () => {
    const store = memoryStore()
    const deliver = vi.fn(async () => { throw new Error('always fails') })
    const queue = createEffectQueue({ store, deliver, backoffMs: () => 5, maxAttempts: 2 })
    const id = await queue.enqueue({ kind: 'test', payload: {} })
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === id)?.status).toBe('failed')
    }, WAIT_OPTS)
    expect(deliver).toHaveBeenCalledTimes(2)
    const failed = store.list().find(record => record.id === id)
    expect(failed).toMatchObject({ status: 'failed', attempts: 2, lastError: 'always fails' })
    await queue.stop()
  })

  test('recover re-delivers a record the process crashed before settling', async () => {
    // The durable record is stuck in-flight; the deliverer never answered.
    const store = memoryStore([pendingOf('crashed', { status: 'in-flight', attempts: 1 })])
    const deliver = vi.fn(async () => {})
    const queue = createEffectQueue({ store, deliver, now: () => 1000 })
    await queue.recover()
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === 'crashed')?.status).toBe('done')
    }, WAIT_OPTS)
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ id: 'crashed', kind: 'test', payload: { value: 'crashed' } })
    await queue.stop()
  })

  test('recover schedules due pending records left by a crash', async () => {
    const store = memoryStore([pendingOf('due', { nextAttemptAt: 500 })])
    const deliver = vi.fn(async () => {})
    const queue = createEffectQueue({ store, deliver, now: () => 1000 })
    await queue.recover()
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === 'due')?.status).toBe('done')
    }, WAIT_OPTS)
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ id: 'due', kind: 'test', payload: { value: 'due' } })
    await queue.stop()
  })

  test('recover ignores a pending record that is not due yet', async () => {
    const store = memoryStore([pendingOf('future', { nextAttemptAt: 100_000 })])
    const deliver = vi.fn(async () => {})
    const queue = createEffectQueue({ store, deliver, now: () => 1000 })
    await queue.recover()
    expect(deliver).not.toHaveBeenCalled()
    expect(store.list().find(record => record.id === 'future')?.status).toBe('pending')
    await queue.stop()
  })

  test('an effect kind with no registered deliverer reschedules without burning attempts', async () => {
    const store = memoryStore()
    const registry = new Map<string, (delivery: Delivery) => Promise<void>>([['test', async () => {}]])
    const dispatch = vi.fn(async (delivery: Delivery) => {
      const handler = registry.get(delivery.kind)
      if (handler === undefined) throw new MissingDelivererError(delivery.kind)
      await handler(delivery)
    })
    const queue = createEffectQueue({ store, deliver: dispatch, backoffMs: () => 5 })
    // No deliverer registered for 'late' yet: enqueue, let it miss once, then register.
    const id = await queue.enqueue({ kind: 'late', payload: {} })
    await vi.waitFor(() => {
      expect(store.writes.some(record => record.id === id && record.lastError === 'no deliverer for kind: late')).toBe(true)
    }, WAIT_OPTS)
    expect(store.list().find(record => record.id === id)).toMatchObject({ status: 'pending', attempts: 0 })
    registry.set('late', async () => {})
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === id)?.status).toBe('done')
    }, WAIT_OPTS)
    expect(store.writes.filter(record => record.id === id && record.status === 'in-flight')).toHaveLength(2)
    await queue.stop()
  })

  test('stop stops scheduling without abandoning durable state', async () => {
    const store = memoryStore()
    const deliver = vi.fn(async () => { throw new Error('never succeeds') })
    const queue = createEffectQueue({ store, deliver, backoffMs: () => 5, maxAttempts: 100 })
    const id = await queue.enqueue({ kind: 'test', payload: {} })
    await vi.waitFor(() => {
      expect(store.list().find(record => record.id === id)?.attempts).toBeGreaterThan(0)
    }, WAIT_OPTS)
    const attemptsAtStop = store.list().find(record => record.id === id)!.attempts
    await queue.stop()
    const writesAfterStop = store.writes.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.writes.length).toBe(writesAfterStop)
    // The record stays queryable in its last durable state.
    expect(store.list().find(record => record.id === id)!.attempts).toBe(attemptsAtStop)
  })
})

/** Import placed last so the table above reads first. */
import { MissingDelivererError } from '../../src/effects/effect-queue.ts'
