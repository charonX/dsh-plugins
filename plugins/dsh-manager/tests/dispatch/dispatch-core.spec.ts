/** Domain-core spec for the dispatch state machine over an in-memory port. */
import { describe, expect, test } from 'vitest'
import {
  cancelDispatch,
  enqueueDispatch,
  interruptDispatch,
  latestExternalSession,
  recordExternalSession,
  recordReport,
  startDispatch,
  type DispatchRecord,
  type DispatchStorePort,
} from '../../src/dispatch/dispatch-core.ts'

/** One in-memory dispatch store. */
function memoryStore(): DispatchStorePort & { records(): readonly DispatchRecord[] } {
  const byId = new Map<string, DispatchRecord>()
  return {
    getDispatch: id => byId.get(id),
    putDispatch: async record => { byId.set(record.id, record) },
    listDispatches: () => [...byId.values()],
    records: () => [...byId.values()],
  }
}

describe('dispatch state machine', () => {
  test('enqueue creates a queued dispatch bound to its ticket', async () => {
    const store = memoryStore()
    const record = await enqueueDispatch(store, 'ticket-1', 100)
    expect(record).toMatchObject({ ticketId: 'ticket-1', state: 'queued', createdAt: 100, updatedAt: 100 })
    expect(record.reports).toEqual([])
    expect(record.id).toMatch(/^dispatch-/)
    expect(store.listDispatches()).toHaveLength(1)
  })

  test('start moves queued to running under its session; a second start is refused', async () => {
    const store = memoryStore()
    const record = await enqueueDispatch(store, 'ticket-1', 100)
    const started = await startDispatch(store, record.id, 'thr-exec', 200)
    expect(started).toMatchObject({ state: 'running', sessionId: 'thr-exec', updatedAt: 200 })
    expect(await startDispatch(store, record.id, 'thr-again', 300)).toBeUndefined()
    expect(store.getDispatch(record.id)?.sessionId).toBe('thr-exec')
  })

  test('a non-terminal report keeps the dispatch running and appends history', async () => {
    const store = memoryStore()
    const record = await enqueueDispatch(store, 'ticket-1', 100)
    await startDispatch(store, record.id, 'thr-exec', 150)
    expect((await recordReport(store, record.id, 'progress', 'reading the code', 200))?.reports).toHaveLength(1)
    expect((await recordReport(store, record.id, 'waiting', 'awaiting review input', 300))?.state).toBe('running')
    expect((await recordReport(store, record.id, 'blocked', 'missing credentials', 400))?.state).toBe('running')
    const final = store.getDispatch(record.id)
    expect(final?.state).toBe('running')
    expect(final?.outcome).toBeUndefined()
    expect(final?.reports.map(report => report.kind)).toEqual(['progress', 'waiting', 'blocked'])
  })

  test('a terminal report ends the dispatch with its outcome', async () => {
    const store = memoryStore()
    for (const kind of ['ready', 'failed', 'not-needed'] as const) {
      const record = await enqueueDispatch(store, `ticket-${kind}`, 100)
      await startDispatch(store, record.id, 'thr-exec', 150)
      const updated = await recordReport(store, record.id, kind, `${kind} message`, 200)
      expect(updated).toMatchObject({ state: 'ended', outcome: kind })
    }
  })

  test('a report on an ended dispatch is refused', async () => {
    const store = memoryStore()
    const record = await enqueueDispatch(store, 'ticket-1', 100)
    await startDispatch(store, record.id, 'thr-exec', 150)
    await recordReport(store, record.id, 'ready', 'done', 200)
    expect(await recordReport(store, record.id, 'progress', 'late', 300)).toBeUndefined()
    expect(store.getDispatch(record.id)?.reports).toHaveLength(1)
  })

  test('interrupt marks only a running dispatch; queued and ended are untouched', async () => {
    const store = memoryStore()
    const queued = await enqueueDispatch(store, 'ticket-1', 100)
    expect(await interruptDispatch(store, queued.id, 200)).toBeUndefined()
    const running = await enqueueDispatch(store, 'ticket-2', 100)
    await startDispatch(store, running.id, 'thr-exec', 150)
    const interrupted = await interruptDispatch(store, running.id, 300)
    expect(interrupted).toMatchObject({ state: 'ended', outcome: 'interrupted' })
    const ended = await enqueueDispatch(store, 'ticket-3', 100)
    await startDispatch(store, ended.id, 'thr-exec', 150)
    await recordReport(store, ended.id, 'ready', 'done', 200)
    expect(await interruptDispatch(store, ended.id, 400)).toBeUndefined()
    expect(store.getDispatch(ended.id)?.outcome).toBe('ready')
  })

  test('an unknown dispatch id is refused by every transition', async () => {
    const store = memoryStore()
    expect(await startDispatch(store, 'nope', 'thr-exec', 100)).toBeUndefined()
    expect(await recordReport(store, 'nope', 'ready', 'x', 100)).toBeUndefined()
    expect(await interruptDispatch(store, 'nope', 100)).toBeUndefined()
  })

  test('the core never mutates records other than the addressed dispatch', async () => {
    const store = memoryStore()
    const first = await enqueueDispatch(store, 'ticket-1', 100)
    const second = await enqueueDispatch(store, 'ticket-2', 110)
    await startDispatch(store, first.id, 'thr-exec', 150)
    await recordReport(store, first.id, 'ready', 'done', 200)
    expect(store.getDispatch(second.id)).toMatchObject({ ticketId: 'ticket-2', state: 'queued', reports: [] })
    expect(store.getDispatch(first.id)).toMatchObject({ ticketId: 'ticket-1', state: 'ended', outcome: 'ready' })
  })

  test('recordExternalSession and latestExternalSession track sticky sessions per ticket and backend', async () => {
    const store = memoryStore()
    const first = await enqueueDispatch(store, 'ticket-1', 100)
    await startDispatch(store, first.id, 'exec-1', 110)
    await recordExternalSession(store, first.id, 'claude-code', 'sess-claude-1', 120)

    const second = await enqueueDispatch(store, 'ticket-1', 200)
    await startDispatch(store, second.id, 'exec-2', 210)
    await recordExternalSession(store, second.id, 'claude-code', 'sess-claude-2', 220)

    const otherBackend = await enqueueDispatch(store, 'ticket-1', 300)
    await startDispatch(store, otherBackend.id, 'exec-3', 310)
    await recordExternalSession(store, otherBackend.id, 'agy', 'sess-agy-1', 320)

    expect(latestExternalSession(store, 'ticket-1', 'claude-code')).toBe('sess-claude-2')
    expect(latestExternalSession(store, 'ticket-1', 'agy')).toBe('sess-agy-1')
    expect(latestExternalSession(store, 'ticket-1', 'codex')).toBeUndefined()
    expect(latestExternalSession(store, 'ticket-2', 'claude-code')).toBeUndefined()
  })

  test('cancelDispatch ends queued and running dispatches with interrupted outcome and records structured activity', async () => {
    const store = memoryStore()
    const queued = await enqueueDispatch(store, 'ticket-q', 100)
    const cancelledQueued = await cancelDispatch(store, queued.id, 120, 'stopped from queue')
    expect(cancelledQueued).toMatchObject({ state: 'ended', outcome: 'interrupted' })
    expect(cancelledQueued?.reports.at(-1)?.message).toBe('stopped from queue')

    const running = await enqueueDispatch(store, 'ticket-r', 200)
    await startDispatch(store, running.id, 'exec-r', 210)
    await recordReport(store, running.id, 'progress', 'tool: Bash: pnpm test', 220, {
      category: 'command',
      toolName: 'Bash',
      target: 'pnpm test',
    })
    expect(store.getDispatch(running.id)?.reports[0]?.activity).toEqual({
      category: 'command',
      toolName: 'Bash',
      target: 'pnpm test',
    })
    const cancelledRunning = await cancelDispatch(store, running.id, 230)
    expect(cancelledRunning).toMatchObject({ state: 'ended', outcome: 'interrupted' })
    expect(await cancelDispatch(store, running.id, 240)).toBeUndefined()
  })
})
