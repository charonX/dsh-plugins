/** The storage-domain adapter of the effect store: durable, change-emitting, restart-safe. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { effectsDomain, type EffectRecord } from '../../src/effects/effects-domain.ts'
import { createDomainEffectStore } from '../../src/effects/storage-store.ts'

const roots: string[] = []
const contexts: Context[] = []
const backends: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(backends.splice(0).map(backend => backend.close()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Open the effects domain over a fresh json backend rooted at `root`. */
async function openAt(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); backends.push(backend)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const domain = await facility.open(effectsDomain)
  ctx.effect(() => async () => { await domain.close() })
  return { ctx, domain }
}

function recordOf(id: string, overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    id, kind: 'test', payload: {}, status: 'pending',
    attempts: 0, nextAttemptAt: 0, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

test('put persists, list reads back, and the change event reaches subscribers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-effects-store-')); roots.push(root)
  const { ctx, domain } = await openAt(root)
  const store = createDomainEffectStore(ctx, domain)
  const listener = vi.fn()
  store.subscribe(listener)
  const record = recordOf('one', { payload: { value: 1 } })
  await store.put(record)
  expect(store.list()).toEqual([record])
  expect(listener).toHaveBeenCalledExactlyOnceWith()
})

test('records survive close and reopen over the same root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-effects-store-')); roots.push(root)
  const first = await openAt(root)
  const store = createDomainEffectStore(first.ctx, first.domain)
  await store.put(recordOf('survivor', { status: 'in-flight', attempts: 1 }))
  await first.ctx.fiber.dispose()
  contexts.length = 0
  const second = await openAt(root)
  const reloaded = createDomainEffectStore(second.ctx, second.domain)
  expect(reloaded.list()).toEqual([
    { ...recordOf('survivor', { status: 'in-flight', attempts: 1 }) },
  ])
})
