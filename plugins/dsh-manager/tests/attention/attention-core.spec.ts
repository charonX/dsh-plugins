/**
 * Attention domain core: a question (later, approvals and reviews) the
 * executor raises on its ticket, pending until the user answers. Pure state
 * machine over the {@link AttentionStorePort} — persistence is a thin
 * adapter, so tests drive this core in memory (ADR-0003).
 */
import { describe, expect, test } from 'vitest'
import {
  answerAttention, askAttention, ATTENTION_KINDS, ATTENTION_STATUSES, classifyConfirmationAnswer,
  type AttentionRecord, type AttentionStorePort,
} from '../../src/attention/attention-core.ts'

/** In-memory attention store. */
function memoryStore(): AttentionStorePort & { records: Map<string, AttentionRecord> } {
  const records = new Map<string, AttentionRecord>()
  return {
    records,
    getAttention: id => records.get(id),
    async putAttention(record) { records.set(record.id, record) },
    listAttentions: () => [...records.values()],
  }
}

describe('attention core', () => {
  test('asking creates a pending question on the dispatch and ticket', async () => {
    const store = memoryStore()
    const record = await askAttention(store, {
      ticketId: 'ticket-1', dispatchId: 'dispatch-1', kind: 'question',
      question: 'Which database should this target?', details: 'The ticket does not name one.',
    }, 100)
    expect(record.id).toMatch(/^att-/)
    expect(record.status).toBe('pending')
    expect(record.kind).toBe('question')
    expect(record.question).toContain('Which database')
    expect(record.answer).toBeUndefined()
    expect(ATTENTION_KINDS).toContain('approval')
    expect(ATTENTION_STATUSES).toEqual(['pending', 'answered'])
  })

  test('asking defaults to the question kind and keeps optional details off the record', async () => {
    const store = memoryStore()
    const record = await askAttention(store, {
      ticketId: 'ticket-1', dispatchId: 'dispatch-1', question: 'Proceed without tests?',
    }, 100)
    expect(record.kind).toBe('question')
    expect(record.details).toBeUndefined()
    expect(store.records.get(record.id)?.status).toBe('pending')
  })

  test('answering a pending question records the answer and marks it answered', async () => {
    const store = memoryStore()
    const asked = await askAttention(store, {
      ticketId: 'ticket-1', dispatchId: 'dispatch-1', question: 'Which database?',
    }, 100)
    const answered = await answerAttention(store, asked.id, 'Postgres', 200)
    expect(answered?.status).toBe('answered')
    expect(answered?.answer).toBe('Postgres')
    expect(answered?.updatedAt).toBe(200)
    expect(store.records.get(asked.id)?.status).toBe('answered')
  })

  test('answering an already answered question is refused', async () => {
    const store = memoryStore()
    const asked = await askAttention(store, {
      ticketId: 'ticket-1', dispatchId: 'dispatch-1', question: 'Which database?',
    }, 100)
    await answerAttention(store, asked.id, 'Postgres', 200)
    const again = await answerAttention(store, asked.id, 'MySQL', 300)
    expect(again).toBeUndefined()
    expect(store.records.get(asked.id)?.answer).toBe('Postgres')
  })

  test('answering an unknown attention is refused', async () => {
    const store = memoryStore()
    expect(await answerAttention(store, 'att-nope', 'anything', 100)).toBeUndefined()
  })

  test('one attention record does not affect another', async () => {
    const store = memoryStore()
    const first = await askAttention(store, { ticketId: 'ticket-1', dispatchId: 'dispatch-1', question: 'First?' }, 100)
    const second = await askAttention(store, { ticketId: 'ticket-1', dispatchId: 'dispatch-1', question: 'Second?' }, 110)
    await answerAttention(store, first.id, 'yes', 200)
    expect(store.records.get(second.id)?.status).toBe('pending')
    expect(store.listAttentions()).toHaveLength(2)
  })

  test('classifyConfirmationAnswer recognizes Chinese, English, and reroute responses', () => {
    expect(classifyConfirmationAnswer('confirmed')).toBe('confirm')
    expect(classifyConfirmationAnswer('确认')).toBe('confirm')
    expect(classifyConfirmationAnswer('同意跳过')).toBe('confirm')
    expect(classifyConfirmationAnswer('继续')).toBe('confirm')
    expect(classifyConfirmationAnswer('reroute')).toBe('reroute')
    expect(classifyConfirmationAnswer('重新路由')).toBe('reroute')
    expect(classifyConfirmationAnswer('rejected: wait')).toBe('reject')
    expect(classifyConfirmationAnswer('取消')).toBe('reject')
    expect(classifyConfirmationAnswer('请使用方案B')).toBe('custom')
  })
})
