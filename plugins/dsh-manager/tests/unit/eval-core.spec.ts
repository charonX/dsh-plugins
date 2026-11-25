/** Eval domain-core spec: serial evals, batching, idempotent acceptance. */
import { describe, expect, test } from 'vitest'
import {
  abandonEval, defaultAcceptPolicy, dropRunningEvals, finishEval, pendingBacklog, startEval,
  type EvalStorePort,
} from '../../src/evals/eval-core.ts'
import type { EvalRecord, TicketRecord } from '../../src/board-domain.ts'

/** An in-memory store the core drives. */
function memoryStore(): EvalStorePort & { evals: Map<string, EvalRecord>; tickets: Map<string, TicketRecord> } {
  const evals = new Map<string, EvalRecord>()
  const tickets = new Map<string, TicketRecord>()
  return {
    evals,
    tickets,
    getEval(id) { return evals.get(id) },
    async putEval(record) { evals.set(record.id, record) },
    listThreadEvals(threadId) {
      return [...evals.values()].filter(record => record.threadId === threadId)
    },
    listEvals() { return [...evals.values()] },
    getTicket(id) { return tickets.get(id) },
    async putTicket(record) { tickets.set(record.id, record) },
    listTickets() { return [...tickets.values()] },
  }
}

const ACCEPT = {
  action: 'accept' as const,
  strength: 'explicit' as const,
  title: 'Fix the login flow',
  scope: 'project alpha',
  rationale: 'the issue explicitly asks for a fix',
}

describe('pendingBacklog', () => {
  test('groups unevaluated triggers per thread in arrival order', () => {
    const backlog = pendingBacklog([
      { id: 'trg-1', threadId: 'thr-1' },
      { id: 'trg-2', threadId: 'thr-2' },
      { id: 'trg-3', threadId: 'thr-1' },
    ], [])
    expect(backlog).toEqual([
      { threadId: 'thr-1', triggerIds: ['trg-1', 'trg-3'] },
      { threadId: 'thr-2', triggerIds: ['trg-2'] },
    ])
  })

  test('triggers covered by a settled or running eval are not pending', () => {
    const evals: EvalRecord[] = [{
      id: 'eval-1', threadId: 'thr-1', triggerIds: ['trg-1'], status: 'accepted',
      startedAt: 0, finishedAt: 1, policyVersion: '1',
    }]
    const backlog = pendingBacklog([
      { id: 'trg-1', threadId: 'thr-1' },
      { id: 'trg-2', threadId: 'thr-1' },
    ], evals)
    expect(backlog).toEqual([{ threadId: 'thr-1', triggerIds: ['trg-2'] }])
  })

  test('a failed eval re-queues its triggers for the next batch', () => {
    const evals: EvalRecord[] = [{
      id: 'eval-1', threadId: 'thr-1', triggerIds: ['trg-1'], status: 'failed',
      startedAt: 0, finishedAt: 1, policyVersion: '1',
    }]
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], evals)
    expect(backlog).toEqual([{ threadId: 'thr-1', triggerIds: ['trg-1'] }])
  })

  test('an incomplete eval retires its triggers', () => {
    const evals: EvalRecord[] = [{
      id: 'eval-1', threadId: 'thr-1', triggerIds: ['trg-1'], status: 'incomplete',
      startedAt: 0, finishedAt: 1, policyVersion: '1',
    }]
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], evals)
    expect(backlog).toEqual([])
  })

  test('a thread with a live ticket is subscribed: its triggers skip the eval backlog', () => {
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], [], [
      { threadId: 'thr-1', state: 'running' },
    ])
    expect(backlog).toEqual([])
  })

  test('a todo or attention ticket subscribes too, but an ended one does not', () => {
    const todo = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], [], [
      { threadId: 'thr-1', state: 'todo' },
    ])
    expect(todo).toEqual([])
    const attention = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], [], [
      { threadId: 'thr-1', state: 'attention' },
    ])
    expect(attention).toEqual([])
    // After the ticket ends, fresh work on the thread evaluates again.
    const ended = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], [], [
      { threadId: 'thr-1', state: 'ended' },
    ])
    expect(ended).toEqual([{ threadId: 'thr-1', triggerIds: ['trg-1'] }])
  })

  test('other threads stay pending while a subscribed thread skips', () => {
    const backlog = pendingBacklog([
      { id: 'trg-1', threadId: 'thr-1' },
      { id: 'trg-2', threadId: 'thr-2' },
    ], [], [{ threadId: 'thr-1', state: 'todo' }])
    expect(backlog).toEqual([{ threadId: 'thr-2', triggerIds: ['trg-2'] }])
  })
})

describe('startEval', () => {
  test('one thread runs at most one eval at a time', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    await expect(startEval(store, 'thr-1', ['trg-2'], 'eval-2', 2000)).rejects.toThrow('already has a running eval')
  })

  test('a finished eval frees the thread for the next batch', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    await finishEval(store, 'eval-1', { ...ACCEPT, action: 'ignore' }, undefined, 'auto', 1500)
    const second = await startEval(store, 'thr-1', ['trg-2'], 'eval-2', 2000)
    expect(second.triggerIds).toEqual(['trg-2'])
  })

  test('different threads evaluate concurrently', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const other = await startEval(store, 'thr-2', ['trg-9'], 'eval-2', 1000)
    expect(other.threadId).toBe('thr-2')
  })

  test('the eval records the Policy version it runs under', async () => {
    const store = memoryStore()
    const record = await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000, '2')
    expect(record.policyVersion).toBe('2')
    const defaulted = await startEval(store, 'thr-2', ['trg-9'], 'eval-2', 1000)
    expect(defaulted.policyVersion).toBe('1')
  })
})

describe('finishEval', () => {
  test('an accepted explicit decision mints a todo ticket carrying the mandate', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(store, 'eval-1', ACCEPT, undefined, 'auto', 1500)
    expect(finished.status).toBe('accepted')
    expect(finished.ticketId).toBe('ticket-eval-1')
    expect(ticket).toMatchObject({
      title: 'Fix the login flow',
      threadId: 'thr-1',
      state: 'todo',
    })
    expect(ticket?.mandate).toEqual({ strength: 'explicit', scope: 'project alpha', policyVersion: '1' })
  })

  test('the mandate carries the Policy version the eval ran under', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000, '2')
    const { ticket } = await finishEval(store, 'eval-1', ACCEPT, undefined, 'auto', 1500)
    expect(ticket?.mandate).toMatchObject({ policyVersion: '2' })
  })

  test('the minted ticket carries its external origin facts', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { ticket } = await finishEval(store, 'eval-1', ACCEPT, undefined, 'auto', 1500, {
      sourceConnectionId: 'conn-1', externalKey: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1',
    })
    expect(ticket).toMatchObject({
      sourceConnectionId: 'conn-1',
      externalKey: 'PROJ-1',
      url: 'https://jira.example.com/browse/PROJ-1',
    })
  })

  test('accepting the same triggers twice reuses one ticket', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const first = await finishEval(store, 'eval-1', ACCEPT, undefined, 'auto', 1500)
    // Triggers arrive again (duplicates) and a second eval accepts them.
    await startEval(store, 'thr-1', ['trg-1', 'trg-2'], 'eval-2', 2000)
    const second = await finishEval(store, 'eval-2', ACCEPT, undefined, 'auto', 2500)
    expect(second.ticket?.id).toBe(first.ticket?.id)
    expect(store.tickets.size).toBe(1)
  })

  test('an ignore decision finishes without a ticket', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(
      store, 'eval-1',
      { action: 'ignore', strength: 'inferred', rationale: 'not actionable' },
      undefined, 'auto', 1500,
    )
    expect(finished.status).toBe('rejected')
    expect(ticket).toBeUndefined()
    expect(store.tickets.size).toBe(0)
  })

  test('a stop decision finishes without a ticket', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(
      store, 'eval-1',
      { action: 'stop', strength: 'explicit', rationale: 'the work must not proceed' },
      undefined, 'auto', 1500,
    )
    expect(finished.status).toBe('rejected')
    expect(ticket).toBeUndefined()
    expect(store.tickets.size).toBe(0)
  })

  test('the default policy auto-accepts explicit evidence but never inferred evidence', () => {
    expect(defaultAcceptPolicy('explicit', 'auto')).toBe('accept')
    expect(defaultAcceptPolicy('explicit', 'confirm')).toBe('ask')
    expect(defaultAcceptPolicy('inferred', 'auto')).toBe('ask')
    expect(defaultAcceptPolicy('inferred', 'confirm')).toBe('ask')
    // Observe offers everything to a human; off offers nothing.
    expect(defaultAcceptPolicy('explicit', 'observe')).toBe('ask')
    expect(defaultAcceptPolicy('inferred', 'observe')).toBe('ask')
    expect(defaultAcceptPolicy('explicit', 'off')).toBe('reject')
    expect(defaultAcceptPolicy('inferred', 'off')).toBe('reject')
  })

  test('an inferred strength in auto mode lands as a candidate, without a ticket', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(
      store, 'eval-1',
      { ...ACCEPT, strength: 'inferred' },
      undefined, 'auto', 1500,
    )
    expect(finished.status).toBe('candidate')
    expect(ticket).toBeUndefined()
    expect(store.tickets.size).toBe(0)
    // A candidate covers its triggers: no re-eval while it waits.
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], store.listEvals())
    expect(backlog).toEqual([])
  })

  test('observe mode offers even explicit evidence as a candidate', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(store, 'eval-1', ACCEPT, undefined, 'observe', 1500)
    expect(finished.status).toBe('candidate')
    expect(ticket).toBeUndefined()
  })

  test('off mode declines acceptance without producing a candidate', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const { eval: finished, ticket } = await finishEval(store, 'eval-1', ACCEPT, undefined, 'off', 1500)
    expect(finished.status).toBe('rejected')
    expect(ticket).toBeUndefined()
    expect(store.tickets.size).toBe(0)
  })

  test('a human-confirmed candidate mints its ticket with an explicit mandate', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    await finishEval(store, 'eval-1', { ...ACCEPT, strength: 'inferred' }, undefined, 'auto', 1500)
    // The user accepts the candidate: the always-accept policy mints now.
    const { eval: finished, ticket } = await finishEval(
      store, 'eval-1',
      { ...ACCEPT, strength: 'inferred', title: 'Fix the login flow' },
      () => 'accept', 'auto', 2000,
    )
    expect(finished.status).toBe('accepted')
    expect(ticket).toMatchObject({
      title: 'Fix the login flow',
      state: 'todo',
      mandate: { strength: 'explicit', scope: 'project alpha', policyVersion: '1' },
    })
  })

  test('finishing a non-running eval is an error', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    await finishEval(store, 'eval-1', { ...ACCEPT, action: 'ignore' }, undefined, 'auto', 1500)
    await expect(finishEval(store, 'eval-1', ACCEPT, undefined, 'auto', 2000)).rejects.toThrow('not running')
    await expect(finishEval(store, 'eval-404', ACCEPT, undefined, 'auto', 2000)).rejects.toThrow('does not exist')
  })
})

describe('abandonEval', () => {
  test('a failed abandon re-queues the batch triggers', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const abandoned = await abandonEval(store, 'eval-1', 'failed', 1500)
    expect(abandoned.status).toBe('failed')
    expect(abandoned.finishedAt).toBe(1500)
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], store.listEvals())
    expect(backlog).toEqual([{ threadId: 'thr-1', triggerIds: ['trg-1'] }])
  })

  test('an incomplete abandon retires the batch triggers', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    const abandoned = await abandonEval(store, 'eval-1', 'incomplete', 1500)
    expect(abandoned.status).toBe('incomplete')
    const backlog = pendingBacklog([{ id: 'trg-1', threadId: 'thr-1' }], store.listEvals())
    expect(backlog).toEqual([])
  })

  test('abandoning a non-running eval is an error', async () => {
    const store = memoryStore()
    await expect(abandonEval(store, 'eval-404', 'failed', 1000)).rejects.toThrow('does not exist')
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000)
    await abandonEval(store, 'eval-1', 'failed', 1500)
    await expect(abandonEval(store, 'eval-1', 'incomplete', 2000)).rejects.toThrow('not running')
  })
})

describe('dropRunningEvals', () => {
  test('a policy version change retires running evals from other versions and re-queues their triggers', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000, '1')
    await startEval(store, 'thr-2', ['trg-2'], 'eval-2', 1000, '2')
    const dropped = await dropRunningEvals(store, '2', 1500)
    expect(dropped.map(record => record.id)).toEqual(['eval-1'])
    // A `failed` drop is inconclusive: the batch re-queues under the new version.
    expect(dropped[0]?.status).toBe('failed')
    // The current-version eval still runs; the dropped batch re-queues.
    expect(store.getEval('eval-2')?.status).toBe('running')
    const backlog = pendingBacklog([
      { id: 'trg-1', threadId: 'thr-1' },
      { id: 'trg-2', threadId: 'thr-2' },
    ], store.listEvals())
    expect(backlog).toEqual([{ threadId: 'thr-1', triggerIds: ['trg-1'] }])
  })

  test('an all-current sweep drops nothing', async () => {
    const store = memoryStore()
    await startEval(store, 'thr-1', ['trg-1'], 'eval-1', 1000, '2')
    const dropped = await dropRunningEvals(store, '2', 1500)
    expect(dropped).toEqual([])
    expect(store.getEval('eval-1')?.status).toBe('running')
  })
})
