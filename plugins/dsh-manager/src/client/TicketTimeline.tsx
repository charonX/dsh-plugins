/**
 * The ticket workbench timeline: one chronological log per ticket, grouped by
 * dispatch turn. Rows come from the plugin's own ledger (`ticketDetail.events`),
 * so history survives session loss; attentions render inline in the turn that
 * raised them.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText, Tag, type MarkdownLabels, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AttentionView } from '../attention/wire-types.ts'
import type { DispatchView, TicketDetailView } from '../dispatch/wire-types.ts'
import type { TimelineEvent } from '../timeline/timeline-core.ts'
import { AttentionAnswerForm } from './AttentionAnswerForm.tsx'
import css from './BoardPage.module.css'

const DISPATCH_STATE_TONE: Record<DispatchView['state'], TagTone> = {
  queued: 'neutral',
  running: 'info',
  ended: 'success',
}

const REPORT_TONE: Record<NonNullable<TimelineEvent['activity']>['category'], TagTone> = {
  message: 'neutral',
  tool: 'info',
  command: 'info',
  file: 'info',
  error: 'warning',
}


/** Report → event mapping shared with the host's ledger writer. */
function reportEvent(dispatchId: string, seq: number, report: DispatchView['reports'][number]): TimelineEvent {
  const category = report.activity?.category
  const kind = category === 'message' ? 'assistant' : category === 'tool' || category === 'command' || category === 'file' ? 'tool' : 'report'
  return {
    id: `report:${dispatchId}:${report.id}`,
    seq,
    kind,
    author: 'executor',
    at: report.at,
    turnId: dispatchId,
    code: `report-${kind}`,
    body: report.message,
    reportId: report.id,
    ...(report.activity === undefined ? {} : { activity: report.activity }),
  }
}

/**
 * The ticket's timeline. Hosts that predate the ledger send no `events`; the
 * same shape is derived from dispatches and attentions so an upgraded client
 * still renders an older board read.
 */
export function timelineOf(detail: TicketDetailView, attentions?: readonly AttentionView[]): readonly TimelineEvent[] {
  if ((detail.events?.length ?? 0) > 0) return detail.events
  const events: TimelineEvent[] = []
  let seq = 0
  for (const dispatch of [...detail.dispatches].reverse()) {
    events.push({
      id: `dispatch:${dispatch.id}:started`, seq: seq++, kind: 'system', author: 'system',
      at: dispatch.createdAt, turnId: dispatch.id, code: 'turn-started', body: '',
    })
    // Builtin sessions expose their readable log as `messages`; older hosts have
    // no ledger, so those rows are the only record of what the executor said.
    const spoken: TimelineEvent[] = (dispatch.messages ?? []).map((message): TimelineEvent => ({
      id: `message:${dispatch.id}:${message.id}`,
      seq: 0,
      kind: message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'report',
      author: 'executor',
      at: message.at,
      turnId: dispatch.id,
      code: message.role === 'assistant' ? 'message' : 'tool-call',
      body: message.text,
      ...(message.role === 'tool'
        ? { activity: { category: message.category ?? 'tool' as const, ...(message.toolName === undefined ? {} : { toolName: message.toolName }), target: message.text.slice(0, 80) } }
        : {}),
    })).sort((left, right) => left.at - right.at)
    for (const message of spoken) events.push({ ...message, seq: seq++ })
    for (const report of dispatch.reports) events.push(reportEvent(dispatch.id, seq++, report))
    if (dispatch.state === 'ended') {
      events.push({
        id: `dispatch:${dispatch.id}:ended`, seq: seq++, kind: 'system', author: 'system',
        at: dispatch.updatedAt, turnId: dispatch.id, code: `turn-ended:${dispatch.outcome ?? 'ended'}`, body: '',
      })
    }
  }
  for (const attention of [...(attentions ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
    events.push({
      id: `attention:${attention.id}:asked`, seq: seq++, kind: 'attention', author: 'executor',
      at: attention.createdAt, turnId: attention.dispatchId, attentionId: attention.id,
      code: `attention-${attention.kind}`, body: attention.question,
    })
    if (attention.status === 'answered') {
      events.push({
        id: `attention:${attention.id}:answered`, seq: seq++, kind: 'instruction', author: 'user',
        at: attention.updatedAt, turnId: attention.dispatchId, code: 'answered', body: attention.answer ?? '',
      })
    }
  }
  return events.sort((left, right) => left.at - right.at || left.seq - right.seq)
}

/** One turn group or one standalone system row. */
export interface TimelineGroup {
  readonly turnId?: string
  readonly events: readonly TimelineEvent[]
}

/** Fold the ledger into turn groups; system rows stay at their chronological position. */
export function groupTimeline(events: readonly TimelineEvent[]): readonly TimelineGroup[] {
  const groups: { turnId?: string; events: TimelineEvent[] }[] = []
  for (const event of events) {
    if (event.turnId === undefined) {
      groups.push({ events: [event] })
      continue
    }
    const last = groups.at(-1)
    if (last !== undefined && last.turnId === event.turnId) last.events.push(event)
    else groups.push({ turnId: event.turnId, events: [event] })
  }
  return groups
}

/** One compact line describing a tool event: its name and target. */
function toolLabel(event: TimelineEvent): string {
  const name = event.activity?.toolName ?? event.code?.replace(/^tool-/, '') ?? event.code ?? ''
  const target = event.activity?.target
  return target === undefined ? name : `${name} · ${target}`
}

function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function TicketTimeline({ detail, attentions, t, markdownLabels, cancellingId, onCancel, onAnswerAttention }: {
  detail: TicketDetailView
  attentions?: readonly AttentionView[] | undefined
  t: TranslateNS<'dshManager'>
  markdownLabels: MarkdownLabels
  cancellingId?: string | undefined
  onCancel?: (dispatchId: string) => void
  onAnswerAttention?: (input: { attentionId: string; answer: string }) => Promise<boolean>
}) {
  const groups = groupTimeline(timelineOf(detail, attentions))
  const attentionById = new Map((attentions ?? []).map(attention => [attention.id, attention]))
  let turnNumber = 0
  if (groups.length === 0) {
    return (
      <div className={css.timelineEmpty}>
        <p>{t('board.timeline.empty.title')}</p>
        <p className={css.timelineEmptyHint}>{t('board.timeline.empty.hint')}</p>
      </div>
    )
  }
  return (
    <div className={css.timelineWrap}>
      {groups.map((group, index) => {
        if (group.turnId === undefined) {
          return group.events.map(event => (
            <div key={event.id} className={css.timelineSystem} data-code={event.code}>
              <span className={css.timelineSystemCode}>{event.code ?? 'system'}</span>
              {event.body === ''
                ? null
                : <MarkdownText text={event.body} labels={markdownLabels} omitHtml />}
              <span className={css.timelineSystemAt}>{formatTime(event.at)}</span>
            </div>
          ))
        }
        turnNumber += 1
        const dispatch = detail.dispatches.find(record => record.id === group.turnId)
        const active = dispatch !== undefined && dispatch.state !== 'ended'
        const tools = group.events.filter(event => event.kind === 'tool')
        const rows = group.events.filter(event => event.kind !== 'tool')
        return (
          <section key={`turn-${group.turnId}-${index}`} className={css.timelineTurn} aria-label={t('board.timeline.turn', { n: turnNumber })}>
            <div className={css.timelineTurnHead}>
              <span className={css.timelineTurnIndex}>{t('board.timeline.turn', { n: turnNumber })}</span>
              <span className={css.timelineTurnAt}>{formatTime(group.events[0]?.at ?? Date.now())}</span>
              {dispatch !== undefined
                ? <Tag tone={DISPATCH_STATE_TONE[dispatch.state]}>{t(`board.detail.dispatch.state.${dispatch.state}`)}</Tag>
                : null}
              {active && onCancel !== undefined && dispatch !== undefined
                ? (
                  <button
                    type="button"
                    className={css.detailCancelBtn}
                    disabled={cancellingId === dispatch.id}
                    onClick={() => { onCancel(dispatch.id) }}
                  >
                    {cancellingId === dispatch.id ? t('board.detail.dispatch.cancelling') : t('board.timeline.cancelTurn')}
                  </button>
                )
                : null}
            </div>
            {rows.map(event => {
              if (event.kind === 'attention') {
                const attention = event.attentionId === undefined ? undefined : attentionById.get(event.attentionId)
                if (attention !== undefined && attention.status === 'pending' && onAnswerAttention !== undefined) {
                  return (
                    <div key={event.id} className={css.timelineAttention}>
                      <div className={css.timelineAttentionHead}>{t('board.timeline.needsYou')}</div>
                      <AttentionAnswerForm attention={attention} t={t} onAnswerAttention={onAnswerAttention} />
                    </div>
                  )
                }
                return (
                  <div key={event.id} className={css.timelineAttentionDone}>
                    <Tag tone="success">{t('board.timeline.answered')}</Tag>
                    <span>{event.body}</span>
                  </div>
                )
              }
              if (event.kind === 'instruction') {
                return (
                  <div key={event.id} className={css.timelineUser} data-delivery={event.code}>
                    <div className={css.timelineUserHead}>
                      <span>{event.author === 'user' ? t('board.timeline.you') : event.author}</span>
                      <span className={css.timelineAt}>{formatTime(event.at)}</span>
                      {event.code === undefined
                        ? null
                        : <span className={css.timelineChip}>{t(`board.timeline.delivery.${event.code}` as never)}</span>}
                    </div>
                    <div className={css.timelineUserBody}>{event.body}</div>
                  </div>
                )
              }
              if (event.kind === 'assistant') {
                return (
                  <div key={event.id} className={css.timelineAssistant}>
                    <div className={css.timelineAssistantHead}>
                      <span className={css.timelineAvatar}>{t('board.timeline.executorInitial')}</span>
                      <span>{t('board.timeline.executor')}</span>
                      <span className={css.timelineAt}>{formatTime(event.at)}</span>
                    </div>
                    <div className={css.timelineAssistantBody}>
                      <MarkdownText text={event.body} labels={markdownLabels} omitHtml />
                    </div>
                  </div>
                )
              }
              if (event.kind === 'report') {
                return (
                  <div key={event.id} className={css.timelineReport}>
                    <Tag tone={REPORT_TONE[event.activity?.category ?? 'message']}>
                      {t(`board.timeline.report.${event.activity?.category ?? 'message'}` as never)}
                    </Tag>
                    <span className={css.timelineReportBody}>{event.body}</span>
                  </div>
                )
              }
              if (event.kind === 'artifact') {
                return (
                  <div key={event.id} className={css.timelineArtifact}>
                    <Tag tone="success">{t('board.timeline.artifact')}</Tag>
                    <span>{event.body}</span>
                  </div>
                )
              }
              return (
                <div key={event.id} className={css.timelineSystem}>
                  <span className={css.timelineSystemCode}>{event.code ?? event.kind}</span>
                  <span>{event.body}</span>
                </div>
              )
            })}
            {tools.length === 0
              ? null
              : (
                <details className={css.timelineTools}>
                  <summary className={css.timelineToolsSummary}>
                    {t('board.timeline.toolCount', { n: tools.length })}
                  </summary>
                  <ul className={css.timelineToolList}>
                    {tools.map(event => (
                      <li key={event.id} className={css.timelineToolRow}>
                        <span>{toolLabel(event)}</span>
                        <span className={css.timelineAt}>{formatTime(event.at)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
          </section>
        )
      })}
    </div>
  )
}
