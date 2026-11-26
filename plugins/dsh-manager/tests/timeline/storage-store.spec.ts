/** The durable timeline: dispatch and attention transitions land in the ledger and survive a restart. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { askAttention, answerAttention } from '../../src/attention/attention-core.ts'
import { createDomainAttentionStore } from '../../src/attention/storage-store.ts'
import { boardDomain } from '../../src/board-domain.ts'
import { enqueueDispatch, recordReport, startDispatch } from '../../src/dispatch/dispatch-core.ts'
import { createDomainDispatchStore } from '../../src/dispatch/storage-store.ts'
import { createDomainTimelineStore } from '../../src/timeline/storage-store.ts'
import { appendTimelineEvent, timelineEventsOf } from '../../src/timeline/timeline-core.ts'

const roots: string[] = []
const contexts: Context[] = []
const backends: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(backends.splice(0).map(backend => backend.close()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Open the board domain over a fresh json backend rooted at `root`. */
async function openAt(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root); backends.push(backend)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const domain = await facility.open(boardDomain)
  ctx.effect(() => async () => { await domain.close() })
  return { ctx, domain }
}

test('a dispatch lifecycle writes turn-started, reports, and turn-ended in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-')); roots.push(root)
  const { domain } = await openAt(root)
  const dispatches = createDomainDispatchStore(domain)
  const timelines = createDomainTimelineStore(domain)

  const queued = await enqueueDispatch(dispatches, 'ticket-1', 100)
  await startDispatch(dispatches, queued.id, 'dsh-manager-exec-1', 110)
  await recordReport(dispatches, queued.id, 'progress', '开始改代码', 120, { category: 'message' })
  await recordReport(dispatches, queued.id, 'progress', 'Edit src/index.ts', 130, { category: 'tool', toolName: 'Edit' })
  await recordReport(dispatches, queued.id, 'ready', '改完并跑过测试', 200)

  const events = timelineEventsOf(timelines, 'ticket-1')
  expect(events.map(event => [event.code, event.kind, event.seq])).toEqual([
    ['turn-started', 'system', 0],
    ['report-progress', 'assistant', 1],
    ['report-progress', 'tool', 2],
    ['report-ready', 'report', 3],
    ['turn-ended:ready', 'system', 4],
  ])
  expect(events[3]?.body).toBe('改完并跑过测试')
  expect(events.every(event => event.turnId === queued.id)).toBe(true)
})

test('a queued-only dispatch writes no turn event yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-')); roots.push(root)
  const { domain } = await openAt(root)
  const dispatches = createDomainDispatchStore(domain)
  const timelines = createDomainTimelineStore(domain)

  await enqueueDispatch(dispatches, 'ticket-1', 100)
  expect(timelines.getTimeline('ticket-1')).toBeUndefined()
})

test('the ledger survives closing and reopening the domain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-')); roots.push(root)
  const first = await openAt(root)
  const dispatches = createDomainDispatchStore(first.domain)
  const dispatch = await enqueueDispatch(dispatches, 'ticket-1', 100)
  await startDispatch(dispatches, dispatch.id, 'dsh-manager-exec-1', 110)
  await first.ctx.fiber.dispose()
  contexts.length = 0

  const second = await openAt(root)
  const events = timelineEventsOf(createDomainTimelineStore(second.domain), 'ticket-1')
  expect(events.map(event => event.code)).toEqual(['turn-started'])
})

test('attention asks and answers are mirrored with the human as author', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-')); roots.push(root)
  const { domain } = await openAt(root)
  const attentions = createDomainAttentionStore(domain)
  const timelines = createDomainTimelineStore(domain)

  const asked = await askAttention(attentions, {
    ticketId: 'ticket-1',
    dispatchId: 'dispatch-1',
    question: '要不要改 approval policy？',
    details: '影响面比较大',
  }, 120)
  await answerAttention(attentions, asked.id, '按工单配置', 160)

  const events = timelineEventsOf(timelines, 'ticket-1')
  expect(events.map(event => [event.kind, event.author, event.code])).toEqual([
    ['attention', 'executor', 'attention-question'],
    ['instruction', 'user', 'answered'],
  ])
  expect(events[1]?.body).toBe('按工单配置')
  expect(events[1]?.attentionId).toBe(asked.id)
})

test('a version-1 board opens, reads its tickets, and restamps on the first ledger write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-')); roots.push(root)
  const file = join(root, 'dsh_manager_board.json')
  await writeFile(file, JSON.stringify({
    unit: { name: 'dsh_manager_board', version: 1 },
    global: null,
    tables: {
      tickets: {
        'ticket-1': { id: 'ticket-1', title: '老工单', state: 'ended', createdAt: 1, updatedAt: 2 },
      },
    },
  }), 'utf8')

  const { domain } = await openAt(root)
  expect([...domain.table('tickets').entries()].map(([id]) => id)).toEqual(['ticket-1'])
  expect(domain.table('timelines').get('ticket-1' as never)).toBeUndefined()

  await appendTimelineEvent(createDomainTimelineStore(domain), {
    ticketId: 'ticket-1', kind: 'system', author: 'system', at: 3, code: 'finished',
  })
  const stored = JSON.parse(await readFile(file, 'utf8')) as { unit: { version: number }, tables: Record<string, unknown> }
  expect(stored.unit.version).toBe(2)
  expect(Object.keys(stored.tables)).toContain('timelines')
})
