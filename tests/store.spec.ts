import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
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

    const initialTicket: Ticket = {
      id: 'tk-1',
      threadId: 'th-1',
      title: 'Fix auth bug',
      source: 'github',
      status: 'pending',
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
      createdAt: 1000,
      updatedAt: 1000,
    }

    store1.append({ type: 'ticket.created', ticket: initialTicket, at: 1000 })
    store1.append({
      type: 'ticket.input_added',
      ticketId: 'tk-1',
      input: { id: 'in-1', eventId: 'ev-1', text: 'Also check token refresh', receivedAt: 1050 },
      at: 1050,
    })
    store1.append({
      type: 'ticket.assignment_started',
      ticketId: 'tk-1',
      assignment: { assignmentId: 'as-1', startedAt: 1100 },
      at: 1100,
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
      at: 1200,
    })
    store1.append({
      type: 'ticket.attention_resolved',
      ticketId: 'tk-1',
      answer: 'yes',
      at: 1300,
    })
    store1.append({
      type: 'ticket.assignment_ended',
      ticketId: 'tk-1',
      resultSummary: 'Done successfully',
      sessionId: 'sess-xyz-123',
      at: 1400,
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
})
