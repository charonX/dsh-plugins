import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { JournalStore } from '../src/core/store.ts'
import type { Ticket } from '../src/shared/types.ts'

describe('JournalStore (Event Sourcing)', () => {
  let tempDir: string
  let journalPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autoloop-store-test-'))
    journalPath = join(tempDir, 'journal.jsonl')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('records events and reconstructs ticket state on replay', () => {
    const store1 = new JournalStore(journalPath)
    const t0 = Date.now() - 3_600_000

    const initialTicket: Ticket = {
      id: 'tk-1',
      threadId: 'th-1',
      title: 'Fix auth bug',
      source: 'github',
      status: 'pending',
      priority: 'p1',
      scheduleMode: 'immediate',
      mandate: {
        intent: 'bugfix',
        workspacePath: '/mock/workspace',
        model: { model: 'deepseek-chat' },
        skills: ['diagnosing-bugs'],
        instruction: 'Fix it',
      },
      workspace: { sourceRoot: '/mock/workspace' },
      inputs: [],
      hopCount: 0,
      createdAt: t0,
      updatedAt: t0,
    }

    store1.append({ type: 'ticket.created', ticket: initialTicket, at: t0 })
    store1.append({
      type: 'ticket.input_added',
      ticketId: 'tk-1',
      input: { id: 'in-1', eventId: 'ev-1', text: 'Also check token refresh', receivedAt: 1050 },
      at: t0 + 50,
    })
    store1.append({
      type: 'ticket.assignment_started',
      ticketId: 'tk-1',
      assignment: { assignmentId: 'as-1', startedAt: 1100 },
      at: t0 + 100,
    })
    store1.append({
      type: 'ticket.attention_raised',
      ticketId: 'tk-1',
      attention: {
        id: 'at-1',
        ticketId: 'tk-1',
        title: 'Confirm',
        question: 'Deploy to prod?',
        options: [{ label: 'Yes', value: 'yes' }],
        status: 'pending',
        createdAt: 1200,
      },
      at: t0 + 200,
    })
    store1.append({
      type: 'ticket.attention_resolved',
      ticketId: 'tk-1',
      answer: 'yes',
      at: t0 + 300,
    })
    store1.append({
      type: 'ticket.assignment_ended',
      ticketId: 'tk-1',
      resultSummary: 'Done successfully',
      sessionId: 'sess-xyz-123',
      at: t0 + 400,
    })

    // Verify in-memory state of store1
    const t1 = store1.getTicket('tk-1')
    expect(t1?.status).toBe('completed')
    expect(t1?.inputs).toHaveLength(1)
    expect(t1?.attention?.status).toBe('resolved')
    expect(t1?.assignment?.resultSummary).toBe('Done successfully')
    expect(t1?.assignment?.sessionId).toBe('sess-xyz-123')

    // Create store2 pointing to same journal file to verify event-sourcing replay
    const store2 = new JournalStore(journalPath)
    const t2 = store2.getTicket('tk-1')
    expect(t2).toBeDefined()
    expect(t2?.status).toBe('completed')
    expect(t2?.inputs[0]?.text).toBe('Also check token refresh')
    expect(t2?.attention?.resolvedAnswer).toBe('yes')
    expect(t2?.assignment?.resultSummary).toBe('Done successfully')
    expect(t2?.assignment?.sessionId).toBe('sess-xyz-123')
  })
  it('folds the retired nightly mode into offpeak on replay', () => {
    const store1 = new JournalStore(journalPath)
    const legacy = {
      id: 'tk-legacy',
      threadId: 'th-legacy',
      title: 'Legacy nightly ticket',
      source: 'manual-ui',
      status: 'pending',
      priority: 'p2',
      scheduleMode: 'nightly',
      mandate: {
        intent: 'general',
        workspacePath: '/mock/workspace',
        model: { model: 'deepseek-chat' },
        skills: [],
        instruction: 'Old journal row',
      },
      workspace: { sourceRoot: '/mock/workspace' },
      inputs: [],
      hopCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    }
    store1.append({ type: 'ticket.created', ticket: legacy as unknown as Ticket, at: 1000 })

    // The alias never reaches storage or memory: readers only see the current spelling.
    const store2 = new JournalStore(journalPath)
    expect(store2.getTicket('tk-legacy')?.scheduleMode).toBe('offpeak')
  })

  it('persists and clears a committed instant through schedule_changed', () => {
    const store1 = new JournalStore(journalPath)
    store1.append({
      type: 'ticket.created',
      ticket: {
        id: 'tk-sched',
        threadId: 'th-sched',
        title: 'Scheduled ticket',
        source: 'manual-ui',
        status: 'pending',
        priority: 'p2',
        scheduleMode: 'scheduled',
        scheduledAt: 5000,
        mandate: {
          intent: 'general',
          workspacePath: '/mock/workspace',
          model: { model: 'deepseek-chat' },
          skills: [],
          instruction: 'Wait for the committed instant',
        },
        workspace: { sourceRoot: '/mock/workspace' },
        inputs: [],
        hopCount: 0,
        createdAt: 1000,
        updatedAt: 1000,
      },
      at: 1000,
    })

    store1.append({
      type: 'ticket.schedule_changed',
      ticketId: 'tk-sched',
      scheduleMode: 'scheduled',
      scheduledAt: 9000,
      at: 2000,
    })
    expect(store1.getTicket('tk-sched')?.scheduledAt).toBe(9000)

    // null clears the instant so a later mode switch cannot inherit a stale clock.
    store1.append({
      type: 'ticket.schedule_changed',
      ticketId: 'tk-sched',
      scheduleMode: 'offpeak',
      scheduledAt: null,
      at: 3000,
    })
    const replayed = new JournalStore(journalPath).getTicket('tk-sched')
    expect(replayed?.scheduleMode).toBe('offpeak')
    expect(replayed?.scheduledAt).toBeUndefined()
  })
})

/** Minimal ticket row for journal fixtures. */
function ticket(over: Partial<Ticket> & Pick<Ticket, 'id' | 'status' | 'updatedAt'>): Ticket {
  return {
    threadId: `th-${over.id}`,
    title: over.id,
    source: 'manual-ui',
    priority: 'p2',
    scheduleMode: 'immediate',
    mandate: {
      intent: 'general',
      workspacePath: '/mock/workspace',
      model: { model: 'deepseek-chat' },
      skills: [],
      instruction: 'fixture',
    },
    workspace: { sourceRoot: '/mock/workspace' },
    inputs: [],
    hopCount: 0,
    createdAt: over.updatedAt,
    ...over,
  }
}

describe('JournalStore maintenance', () => {
  let tempDir: string
  let journalPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autoloop-store-maintenance-'))
    journalPath = join(tempDir, 'journal.jsonl')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('persists before applying, so a failed write leaves memory untouched', () => {
    const store = new JournalStore(journalPath)
    const row = ticket({ id: 'tk-writefail', status: 'pending', updatedAt: Date.now() })

    // Turn the journal path into a directory: the append cannot succeed.
    rmSync(journalPath, { force: true })
    mkdirSync(journalPath)

    expect(() => store.append({ type: 'ticket.created', ticket: row, at: Date.now() })).toThrow()
    expect(store.getTicket('tk-writefail')).toBeUndefined()
  })

  it('counts and warns about undecodable lines instead of failing silently', () => {
    const warn = vi.fn()
    const row = ticket({ id: 'tk-corrupt', status: 'pending', updatedAt: Date.now() })
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ type: 'ticket.created', ticket: row, at: row.updatedAt }),
        '{"type":"ticket.created","ticket":',
        JSON.stringify({ type: 'ticket.status_changed', ticketId: row.id, status: 'completed', at: row.updatedAt + 10 }),
        '',
      ].join('\n'),
      'utf8',
    )

    const store = new JournalStore(journalPath, { logger: { info: vi.fn(), warn, error: vi.fn() } })
    expect(store.corruptLineCount).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('journal line 2'))
    // Later lines still apply: one bad line must not hide the rest of the log.
    expect(store.getTicket(row.id)?.status).toBe('completed')
  })

  it('drops finished tickets past retention and keeps active ones on boot', () => {
    const now = Date.now()
    const day = 86_400_000
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ type: 'ticket.created', ticket: ticket({ id: 'tk-active', status: 'pending', updatedAt: now - 40 * day }), at: now }),
        JSON.stringify({ type: 'ticket.created', ticket: ticket({ id: 'tk-recent', status: 'completed', updatedAt: now - day }), at: now }),
        JSON.stringify({ type: 'ticket.created', ticket: ticket({ id: 'tk-expired', status: 'completed', updatedAt: now - 15 * day }), at: now }),
        JSON.stringify({ type: 'ticket.created', ticket: ticket({ id: 'tk-failed', status: 'failed', updatedAt: now - 30 * day }), at: now }),
        '',
      ].join('\n'),
      'utf8',
    )

    const store = new JournalStore(journalPath, { completedRetentionDays: 14 })
    expect(store.getTicket('tk-active')?.status).toBe('pending')
    expect(store.getTicket('tk-recent')?.status).toBe('completed')
    expect(store.getTicket('tk-expired')).toBeUndefined()
    expect(store.getTicket('tk-failed')).toBeUndefined()

    // The rewrite collapsed the log into one snapshot line that replays identically.
    expect(store.lineCount).toBe(1)
    const reloaded = new JournalStore(journalPath, { completedRetentionDays: 14 })
    expect(reloaded.getAllTickets().map(t => t.id).sort()).toEqual(['tk-active', 'tk-recent'])
  })

  it('compacts once the log passes its line threshold', () => {
    const store = new JournalStore(journalPath, { compactAfterLines: 100 })
    const now = Date.now()
    store.append({ type: 'ticket.created', ticket: ticket({ id: 'tk-churn', status: 'pending', updatedAt: now }), at: now })

    for (let index = 0; index < 130; index += 1) {
      store.append({ type: 'ticket.status_changed', ticketId: 'tk-churn', status: 'pending', at: now + index + 1 })
    }

    expect(store.lineCount).toBeLessThan(100)
    expect(store.getTicket('tk-churn')?.status).toBe('pending')
    const reloaded = new JournalStore(journalPath, { compactAfterLines: 100 })
    expect(reloaded.getTicket('tk-churn')).toBeDefined()
  })

  it('keeps the previous log when the replacement cannot be written', () => {
    const warn = vi.fn()
    const now = Date.now()
    const store = new JournalStore(journalPath, {
      completedRetentionDays: 14,
      compactAfterLines: 10_000,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    })
    store.append({
      type: 'ticket.created',
      ticket: ticket({ id: 'tk-expired', status: 'completed', updatedAt: now - 5 * 86_400_000 }),
      at: now,
    })
    const before = readFileSync(journalPath, 'utf8')

    // Block the temp path so the rewrite fails after the decision to compact.
    mkdirSync(`${journalPath}.compact`)

    // Ask for a compaction far enough ahead that the ticket is expired; the write must still fail safely.
    expect(store.compact(now + 30 * 86_400_000)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    expect(store.getTicket('tk-expired')).toBeDefined()
  })

  it('replays a snapshot as the new baseline', () => {
    const now = Date.now()
    writeFileSync(
      journalPath,
      [
        JSON.stringify({ type: 'ticket.created', ticket: ticket({ id: 'tk-old', status: 'pending', updatedAt: now }), at: now }),
        JSON.stringify({
          type: 'snapshot',
          tickets: [ticket({ id: 'tk-new', status: 'pending', updatedAt: now })],
          at: now + 1,
        }),
        '',
      ].join('\n'),
      'utf8',
    )

    const store = new JournalStore(journalPath)
    expect(store.getAllTickets().map(t => t.id)).toEqual(['tk-new'])
  })
})
