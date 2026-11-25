import { describe, expect, test } from 'vitest'
import {
  defaultImSettings,
  formatNotificationForIm,
  imSettingsRecord,
  matchPendingAttention,
  prefersMarkdownFormat,
  resolveAttentionAnswer,
  shouldSendNotification,
} from '../../src/im/im-core.ts'
import type { AttentionRecord } from '../../src/attention/attention-core.ts'
import type { ManagerNotification } from '../../src/notifications/notification-core.ts'

describe('im-core', () => {
  test('default settings enable attention scope only and disable until configured', () => {
    const defaults = defaultImSettings(100)
    expect(defaults.enabled).toBe(false)
    expect(defaults.notifyAttention).toBe(true)
    expect(defaults.notifyProgress).toBe(false)
    expect('notifyBriefing' in defaults).toBe(false)
  })

  test('imSettingsRecord strips legacy notifyBriefing fields persisted on disk', () => {
    const parsed = imSettingsRecord.parse({
      id: 'im',
      enabled: true,
      botId: 'bot-wx',
      targetId: 'owner',
      notifyAttention: true,
      notifyProgress: false,
      notifyBriefing: false,
      updatedAt: 42,
    })
    expect(parsed).toEqual({
      id: 'im',
      enabled: true,
      botId: 'bot-wx',
      targetId: 'owner',
      notifyAttention: true,
      notifyProgress: false,
      updatedAt: 42,
    })
  })

  test('shouldSendNotification enforces enabled target, scope switches, and im-tool echo suppression', () => {
    const base = { ...defaultImSettings(100), enabled: true, botId: 'bot-wx', targetId: 'owner' }
    const att: ManagerNotification = {
      id: 'att-1',
      kind: 'attention',
      attentionId: 'att-1',
      ticketId: 'ticket-1',
      title: 'approve external call',
      at: 100,
    }
    const progress: ManagerNotification = {
      id: 'prog-1',
      kind: 'progress',
      attentionId: '',
      ticketId: 'ticket-1',
      title: 'ticket ended',
      at: 200,
    }

    expect(shouldSendNotification(base, att)).toBe(true)
    expect(shouldSendNotification(base, progress)).toBe(false)
    expect(shouldSendNotification(base, { ...att, origin: 'im-tool' })).toBe(false)
    expect(shouldSendNotification({ ...base, enabled: false }, att)).toBe(false)
    expect(shouldSendNotification({ ...base, notifyProgress: true }, { ...progress, origin: 'im-tool' })).toBe(false)
    expect(shouldSendNotification({ ...base, notifyProgress: true }, { ...progress, origin: 'web' })).toBe(true)
  })

  test('formatNotificationForIm produces clear, emoji-free copy', () => {
    const text = formatNotificationForIm({
      id: 'att-9',
      kind: 'attention',
      attentionId: 'att-9',
      ticketId: 'ticket-7',
      title: 'post MR comment?',
      attentionKind: 'approval',
      details: 'Project #42',
      at: 100,
    }, 'Fix auth redirect')
    expect(text).toContain('[中控台 · 待审批] post MR comment?')
    expect(text).toContain('Fix auth redirect (ticket-7)')
    expect(text).toContain('待办编号: att-9')
    expect(text).toContain('批准 att-9')
  })

  test('matchPendingAttention resolves exact, unique suffix, or sole pending item', () => {
    const items: AttentionRecord[] = [
      { id: 'att-aaaa1111', ticketId: 't1', dispatchId: 'd1', kind: 'approval', question: 'Q1', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'att-bbbb2222', ticketId: 't2', dispatchId: 'd2', kind: 'question', question: 'Q2', status: 'answered', answer: 'ok', createdAt: 2, updatedAt: 3 },
    ]
    expect(matchPendingAttention(items)).toMatchObject({ ok: true, attention: { id: 'att-aaaa1111' } })
    expect(matchPendingAttention(items, '1111')).toMatchObject({ ok: true, attention: { id: 'att-aaaa1111' } })
    expect(matchPendingAttention(items, 'missing')).toMatchObject({ ok: false })
  })

  test('resolveAttentionAnswer maps approval, steward, and free question answers', () => {
    const approval: AttentionRecord = {
      id: 'att-1', ticketId: 't1', dispatchId: 'd1', kind: 'approval', question: 'approve?', status: 'pending', createdAt: 1, updatedAt: 1,
    }
    const stewardQ: AttentionRecord = {
      id: 'att-2', ticketId: 't1', dispatchId: 'steward', kind: 'question', question: '[skip]?', status: 'pending', createdAt: 1, updatedAt: 1,
    }
    const execQ: AttentionRecord = {
      id: 'att-3', ticketId: 't1', dispatchId: 'd1', kind: 'question', question: 'DB?', status: 'pending', createdAt: 1, updatedAt: 1,
    }
    expect(resolveAttentionAnswer(approval, 'approve')).toEqual({ ok: true, answer: 'approved' })
    expect(resolveAttentionAnswer(approval, 'reject', 'use token')).toEqual({ ok: true, answer: 'rejected: use token' })
    expect(resolveAttentionAnswer(stewardQ, 'approve')).toEqual({ ok: true, answer: 'confirmed' })
    expect(resolveAttentionAnswer(execQ, 'answer', 'Postgres')).toEqual({ ok: true, answer: 'Postgres' })
    expect(resolveAttentionAnswer(execQ, 'answer', '')).toMatchObject({ ok: false })
  })

  test('prefersMarkdownFormat and markdown card copy support Feishu cards with takeover session', () => {
    expect(prefersMarkdownFormat('feishu')).toBe(true)
    expect(prefersMarkdownFormat('weixin')).toBe(false)
    const md = formatNotificationForIm({
      id: 'att-md-1',
      kind: 'attention',
      attentionId: 'att-md-1',
      ticketId: 'ticket-direct-1',
      title: 'Need clarification',
      attentionKind: 'question',
      details: 'Confirm cache TTL',
      at: 200,
    }, 'Optimize query cache', { format: 'markdown', takeoverSessionId: 'dsh-manager-exec-99' })
    expect(md).toContain('**[中控台 · 待回复]** Need clarification')
    expect(md).toContain('- 执行会话：`dsh-manager-exec-99`（可用 `/session dsh-manager-exec-99` 接管多轮对话）')
    expect(md).toContain('`回答 att-md-1 <你的答复>`')
  })
})
