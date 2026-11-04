import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AutoloopKernel } from '../src/core/kernel.ts'
import { IntentRouter } from '../src/core/router.ts'
import { JournalStore } from '../src/core/store.ts'
import type { AgentExecutor, AttentionRequest, Ticket } from '../src/shared/types.ts'

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

  it('defers nightly tickets and allows manual runTicketNow trigger', async () => {
    let executed = false
    const mockExecutor: AgentExecutor = {
      name: 'mock',
      execute: async () => {
        executed = true
        return { summary: 'Nightly done' }
      },
    }
    kernel.registerExecutor(mockExecutor)

    const res = await kernel.ingestEvent({
      id: 'ev-nightly',
      source: 'manual-ui',
      threadId: 'th-nightly-1',
      type: 'task.create',
      summary: '重构老旧缓存模块，夜间低峰执行节省Token',
      payload: { scheduleMode: 'nightly' },
      receivedAt: Date.now(),
    })

    const ticket = store.getTicket(res.ticketId)
    expect(ticket?.scheduleMode).toBe('nightly')

    // If current test time is not between 23:00 and 07:00, it stays pending:
    const hour = new Date().getHours()
    if (hour >= 7 && hour < 23) {
      expect(ticket?.status).toBe('pending')
      expect(executed).toBe(false)

      // Manually trigger execution via runTicketNow
      const ok = await kernel.runTicketNow(res.ticketId)
      expect(ok).toBe(true)
      expect(executed).toBe(true)
      expect(store.getTicket(res.ticketId)?.status).toBe('completed')
    }
  })
})
