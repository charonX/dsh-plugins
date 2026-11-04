import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AutoloopKernel } from '../src/core/kernel.ts'
import { IntentRouter } from '../src/core/router.ts'
import { JournalStore } from '../src/core/store.ts'
import type { AgentExecutor, AttentionRequest, OffpeakWindow, Ticket } from '../src/shared/types.ts'
import { ScheduleInputError } from '../src/shared/schedule.ts'

/** Let queued dispatch continuations settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** Local `HH:mm` of `now` shifted by whole hours. */
function clockOffset(now: Date, hours: number): string {
  const shifted = new Date(now.getTime() + hours * 3_600_000)
  return `${String(shifted.getHours()).padStart(2, '0')}:${String(shifted.getMinutes()).padStart(2, '0')}`
}

/** Window that never contains the current instant. */
function closedWindow(): OffpeakWindow {
  const now = new Date()
  return { start: clockOffset(now, 1), end: clockOffset(now, 2) }
}

/** Window that always contains the current instant. */
function openWindow(): OffpeakWindow {
  const now = new Date()
  return { start: clockOffset(now, -1), end: clockOffset(now, 1) }
}

describe('AutoloopKernel', () => {
  let tempDir: string
  let journalPath: string
  let store: JournalStore
  let router: IntentRouter
  let kernel: AutoloopKernel

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autoloop-kernel-test-'))
    journalPath = join(tempDir, 'journal.jsonl')
    store = new JournalStore(journalPath)
    router = new IntentRouter({ defaultWorkspacePath: '/test/workspace' })
    kernel = new AutoloopKernel({
      store,
      router,
      maxHops: 8,
      defaultWorkspacePath: '/test/workspace',
    })
  })

  afterEach(() => {
    kernel.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('ingests event, creates ticket, and dispatches to executor', async () => {
    let executedTicket: Ticket | undefined
    const mockExecutor: AgentExecutor = {
      name: 'mock',
      execute: async (ticket) => {
        executedTicket = ticket
        return { summary: 'Job done' }
      },
    }

    kernel.registerExecutor(mockExecutor)

    const res = await kernel.ingestEvent({
      id: 'ev-1',
      source: 'github',
      threadId: 'th-1',
      type: 'issue.create',
      summary: 'Fix NullPointerException in login service',
      receivedAt: Date.now(),
    })

    expect(res.action).toBe('ticket_created')
    expect(executedTicket).toBeDefined()
    expect(executedTicket?.mandate.intent).toBe('bugfix')

    const ticket = store.getTicket(res.ticketId)
    expect(ticket?.status).toBe('completed')
  })

  it('triggers hop limit circuit breaker when hop count >= maxHops', async () => {
    const res = await kernel.ingestEvent({
      id: 'ev-hop',
      source: 'agent',
      threadId: 'th-hop',
      type: 'agent.feedback',
      summary: 'Recursive trigger',
      hopCount: 8, // maxHops is 8
      receivedAt: Date.now(),
    })

    expect(res.action).toBe('circuit_broken')
    const ticket = store.getTicket(res.ticketId)
    expect(ticket?.status).toBe('circuit_broken')
  })

  it('fans out subsequent events on the same thread into the active ticket', async () => {
    let unblockExecutor: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      unblockExecutor = resolve
    })

    const mockExecutor: AgentExecutor = {
      name: 'mock',
      execute: async () => {
        await blocker
        return { summary: 'Finished' }
      },
    }

    kernel.registerExecutor(mockExecutor)

    // First event creates ticket and begins execution
    const res1 = await kernel.ingestEvent({
      id: 'ev-first',
      source: 'feishu',
      threadId: 'feishu:topic:999',
      type: 'chat.msg',
      summary: 'First user requirement',
    })

    expect(res1.action).toBe('ticket_created')

    // Second event arrives while ticket is still running
    const res2 = await kernel.ingestEvent({
      id: 'ev-second',
      source: 'feishu',
      threadId: 'feishu:topic:999',
      type: 'chat.msg',
      summary: 'Also note: we must support mobile viewports',
    })

    expect(res2.action).toBe('fanned_out')
    expect(res2.ticketId).toBe(res1.ticketId)

    const ticket = store.getTicket(res1.ticketId)
    expect(ticket?.inputs).toHaveLength(1)
    expect(ticket?.inputs[0]?.text).toContain('mobile viewports')

    unblockExecutor()
  })

  it('suspends execution on attention and resumes when resolved', async () => {
    let attentionReceived: AttentionRequest | undefined
    kernel.registerChannel({
      name: 'test-channel',
      sendAttention: async (attn) => {
        attentionReceived = attn
      },
    })

    const mockExecutor: AgentExecutor = {
      name: 'mock',
      execute: async (ticket) => {
        if (!ticket.attention || ticket.attention.status !== 'resolved') {
          await kernel.raiseAttention(ticket.id, {
            title: 'Permission check',
            question: 'Confirm database migration?',
            options: [
              { label: 'Approve', value: 'approved' },
              { label: 'Reject', value: 'rejected' },
            ],
          })
          return { summary: 'Suspended' }
        }
        return { summary: 'Migrated successfully with answer: ' + ticket.attention.resolvedAnswer }
      },
    }

    kernel.registerExecutor(mockExecutor)

    const res = await kernel.ingestEvent({
      id: 'ev-attn',
      source: 'cron',
      threadId: 'th-attn',
      type: 'migration.check',
      summary: 'Run DB migration',
    })

    // Ticket should now be suspended waiting for attention
    const ticketSuspended = store.getTicket(res.ticketId)
    expect(ticketSuspended?.status).toBe('waiting_attention')
    expect(attentionReceived?.question).toBe('Confirm database migration?')

    // Resolve attention with approval
    await kernel.resolveAttention(res.ticketId, 'approved')

    const ticketCompleted = store.getTicket(res.ticketId)
    expect(ticketCompleted?.status).toBe('completed')
    expect(ticketCompleted?.assignment?.resultSummary).toContain('approved')
  })

  it('attaches comprehensive router triage log to created ticket', async () => {
    const res = await kernel.ingestEvent({
      id: 'ev-triage',
      source: 'feishu',
      threadId: 'th-triage-1',
      type: 'task.create',
      summary: '紧急修复生产环境 Sentry 报错',
      receivedAt: Date.now(),
    })

    const ticket = store.getTicket(res.ticketId)
    expect(ticket).toBeDefined()
    expect(ticket?.priority).toBe('p0')
    expect(ticket?.mandate.intent).toBe('bugfix')
    expect(ticket?.triage).toBeDefined()
    expect(ticket?.triage?.categoryLabel).toBe('缺陷修复')
    expect(ticket?.triage?.reasoning).toContain('Router 智能研判日志')
    expect(ticket?.triage?.matchedRules.length).toBeGreaterThan(0)
  })

  it('dynamically infers non-dev categories, domain tags, and sources', async () => {
    const res = await kernel.ingestEvent({
      id: 'ev-ppt',
      source: 'auto',
      threadId: 'th-ppt-1',
      type: 'task.create',
      summary: '[PPT 标准化] 替换双十一宣传活动主题页面与桌面壁纸',
      receivedAt: Date.now(),
    })

    const ticket = store.getTicket(res.ticketId)
    expect(ticket).toBeDefined()
    expect(ticket?.tags).toContain('PPT 标准化')
    expect(ticket?.triage?.categoryLabel).toBe('PPT设计')
  })

  it('defers offpeak tickets outside the configured window and honors a manual run', async () => {
    let executed = false
    const scoped = new AutoloopKernel({
      store,
      router,
      defaultWorkspacePath: '/test/workspace',
      offpeak: closedWindow(),
    })
    scoped.registerExecutor({
      name: 'mock',
      execute: async () => {
        executed = true
        return { summary: 'Off-peak done' }
      },
    })

    const res = await scoped.ingestEvent({
      id: 'ev-offpeak',
      source: 'manual-ui',
      threadId: 'th-offpeak-1',
      type: 'task.create',
      summary: '重构老旧缓存模块，夜间低峰执行节省Token',
      receivedAt: Date.now(),
    })

    const ticket = store.getTicket(res.ticketId)
    expect(ticket?.scheduleMode).toBe('offpeak')
    expect(ticket?.status).toBe('pending')
    expect(executed).toBe(false)
    const queued = scoped.getStateSnapshot({ doneLimit: 1 })
    expect(queued.offpeak.open).toBe(false)
    // Active work is returned whole; only finished tickets are paged.
    expect(queued.active.map(t => t.id)).toContain(res.ticketId)

    const ok = await scoped.runTicketNow(res.ticketId)
    expect(ok).toBe(true)
    await flush()
    expect(executed).toBe(true)
    expect(store.getTicket(res.ticketId)?.status).toBe('completed')
    // The manual run must not rewrite the ticket's timing plan.
    expect(store.getTicket(res.ticketId)?.scheduleMode).toBe('offpeak')

    scoped.stop()
  })

  it('starts offpeak tickets inside the configured window', async () => {
    const scoped = new AutoloopKernel({
      store,
      router,
      defaultWorkspacePath: '/test/workspace',
      offpeak: openWindow(),
    })
    scoped.registerExecutor({ name: 'mock', execute: async () => ({ summary: 'ran' }) })

    const res = await scoped.ingestEvent({
      id: 'ev-offpeak-open',
      source: 'manual-ui',
      threadId: 'th-offpeak-open',
      type: 'task.create',
      summary: '闲时执行的任务',
      payload: { scheduleMode: 'offpeak' },
      receivedAt: Date.now(),
    })

    await flush()
    expect(scoped.getStateSnapshot().offpeak.open).toBe(true)
    expect(store.getTicket(res.ticketId)?.status).toBe('completed')
    scoped.stop()
  })

  it('rejects a scheduled ticket whose instant is missing or past', async () => {
    await expect(kernel.ingestEvent({
      id: 'ev-sched-past',
      source: 'manual-ui',
      threadId: 'th-sched-past',
      type: 'task.create',
      summary: '定时任务',
      payload: { scheduleMode: 'scheduled', scheduledAt: Date.now() - 60_000 },
      receivedAt: Date.now(),
    })).rejects.toThrow(ScheduleInputError)

    await expect(kernel.ingestEvent({
      id: 'ev-sched-none',
      source: 'manual-ui',
      threadId: 'th-sched-none',
      type: 'task.create',
      summary: '定时任务',
      payload: { scheduleMode: 'scheduled' },
      receivedAt: Date.now(),
    })).rejects.toThrow(/scheduledAt/u)
  })

  it('keeps a scheduled ticket pending until its committed instant', async () => {
    let executed = false
    kernel.registerExecutor({
      name: 'mock',
      execute: async () => {
        executed = true
        return { summary: 'ran' }
      },
    })

    const at = Date.now() + 3_600_000
    const res = await kernel.ingestEvent({
      id: 'ev-sched-future',
      source: 'manual-ui',
      threadId: 'th-sched-future',
      type: 'task.create',
      summary: '定时任务',
      payload: { scheduleMode: 'scheduled', scheduledAt: at },
      receivedAt: Date.now(),
    })

    const ticket = store.getTicket(res.ticketId)
    expect(ticket?.scheduleMode).toBe('scheduled')
    expect(ticket?.scheduledAt).toBe(at)
    expect(ticket?.status).toBe('pending')
    expect(executed).toBe(false)

    // A manual run bypasses the wait without clearing the committed instant.
    await kernel.runTicketNow(res.ticketId)
    await flush()
    expect(executed).toBe(true)
    expect(store.getTicket(res.ticketId)?.scheduledAt).toBe(at)
  })

  it('holds tickets beyond the concurrency ceiling until a slot frees up', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const scoped = new AutoloopKernel({
      store,
      router,
      defaultWorkspacePath: '/test/workspace',
      maxConcurrent: 1,
    })
    scoped.registerExecutor({
      name: 'mock',
      execute: async (ticket) => {
        started.push(ticket.id)
        await gate
        return { summary: 'done' }
      },
    })

    const first = await scoped.ingestEvent({
      id: 'ev-c1', source: 'manual-ui', threadId: 'th-c1', type: 'task.create', summary: '第一个任务',
    })
    const second = await scoped.ingestEvent({
      id: 'ev-c2', source: 'manual-ui', threadId: 'th-c2', type: 'task.create', summary: '第二个任务',
    })
    await flush()

    expect(started).toEqual([first.ticketId])
    expect(store.getTicket(first.ticketId)?.status).toBe('running')
    expect(store.getTicket(second.ticketId)?.status).toBe('pending')
    expect(scoped.getStateSnapshot().limits).toEqual({ maxConcurrent: 1, runningCount: 1 })

    release()
    await flush()
    expect(store.getTicket(first.ticketId)?.status).toBe('completed')

    // The next admission sweep hands the free slot to the older pending ticket.
    const third = await scoped.ingestEvent({
      id: 'ev-c3', source: 'manual-ui', threadId: 'th-c3', type: 'task.create', summary: '第三个任务',
    })
    await flush()
    expect(store.getTicket(second.ticketId)?.status).toBe('completed')
    expect(store.getTicket(third.ticketId)?.status).toBe('pending')
    scoped.stop()
  })

  it('requeues tickets left running by a previous run', async () => {
    const orphan: Ticket = {
      id: 'tk-orphan',
      threadId: 'th-orphan',
      title: 'Interrupted task',
      source: 'manual-ui',
      status: 'running',
      priority: 'p1',
      scheduleMode: 'immediate',
      mandate: {
        intent: 'general',
        workspacePath: '/test/workspace',
        model: { model: 'deepseek-chat' },
        skills: [],
        instruction: 'Finish the interrupted work',
      },
      workspace: { sourceRoot: '/test/workspace' },
      assignment: { assignmentId: 'as-orphan', startedAt: 1000 },
      inputs: [],
      hopCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    }
    writeFileSync(
      journalPath,
      `${JSON.stringify({ type: 'ticket.created', ticket: orphan, at: 1000 })}\n`
      + `${JSON.stringify({ type: 'ticket.assignment_started', ticketId: orphan.id, assignment: orphan.assignment, at: 1100 })}\n`,
      'utf8',
    )

    const recoveredStore = new JournalStore(journalPath)
    const scoped = new AutoloopKernel({ store: recoveredStore, router, defaultWorkspacePath: '/test/workspace' })
    scoped.registerExecutor({ name: 'mock', execute: async () => ({ summary: 'resumed' }) })
    await flush()

    expect(recoveredStore.getTicket(orphan.id)?.status).toBe('completed')
    expect(recoveredStore.getTicket(orphan.id)?.assignment?.resultSummary).toBe('resumed')
    scoped.stop()
  })

  it('retries a failed ticket', async () => {
    let succeed = false
    kernel.registerExecutor({
      name: 'mock',
      execute: async () => (succeed ? { summary: 'recovered' } : { error: 'boom' }),
    })

    const res = await kernel.ingestEvent({
      id: 'ev-fail', source: 'manual-ui', threadId: 'th-fail', type: 'task.create', summary: '会失败的改造',
    })
    await flush()
    expect(store.getTicket(res.ticketId)?.status).toBe('failed')

    expect(await kernel.retryTicket(res.ticketId)).toBe(true)
    await flush()
    expect(store.getTicket(res.ticketId)?.status).toBe('failed')

    succeed = true
    expect(await kernel.retryTicket(res.ticketId)).toBe(true)
    await flush()
    expect(store.getTicket(res.ticketId)?.status).toBe('completed')
    expect(store.getTicket(res.ticketId)?.assignment?.resultSummary).toBe('recovered')

    // Completed tickets are not retryable.
    expect(await kernel.retryTicket(res.ticketId)).toBe(false)
  })

  it('publishes the configured window and dispatch ceiling', () => {
    const snapshot = kernel.getStateSnapshot()
    expect(snapshot.offpeak.start).toBe('23:00')
    expect(snapshot.offpeak.end).toBe('07:00')
    expect(snapshot.limits.maxConcurrent).toBe(2)
  })
  it('reschedules a queued ticket and refuses a finished one', async () => {
    const scoped = new AutoloopKernel({
      store,
      router,
      defaultWorkspacePath: '/test/workspace',
      offpeak: closedWindow(),
    })
    const res = await scoped.ingestEvent({
      id: 'ev-reschedule', source: 'manual-ui', threadId: 'th-reschedule', type: 'task.create', summary: '调整执行时机',
    })
    expect(store.getTicket(res.ticketId)?.status).toBe('pending')

    const at = Date.now() + 7_200_000
    expect(await scoped.rescheduleTicket(res.ticketId, 'scheduled', at)).toBe(true)
    const updated = store.getTicket(res.ticketId)
    expect(updated?.scheduleMode).toBe('scheduled')
    expect(updated?.scheduledAt).toBe(at)
    expect(updated?.status).toBe('pending')

    await expect(scoped.rescheduleTicket(res.ticketId, 'scheduled', Date.now() - 1_000))
      .rejects.toThrow(ScheduleInputError)

    // A finished ticket owns no future timing to change.
    scoped.registerExecutor({ name: 'mock', execute: async () => ({ summary: 'ran' }) })
    await scoped.runTicketNow(res.ticketId)
    await flush()
    expect(store.getTicket(res.ticketId)?.status).toBe('completed')
    expect(await scoped.rescheduleTicket(res.ticketId, 'immediate')).toBe(false)
    scoped.stop()
  })
  it('pages finished tickets while returning active work whole', async () => {
    kernel.registerExecutor({ name: 'mock', execute: async () => ({ summary: 'ok' }) })
    for (let index = 0; index < 5; index += 1) {
      await kernel.ingestEvent({
        id: `ev-page-${index}`,
        source: 'manual-ui',
        threadId: `th-page-${index}`,
        type: 'task.create',
        summary: `分页任务 ${index}`,
      })
    }
    await flush()

    const first = kernel.getStateSnapshot({ doneLimit: 2 })
    expect(first.doneTotal).toBe(5)
    expect(first.done).toHaveLength(2)
    expect(first.active).toHaveLength(0)

    const second = kernel.getStateSnapshot({ doneLimit: 2, doneOffset: 2 })
    expect(second.done).toHaveLength(2)
    const seen = new Set([...first.done, ...second.done].map(ticket => ticket.id))
    expect(seen.size).toBe(4)

    // The board may ask for more than the ceiling; the kernel clamps it.
    expect(kernel.getStateSnapshot({ doneLimit: 10_000 }).done).toHaveLength(5)
    expect(kernel.getStateSnapshot({ doneLimit: 0 }).done).toHaveLength(1)
  })
})
