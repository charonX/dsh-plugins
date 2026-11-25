/**
 * Pure domain helpers for bridging Dsh Manager notifications and tool calls
 * with an external `dsh-im` service (`ctx.dshIm`). Keeps formatting, filtering,
 * and attention resolution side-effect free so unit tests drive them directly.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AttentionKind, AttentionRecord } from '../attention/attention-core.ts'
import type { ManagerNotification } from '../notifications/notification-core.ts'
import type { ImSettingsView } from './wire-types.ts'

/** Described conversation metadata returned by `dshIm.describeConversation`. */
export interface ImDescribedConversation {
  readonly botId?: string
  readonly channel?: string
  readonly conversationKey?: string
  readonly chatType?: string | null
  readonly chatId?: string | null
  readonly threadId?: string | null
}

/** Minimal `ctx.dshIm` subset required by the companion integration. */
export interface DshImCompanionService {
  listBots(): Promise<readonly { readonly botId: string; readonly channel: string }[]>
  listTargets(botId: string): Promise<readonly { readonly targetId: string; readonly name?: string; readonly kind: string }[]>
  send(
    botId: string,
    targetId: string,
    text: string,
    options?: { readonly signal?: AbortSignal; readonly format?: 'plain' | 'markdown' },
  ): Promise<{ readonly sent: boolean }>
  describeConversation?(sessionId: string): Promise<ImDescribedConversation | null>
  deliverSessionText?(
    sessionId: string,
    text: string,
    options?: { readonly signal?: AbortSignal; readonly format?: 'plain' | 'markdown' },
  ): Promise<{ readonly sent: boolean; readonly reason?: string }>
}

const MARKDOWN_CAPABLE_CHANNELS = new Set([
  'feishu',
  'telegram',
  'discord',
  'slack',
  'dingtalk',
  'wecom',
  'qq',
  'matrix',
])

/** Whether proactive messages for this IM channel should request Markdown card formatting. */
export function prefersMarkdownFormat(channel?: string): boolean {
  return typeof channel === 'string' && MARKDOWN_CAPABLE_CHANNELS.has(channel)
}

/** Durable IM-bridge configuration record (`id` is always `'im'`). */
export const imSettingsRecord = z.object({
  id: z.literal('im'),
  enabled: z.boolean().default(false),
  botId: z.string().trim().min(1).max(128).optional(),
  targetId: z.string().trim().min(1).max(128).optional(),
  /** Default scope: push pending attentions (approvals/questions/reviews). */
  notifyAttention: z.boolean().default(true),
  notifyProgress: z.boolean().default(false),
  updatedAt: z.number(),
})

export type ImSettingsRecord = z.infer<typeof imSettingsRecord>

export type ImConfigId = Branded<'ImConfigId'>

export const imDomain = defineDomain({
  name: 'dsh_manager_im',
  version: 1,
  tables: {
    config: domainTable<ImConfigId, ImSettingsRecord>(imSettingsRecord),
  },
})

/** Default IM bridge preferences: attention/approvals enabled once a target is bound. */
export function defaultImSettings(now: number): ImSettingsRecord {
  return imSettingsRecord.parse({
    id: 'im',
    enabled: false,
    notifyAttention: true,
    notifyProgress: false,
    updatedAt: now,
  })
}

export function imSettingsViewOf(record: ImSettingsRecord): ImSettingsView {
  return {
    enabled: record.enabled,
    ...(record.botId === undefined ? {} : { botId: record.botId }),
    ...(record.targetId === undefined ? {} : { targetId: record.targetId }),
    notifyAttention: record.notifyAttention,
    notifyProgress: record.notifyProgress,
  }
}

/** Decide whether one notification should fan out to the bound IM target. */
export function shouldSendNotification(settings: ImSettingsRecord, notification: ManagerNotification): boolean {
  if (!settings.enabled || settings.botId === undefined || settings.targetId === undefined) return false
  if (notification.origin === 'im-tool') return false
  if (notification.kind === 'attention') return settings.notifyAttention
  if (notification.kind === 'progress') return settings.notifyProgress
  return false
}

const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  approval: '待审批',
  question: '待回复',
  review: '待验收',
  'suggest-end': '待结单确认',
  policy: '策略变更确认',
}

/** Formatting options for IM notification rendering. */
export interface FormatImNotificationOptions {
  readonly format?: 'plain' | 'markdown'
  readonly takeoverSessionId?: string
}

/** Format a notification into clean, emoji-free copy suitable for Feishu Markdown cards or plain IM channels. */
export function formatNotificationForIm(
  notification: ManagerNotification,
  ticketTitle?: string,
  options?: FormatImNotificationOptions,
): string {
  const markdown = options?.format === 'markdown'
  const takeover = options?.takeoverSessionId
  const ticketRef = notification.ticketId === ''
    ? undefined
    : (ticketTitle ? `${ticketTitle} (${notification.ticketId})` : notification.ticketId)
  if (notification.kind === 'attention') {
    const tag = notification.attentionKind === undefined ? '待处理' : ATTENTION_KIND_LABELS[notification.attentionKind]
    if (markdown) {
      const lines = [
        `**[中控台 · ${tag}]** ${notification.title}`,
        ...(ticketRef === undefined ? [] : [`- 工单：${ticketRef}`]),
        `- 待办编号：\`${notification.attentionId}\``,
        ...(takeover === undefined ? [] : [`- 执行会话：\`${takeover}\`（可用 \`/session ${takeover}\` 接管多轮对话）`]),
        ...(notification.details ? [`- 说明：${notification.details}`] : []),
        '',
        notification.attentionKind === 'question'
          ? `可直接回复 \`回答 ${notification.attentionId} <你的答复>\` 或让助手代答。`
          : `可直接回复 \`批准 ${notification.attentionId}\` 或 \`拒绝 ${notification.attentionId} <原因>\`。`,
      ]
      return lines.join('\n')
    }
    const lines = [
      `[中控台 · ${tag}] ${notification.title}`,
      ...(ticketRef === undefined ? [] : [`工单: ${ticketRef}`]),
      `待办编号: ${notification.attentionId}`,
      ...(takeover === undefined ? [] : [`执行会话: ${takeover}（可用 /session ${takeover} 接管对话）`]),
      ...(notification.details ? [`说明: ${notification.details}`] : []),
      notification.attentionKind === 'question'
        ? `请在聊天中回复“回答 ${notification.attentionId} <你的答复>”或让助手处理。`
        : `请在聊天中回复“批准 ${notification.attentionId}”或“拒绝 ${notification.attentionId} <原因>”。`,
    ]
    return lines.join('\n')
  }
  const lines = markdown
    ? [
        `**[中控台 · 动态]** ${notification.title}`,
        ...(ticketRef === undefined ? [] : [`- 工单：${ticketRef}`]),
        ...(takeover === undefined ? [] : [`- 关联会话：\`${takeover}\``]),
        ...(notification.details ? [`- 说明：${notification.details}`] : []),
      ]
    : [
        `[中控台 · 动态] ${notification.title}`,
        ...(ticketRef === undefined ? [] : [`工单: ${ticketRef}`]),
        ...(takeover === undefined ? [] : [`关联会话: ${takeover}`]),
        ...(notification.details ? [notification.details] : []),
      ]
  return lines.join('\n')
}

export type ToolAttentionAction = 'approve' | 'reject' | 'answer'

/** Translate a structured tool decision into the verbatim answer string `answerAttention` expects. */
export function resolveAttentionAnswer(
  attention: AttentionRecord,
  action: ToolAttentionAction,
  text?: string,
): { readonly ok: true; readonly answer: string } | { readonly ok: false; readonly reason: string } {
  const note = text?.trim() ?? ''
  if (attention.kind === 'approval' || attention.kind === 'review' || attention.kind === 'policy') {
    if (action === 'approve') return { ok: true, answer: 'approved' }
    if (action === 'reject') return { ok: true, answer: note === '' ? 'rejected' : `rejected: ${note}` }
    return { ok: false, reason: `attention ${attention.id} (${attention.kind}) expects approve or reject` }
  }
  if (attention.kind === 'suggest-end' || (attention.kind === 'question' && attention.dispatchId === 'steward')) {
    if (action === 'approve') return { ok: true, answer: 'confirmed' }
    if (action === 'reject') return { ok: true, answer: note === '' ? 'rejected' : `rejected: ${note}` }
    if (note !== '') return { ok: true, answer: note }
    return { ok: false, reason: `attention ${attention.id} requires a non-empty answer or approve/reject` }
  }
  if (action === 'reject') {
    return { ok: true, answer: note === '' ? 'rejected' : `rejected: ${note}` }
  }
  if (note === '') {
    return { ok: false, reason: `question ${attention.id} requires non-empty answer text` }
  }
  return { ok: true, answer: note }
}

/**
 * Resolve one pending attention by exact id, unique prefix/suffix, or the
 * sole pending item when `attentionIdOrQuery` is omitted.
 */
export function matchPendingAttention(
  attentions: readonly AttentionRecord[],
  attentionIdOrQuery?: string,
): { readonly ok: true; readonly attention: AttentionRecord } | { readonly ok: false; readonly reason: string } {
  const pending = attentions.filter(item => item.status === 'pending')
  if (pending.length === 0) {
    return { ok: false, reason: 'there are no pending attentions' }
  }
  const query = attentionIdOrQuery?.trim() ?? ''
  if (query === '') {
    if (pending.length === 1) return { ok: true, attention: pending[0]! }
    return {
      ok: false,
      reason: `multiple pending attentions (${pending.length}); specify attentionId: ${pending.map(a => a.id).join(', ')}`,
    }
  }
  const exact = pending.find(item => item.id === query)
  if (exact !== undefined) return { ok: true, attention: exact }
  const partial = pending.filter(item => item.id.startsWith(query) || item.id.endsWith(query))
  if (partial.length === 1) return { ok: true, attention: partial[0]! }
  if (partial.length > 1) {
    return { ok: false, reason: `ambiguous attention query "${query}" matched ${partial.map(a => a.id).join(', ')}` }
  }
  return { ok: false, reason: `no pending attention matched "${query}"` }
}
