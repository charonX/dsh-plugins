/** Multica-inspired 2-column ticket detail workbench: live Markdown replies,
    collapsible tool activity, properties sidebar, pipeline stepper, and worktree diff. */
import { useEffect, useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, MarkdownText, Tag, type MarkdownLabels, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangesRef, DeliverableRef, DispatchMessageView, DispatchView, FileDiffView, TicketChangeDiffInput, TicketDetailView, WorktreeInspectionView } from '../dispatch/wire-types.ts'
import type { AttentionView } from '../attention/wire-types.ts'
import type { ConnectionView } from '../connections/wire-types.ts'
import type { FlowTimelineView } from '../flow/flow-core.ts'
import type { ProjectRef } from '../mappings/wire-types.ts'
import { AttentionAnswerForm } from './AttentionAnswerForm.tsx'
import { hasExternalUrl } from './url.ts'
import css from './BoardPage.module.css'

/** The reads the detail panel makes through the injected board source. */
export interface TicketDetailActions {
  /** Read one ticket's whole detail; `undefined` marks a failed read. */
  readonly onTicketDetail: (ticketId: string) => Promise<TicketDetailView | undefined>
  /** Read one ticket's pipeline walk; `undefined` when the ticket walks no pipeline. */
  readonly onFlowTimeline?: (ticketId: string) => Promise<FlowTimelineView | undefined>
  /** Resolve one change ref through the harness diff view; `undefined` marks a failed read. */
  readonly onTicketChangeDiff: (input: TicketChangeDiffInput) => Promise<FileDiffView | undefined>
  /** Enqueue a new dispatch for an unfinished ticket. */
  readonly onDispatchTicket?: (ticketId: string) => Promise<boolean>
  /** Cancel a queued or running dispatch on user request. */
  readonly onDispatchCancel?: (dispatchId: string) => Promise<boolean>
  /** Read the ticket's mapped git worktree inspection, if any. */
  readonly onTicketWorktree?: (ticketId: string) => Promise<WorktreeInspectionView | undefined>
  /** Clean up the ticket's mapped git worktree directory. */
  readonly onTicketWorktreeRemove?: (ticketId: string) => Promise<boolean>
  /** Update the ticket's prerequisite dependencies (`dependsOn`). */
  readonly onSetTicketDependencies?: (input: { readonly ticketId: string; readonly dependsOn: readonly string[] }) => Promise<boolean>
  /** Manually close/abandon the ticket (`ended`). */
  readonly onCloseTicket?: (input: { readonly ticketId: string; readonly reason?: string }) => Promise<boolean>
}

const DISPATCH_STATE_KEYS = {
  'queued': 'board.detail.dispatch.state.queued',
  'running': 'board.detail.dispatch.state.running',
  'ended': 'board.detail.dispatch.state.ended',
} as const satisfies Record<DispatchView['state'], `board.detail.dispatch.state.${DispatchView['state']}`>

const DISPATCH_OUTCOME_KEYS = {
  'ready': 'board.detail.dispatch.outcome.ready',
  'failed': 'board.detail.dispatch.outcome.failed',
  'not-needed': 'board.detail.dispatch.outcome.not-needed',
  'interrupted': 'board.detail.dispatch.outcome.interrupted',
} as const satisfies Record<NonNullable<DispatchView['outcome']>, `board.detail.dispatch.outcome.${NonNullable<DispatchView['outcome']>}`>

const OUTCOME_TONE: Record<NonNullable<DispatchView['outcome']>, TagTone> = {
  'ready': 'success',
  'failed': 'danger',
  'not-needed': 'neutral',
  'interrupted': 'warning',
}

const TICKET_STATE_TONE: Record<TicketDetailView['ticket']['state'], TagTone> = {
  'todo': 'neutral',
  'running': 'info',
  'attention': 'warning',
  'ended': 'success',
}

/** Pipeline walk sidebar section: stage progression, skip decisions, and per-stage refs. */
function FlowTimeline({ timeline, t }: {
  timeline: FlowTimelineView
  t: TranslateNS<'dshManager'>
}) {
  return (
    <section className={css.detailSection} aria-label={t('board.detail.flow.title')}>
      <h3>{t('board.detail.flow.title', { pipeline: timeline.pipelineName })}</h3>
      {timeline.pendingSkip !== undefined
        ? (
          <p className={css.detailStatus}>
            {t('board.detail.flow.pendingSkip', { stage: timeline.pendingSkip.stageIndex + 1, reason: timeline.pendingSkip.reason })}
          </p>
        )
        : null}
      <ul className={css.detailList}>
        {timeline.stages.map(stage => (
          <li key={stage.ticketId} className={css.detailSidebarItem} data-flow-stage={stage.stageIndex}>
            <span className={css.detailDispatchState}>
              {t('board.detail.flow.stage', { stage: stage.stageIndex + 1, count: timeline.stageCount })}
            </span>
            <Tag tone={TICKET_STATE_TONE[stage.state]}>{t(`board.column.${stage.state}`)}</Tag>
            {stage.memberName !== undefined && stage.memberName !== ''
              ? <span className={css.detailDispatchReport}>{stage.memberName}</span>
              : null}
            {stage.deliverables?.map(path => (
              <code key={path} className={css.detailPath}>{path}</code>
            ))}
          </li>
        ))}
      </ul>
      {timeline.skipped.length > 0
        ? (
          <div className={css.detailSection}>
            <h4>{t('board.detail.flow.skipped')}</h4>
            <ul className={css.detailList}>
              {timeline.skipped.map(entry => (
                <li key={entry.stageIndex} className={css.detailSidebarItem}>
                  {t('board.detail.flow.skipReason', { stage: entry.stageIndex + 1, reason: entry.reason })}
                </li>
              ))}
            </ul>
          </div>
        )
        : null}
    </section>
  )
}

/** The latest non-progress report's message, or the newest one's. */
function reportLine(dispatch: DispatchView): string | undefined {
  const meaningful = dispatch.reports.filter(report => report.kind !== 'progress')
  const newest = meaningful.at(-1) ?? dispatch.reports.at(-1)
  return newest === undefined ? undefined : `${newest.kind}: ${newest.message}`
}

/** Resolve unified readable messages from Host or fall back cleanly to dispatch reports. */
function dispatchMessages(dispatch: DispatchView): readonly DispatchMessageView[] {
  if (dispatch.messages !== undefined) return dispatch.messages
  return dispatch.reports.map(report => {
    const cat = report.activity?.category
    const role: DispatchMessageView['role'] = cat === 'message'
      ? 'assistant'
      : (cat === 'tool' || cat === 'command' || cat === 'file')
        ? 'tool'
        : 'report'
    return {
      id: report.id,
      role,
      text: report.message,
      ...(report.activity?.toolName === undefined ? {} : { toolName: report.activity.toolName }),
      ...(cat === undefined ? {} : { category: cat }),
      at: report.at,
    }
  })
}

/** Whether a text looks like structured Markdown rather than a one-line status tag. */
function isRichMarkdown(text: string): boolean {
  return text.includes('\n') || text.includes('```') || text.includes('`') || /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text)
}

/** Follow-up chain sidebar block: parent ticket and minted downstream tickets. */
function FollowUpChain({ detail, t, onOpenTicket }: {
  detail: TicketDetailView
  t: TranslateNS<'dshManager'>
  onOpenTicket: (ticketId: string) => void
}) {
  const parent = detail.followUpOf
  return (
    <section className={css.detailSection}>
      <h3>{t('board.detail.chain')}</h3>
      {parent === undefined
        ? <p className={css.detailStatus}>{t('board.detail.chain.noParent')}</p>
        : (
          <button type="button" className={css.detailChangeFile} onClick={() => { onOpenTicket(parent.id) }}>
            {t('board.detail.chain.parent', { title: parent.title })}
          </button>
        )}
      {detail.followUps.length === 0
        ? <p className={css.detailStatus}>{t('board.detail.chain.noChildren')}</p>
        : (
          <ul className={css.detailList}>
            {detail.followUps.map(child => (
              <li key={child.id} className={css.detailSidebarItem}>
                <button type="button" className={css.detailChangeFile} onClick={() => { onOpenTicket(child.id) }}>
                  {child.title}
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/**
 * Multica-inspired Ticket Detail Workbench: left column carries mandate,
 * dispatch stream (with rich Markdown replies + grouped tool activity),
 * and worktree diff; right sidebar carries properties, pipeline progress,
 * follow-up chain, deliverables, and session change diffs.
 */
export function TicketDetailPanel({ ticketId, attentions, projects, connections, t, onClose, onOpenTicket, onAnswerAttention, actions }: {
  ticketId: string
  attentions?: readonly AttentionView[] | undefined
  projects?: readonly ProjectRef[] | undefined
  connections?: readonly ConnectionView[] | undefined
  t: TranslateNS<'dshManager'>
  onClose: () => void
  onOpenTicket: (ticketId: string) => void
  onAnswerAttention?: (input: { attentionId: string; answer: string }) => Promise<boolean>
  actions: TicketDetailActions
}) {
  const [detail, setDetail] = useState<TicketDetailView | undefined>()
  const [timeline, setTimeline] = useState<FlowTimelineView | undefined>()
  const [worktree, setWorktree] = useState<WorktreeInspectionView | undefined>()
  const [worktreeDiffOpen, setWorktreeDiffOpen] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | undefined>()
  const [dispatching, setDispatching] = useState(false)
  const [removingWorktree, setRemovingWorktree] = useState(false)
  const [updatingDeps, setUpdatingDeps] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [closingTicket, setClosingTicket] = useState(false)
  const [depInput, setDepInput] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  const [failed, setFailed] = useState(false)
  const [openChange, setOpenChange] = useState<ChangesRef | undefined>()
  const [diff, setDiff] = useState<FileDiffView | undefined>()
  const [diffLoading, setDiffLoading] = useState(false)

  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel: t('board.detail.code.copy'),
      copiedLabel: t('board.detail.code.copied'),
    },
    footnotes: t('board.detail.code.footnotes'),
  }), [t])

  const { onTicketDetail, onFlowTimeline, onTicketWorktree } = actions
  useEffect(() => {
    setDetail(undefined)
    setTimeline(undefined)
    setWorktree(undefined)
    setWorktreeDiffOpen(false)
    setConfirmingClose(false)
    setClosingTicket(false)
    setFailed(false)
    setOpenChange(undefined)
    setDiff(undefined)
    setReloadSeq(0)
  }, [ticketId])
  useEffect(() => {
    let alive = true
    void onTicketDetail(ticketId).then((read) => {
      if (!alive) return
      if (read === undefined) setFailed(true)
      else setDetail(read)
    })
    void onFlowTimeline?.(ticketId).then((read) => {
      if (!alive || read === undefined) return
      setTimeline(read)
    }).catch(() => {})
    void onTicketWorktree?.(ticketId).then((read) => {
      if (!alive) return
      setWorktree(read)
    }).catch(() => {})
    return () => { alive = false }
  }, [ticketId, reloadSeq, onTicketDetail, onFlowTimeline, onTicketWorktree])

  const hasActiveDispatch = detail?.dispatches.some(d => d.state === 'running' || d.state === 'queued') ?? false
  useEffect(() => {
    if (!hasActiveDispatch) return
    const timer = setInterval(() => {
      setReloadSeq(seq => seq + 1)
    }, 2000)
    return () => { clearInterval(timer) }
  }, [hasActiveDispatch])

  const cancelRun = (dispatchId: string): void => {
    if (actions.onDispatchCancel === undefined) return
    setCancellingId(dispatchId)
    void actions.onDispatchCancel(dispatchId)
      .finally(() => {
        setCancellingId(undefined)
        setReloadSeq(seq => seq + 1)
      })
  }
  const triggerDispatch = (): void => {
    if (actions.onDispatchTicket === undefined) return
    setDispatching(true)
    void actions.onDispatchTicket(ticketId)
      .finally(() => {
        setDispatching(false)
        setReloadSeq(seq => seq + 1)
      })
  }
  const removeWorktree = (): void => {
    if (actions.onTicketWorktreeRemove === undefined) return
    setRemovingWorktree(true)
    void actions.onTicketWorktreeRemove(ticketId)
      .finally(() => {
        setRemovingWorktree(false)
        setWorktreeDiffOpen(false)
        setReloadSeq(seq => seq + 1)
      })
  }
  const updateDeps = (nextDeps: readonly string[]): void => {
    if (actions.onSetTicketDependencies === undefined || updatingDeps) return
    setUpdatingDeps(true)
    void actions.onSetTicketDependencies({ ticketId, dependsOn: nextDeps })
      .then((ok) => { if (ok) setDepInput('') })
      .finally(() => {
        setUpdatingDeps(false)
        setReloadSeq(seq => seq + 1)
      })
  }
  const closeCurrentTicket = (): void => {
    if (actions.onCloseTicket === undefined || closingTicket) return
    if (!confirmingClose) {
      setConfirmingClose(true)
      return
    }
    setClosingTicket(true)
    void actions.onCloseTicket({ ticketId })
      .then((ok) => {
        if (ok) {
          setConfirmingClose(false)
          setReloadSeq(seq => seq + 1)
        }
      })
      .finally(() => { setClosingTicket(false) })
  }
  const openDiff = (change: ChangesRef, index: number): void => {
    setOpenChange(change)
    setDiffLoading(true)
    setDiff(undefined)
    void actions.onTicketChangeDiff({ sessionId: change.sessionId, seq: change.seq, index }).then((read) => {
      setDiffLoading(false)
      setDiff(read)
    })
  }

  const latestDispatch = detail?.dispatches[0]
  const activeAgentKind = latestDispatch?.agentKind ?? 'builtin'
  const resolvedProjectName = detail?.ticket.projectName
    ?? (detail?.ticket.projectId === undefined ? undefined : projects?.find(p => p.id === detail.ticket.projectId)?.name)
  const resolvedConnectionName = detail?.ticket.sourceConnectionName
    ?? (detail?.ticket.sourceConnectionId === undefined ? undefined : connections?.find(c => c.id === detail.ticket.sourceConnectionId)?.name)
  const rawSessionId = latestDispatch?.externalSessionId ?? latestDispatch?.sessionId
  const resolvedSessionName = latestDispatch?.sessionTitle
    ?? (rawSessionId === undefined ? undefined : t(`crew.agentKind.${activeAgentKind}`))

  return (
    <div className={css.detailOverlay} role="dialog" aria-label={t('board.detail.title')}>
      <div className={css.detailPanel}>
        <header className={css.detailHeader}>
          <div className={css.detailHeaderTitle}>
            {detail !== undefined
              ? <Tag tone={TICKET_STATE_TONE[detail.ticket.state]}>{t(`board.column.${detail.ticket.state}`)}</Tag>
              : null}
            <strong>{detail?.ticket.title ?? ticketId}</strong>
            <code className={css.detailPath}>{detail?.ticket.externalKey ?? ticketId}</code>
          </div>
          <div className={css.detailHeaderActions}>
            {hasActiveDispatch
              ? <span className={css.detailLiveBadge}>{t('board.detail.live')}</span>
              : null}
            {detail !== undefined && !hasActiveDispatch && detail.ticket.state !== 'ended' && actions.onDispatchTicket !== undefined
              ? (
                <Button variant="outline" size="sm" disabled={dispatching} onClick={triggerDispatch}>
                  {dispatching ? t('board.detail.dispatch.retrying') : t('board.detail.dispatch.retry')}
                </Button>
              )
              : null}
            {detail !== undefined && detail.ticket.state !== 'ended' && actions.onCloseTicket !== undefined
              ? (
                <Button variant="ghost" size="sm" disabled={closingTicket} onClick={closeCurrentTicket}>
                  {closingTicket
                    ? t('board.detail.ticket.closing')
                    : confirmingClose
                      ? t('board.detail.ticket.confirmClose')
                      : t('board.detail.ticket.close')}
                </Button>
              )
              : null}
            <Button variant="ghost" size="sm" onClick={() => { setReloadSeq(seq => seq + 1) }}>
              {t('board.detail.refresh')}
            </Button>
            <button type="button" className={css.detailClose} onClick={onClose} aria-label={t('board.detail.close')}>×</button>
          </div>
        </header>

        {failed ? <div className={css.detailMain}><p className={css.detailStatus}>{t('board.detail.failed')}</p></div> : null}
        {!failed && detail === undefined ? <div className={css.detailMain}><p className={css.detailStatus}>{t('board.detail.loading')}</p></div> : null}

        {detail !== undefined
          ? (
            <div className={css.detailLayout}>
              <div className={css.detailMain}>
                {attentions !== undefined && attentions.length > 0 && onAnswerAttention !== undefined
                  ? (
                    <section className={css.detailSection} aria-label={t('board.detail.attentions.title')}>
                      <h3>{t('board.detail.attentions.title')}</h3>
                      <div className={css.detailList}>
                        {attentions.map(attention => (
                          <AttentionAnswerForm
                            key={attention.id}
                            attention={attention}
                            t={t}
                            onAnswerAttention={onAnswerAttention}
                          />
                        ))}
                      </div>
                    </section>
                  )
                  : null}

                {detail.ticket.mandate !== undefined
                  ? (
                    <section className={css.detailMandateCard}>
                      <div className={css.detailMandateHeader}>
                        <span>{t('board.detail.mandate.title')}</span>
                        <Tag tone={detail.ticket.mandate.strength === 'explicit' ? 'info' : 'neutral'}>
                          {detail.ticket.mandate.strength}
                        </Tag>
                      </div>
                      <div className={css.detailMarkdownCard}>
                        <MarkdownText text={detail.ticket.mandate.scope} labels={markdownLabels} omitHtml />
                      </div>
                    </section>
                  )
                  : null}

                <section className={css.detailSection}>
                  <h3>{t('board.detail.dispatch.title')}</h3>
                  {detail.dispatches.length === 0 ? <p className={css.detailStatus}>{t('board.detail.dispatch.empty')}</p> : null}
                  <ul className={css.detailList}>
                    {detail.dispatches.map(dispatch => {
                      const messages = dispatchMessages(dispatch).slice(-24)
                      const toolMessages = messages.filter(m => m.role === 'tool')
                      const conversationMessages = messages.filter(m => m.role !== 'tool')
                      const active = dispatch.state === 'running' || dispatch.state === 'queued'
                      const isErrorCard = dispatch.outcome === 'failed'
                      return (
                        <li key={dispatch.id} className={css.detailItem} data-dispatch-state={dispatch.state}>
                          <div className={css.detailDispatchHeader}>
                            <span className={css.detailDispatchState}>{t(DISPATCH_STATE_KEYS[dispatch.state])}</span>
                            <Tag tone="neutral">{t(`crew.agentKind.${dispatch.agentKind ?? 'builtin'}`)}</Tag>
                            {dispatch.outcome !== undefined
                              ? <Tag tone={OUTCOME_TONE[dispatch.outcome]}>{t(DISPATCH_OUTCOME_KEYS[dispatch.outcome])}</Tag>
                              : null}
                            {(dispatch.externalSessionId ?? dispatch.sessionId) !== undefined
                              ? <code className={css.detailPath}>{dispatch.externalSessionId ?? dispatch.sessionId}</code>
                              : null}
                            {active && actions.onDispatchCancel !== undefined
                              ? (
                                <button
                                  type="button"
                                  className={css.detailCancelBtn}
                                  disabled={cancellingId === dispatch.id}
                                  onClick={() => { cancelRun(dispatch.id) }}
                                >
                                  {cancellingId === dispatch.id ? t('board.detail.dispatch.cancelling') : t('board.detail.dispatch.cancel')}
                                </button>
                              )
                              : null}
                          </div>

                          {messages.length === 0 && active
                            ? <p className={css.detailStatus}>{t('board.detail.dispatch.emptyMessages')}</p>
                            : null}

                          <details className={css.detailToolGroup}>
                            <summary className={css.detailToolSummary}>
                              {t('board.detail.dispatch.prompt.title')}
                              {dispatch.prompt !== undefined
                                ? ` · ${dispatch.prompt.turnId} · ${t('board.detail.dispatch.prompt.revision', { rev: dispatch.prompt.templateRevision })}`
                                : ''}
                            </summary>
                            {dispatch.prompt === undefined
                              ? <p className={css.detailStatus}>{t('board.detail.dispatch.prompt.legacy')}</p>
                              : (
                                <div className={css.detailList}>
                                  <div className={css.detailWorktreeRow}>
                                    {dispatch.prompt.sections.map(sec => (
                                      <span key={sec.id} className={css.detailActivityTag}>
                                        {sec.id}:{t(`board.detail.dispatch.prompt.source.${sec.source}`)}
                                        {sec.locked ? `(${t('board.detail.dispatch.prompt.locked')})` : ''}
                                      </span>
                                    ))}
                                    {dispatch.prompt.truncated
                                      ? <Tag tone="warning">{t('board.detail.dispatch.prompt.truncated')}</Tag>
                                      : null}
                                  </div>
                                  <pre className={css.detailDiffPre}>{dispatch.prompt.text}</pre>
                                </div>
                              )}
                          </details>

                          {toolMessages.length > 0
                            ? (
                              <details className={css.detailToolGroup} open={active || toolMessages.length <= 3}>
                                <summary className={css.detailToolSummary}>
                                  {t('board.detail.dispatch.tools', { count: toolMessages.length })}
                                </summary>
                                <ul className={css.detailToolItems}>
                                  {toolMessages.map(msg => (
                                    <li key={msg.id} className={css.detailActivityRow}>
                                      <span className={css.detailActivityTag}>{msg.category ?? 'tool'}</span>
                                      <span>{msg.text}</span>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )
                            : null}

                          {conversationMessages.length > 0
                            ? (
                              <ul className={css.detailActivityList} aria-label={t('board.detail.dispatch.messages')}>
                                {conversationMessages.map(msg => (
                                  <li
                                    key={msg.id}
                                    className={`${css.detailAssistantCard}${msg.role === 'report' && isErrorCard ? ` ${css.detailReportErrorCard}` : ''}`}
                                  >
                                    <div className={css.detailAssistantMeta}>
                                      <span>
                                        {msg.role === 'assistant'
                                          ? t('board.detail.dispatch.role.assistant')
                                          : t('board.detail.dispatch.role.report')}
                                      </span>
                                      <span>{new Date(msg.at).toLocaleTimeString()}</span>
                                    </div>
                                    {msg.role === 'assistant' || isRichMarkdown(msg.text)
                                      ? (
                                        <div className={css.detailMarkdownCard}>
                                          <MarkdownText text={msg.text} labels={markdownLabels} omitHtml />
                                        </div>
                                      )
                                      : <p className={css.detailAssistantBody}>{msg.text}</p>}
                                  </li>
                                ))}
                              </ul>
                            )
                            : reportLine(dispatch) !== undefined
                              ? <p className={css.detailDispatchReport}>{reportLine(dispatch)}</p>
                              : null}
                        </li>
                      )
                    })}
                  </ul>
                </section>

                {worktree !== undefined
                  ? (
                    <section className={css.detailSection}>
                      <h3>{t('board.detail.worktree.title')}</h3>
                      {!worktree.exists
                        ? <p className={css.detailStatus}>{t('board.detail.worktree.empty')}</p>
                        : (
                          <div className={css.detailWorktreeCard}>
                            <div className={css.detailWorktreeRow}>
                              <code className={css.detailPath}>{t('board.detail.worktree.branch', { branch: worktree.branch })}</code>
                              <span className={css.detailStatus}>
                                {worktree.dirtyFiles.length === 0
                                  ? t('board.detail.worktree.clean')
                                  : t('board.detail.worktree.dirtyCount', { count: worktree.dirtyFiles.length })}
                              </span>
                              <span className={css.detailWorktreeActions}>
                                {(worktree.diff !== '' || worktree.stat !== '')
                                  ? (
                                    <button
                                      type="button"
                                      className={css.detailChangeFile}
                                      onClick={() => { setWorktreeDiffOpen(open => !open) }}
                                    >
                                      {worktreeDiffOpen ? t('board.detail.worktree.hideDiff') : t('board.detail.worktree.toggleDiff')}
                                    </button>
                                  )
                                  : null}
                                {actions.onTicketWorktreeRemove !== undefined
                                  ? (
                                    <button
                                      type="button"
                                      className={css.detailCancelBtn}
                                      disabled={removingWorktree || hasActiveDispatch}
                                      onClick={removeWorktree}
                                    >
                                      {removingWorktree ? t('board.detail.worktree.removing') : t('board.detail.worktree.remove')}
                                    </button>
                                  )
                                  : null}
                              </span>
                            </div>
                            {worktreeDiffOpen && (worktree.stat !== '' || worktree.diff !== '')
                              ? (
                                <pre className={css.detailDiffPre}>
                                  {[worktree.stat, worktree.diff].filter(part => part !== '').join('\n\n')}
                                </pre>
                              )
                              : null}
                          </div>
                        )}
                    </section>
                  )
                  : null}
              </div>

              <aside className={css.detailSidebar}>
                <section className={css.detailSection}>
                  <h3>{t('board.detail.properties.title')}</h3>
                  <div className={css.detailPropGrid}>
                    <span className={css.detailPropLabel}>{t('board.detail.properties.state')}</span>
                    <span className={css.detailPropValue}>
                      <Tag tone={TICKET_STATE_TONE[detail.ticket.state]}>{t(`board.column.${detail.ticket.state}`)}</Tag>
                    </span>
                    <span className={css.detailPropLabel}>{t('board.detail.properties.executor')}</span>
                    <span className={css.detailPropValue}>{t(`crew.agentKind.${activeAgentKind}`)}</span>
                    {detail.ticket.projectId !== undefined
                      ? (
                        <>
                          <span className={css.detailPropLabel}>{t('board.detail.properties.project')}</span>
                          <span className={css.detailPropValue} title={detail.ticket.projectId}>
                            {resolvedProjectName ?? detail.ticket.projectId}
                          </span>
                        </>
                      )
                      : null}
                    {detail.ticket.sourceConnectionId !== undefined
                      ? (
                        <>
                          <span className={css.detailPropLabel}>{t('board.detail.properties.source')}</span>
                          <span className={css.detailPropValue} title={detail.ticket.sourceConnectionId}>
                            {resolvedConnectionName ?? detail.ticket.sourceConnectionId}
                          </span>
                        </>
                      )
                      : null}
                    {detail.ticket.externalKey !== undefined
                      ? (
                        <>
                          <span className={css.detailPropLabel}>{t('board.detail.properties.externalKey')}</span>
                          <span className={css.detailPropValue}>
                            {hasExternalUrl(detail.ticket.url)
                              ? <a className={css.cardTitle} href={detail.ticket.url} target="_blank" rel="noreferrer">{detail.ticket.externalKey}</a>
                              : <code className={css.detailPath}>{detail.ticket.externalKey}</code>}
                          </span>
                        </>
                      )
                      : null}
                    {detail.ticket.threadId !== ''
                      ? (
                        <>
                          <span className={css.detailPropLabel}>{t('board.detail.properties.thread')}</span>
                          <code className={`${css.detailPropValue} ${css.detailPath}`}>{detail.ticket.threadId}</code>
                        </>
                      )
                      : null}
                    {resolvedSessionName !== undefined
                      ? (
                        <>
                          <span className={css.detailPropLabel}>{t('board.detail.properties.session')}</span>
                          <span className={css.detailPropValue} title={rawSessionId}>
                            {resolvedSessionName}
                          </span>
                        </>
                      )
                      : null}
                  </div>
                </section>

                {timeline !== undefined ? <FlowTimeline timeline={timeline} t={t} /> : null}
                {(detail.ticket.dependsOn !== undefined && detail.ticket.dependsOn.length > 0)
                  || (detail.ticket.waitingOn !== undefined && detail.ticket.waitingOn.length > 0)
                  || detail.ticket.supersededBy !== undefined
                  || actions.onSetTicketDependencies !== undefined
                  ? (
                    <section className={css.detailSection} aria-label={t('board.detail.dependencies.title')}>
                      <h3>{t('board.detail.dependencies.title')}</h3>
                      {detail.ticket.supersededBy !== undefined
                        ? (
                          <p className={css.detailStatus}>
                            <button type="button" className={css.detailChainLink} onClick={() => { onOpenTicket(detail.ticket.supersededBy!) }}>
                              {t('board.detail.dependencies.supersededBy', { id: detail.ticket.supersededBy })}
                            </button>
                          </p>
                        )
                        : null}
                      {(detail.ticket.dependsOn?.length ?? 0) === 0 && (detail.ticket.waitingOn?.length ?? 0) === 0
                        ? <p className={css.detailStatus}>{t('board.detail.dependencies.empty')}</p>
                        : (
                          <ul className={css.detailList}>
                            {(detail.ticket.waitingOn ?? detail.ticket.dependsOn?.map(id => ({ id, title: id, state: 'todo' as const })) ?? []).map(dep => (
                              <li key={dep.id} className={css.detailSidebarItem}>
                                <button type="button" className={css.detailChainLink} onClick={() => { onOpenTicket(dep.id) }}>
                                  {dep.title}
                                </button>
                                <Tag tone={TICKET_STATE_TONE[dep.state]}>{t(`board.column.${dep.state}`)}</Tag>
                                {actions.onSetTicketDependencies !== undefined
                                  ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={updatingDeps}
                                      onClick={() => {
                                        updateDeps((detail.ticket.dependsOn ?? []).filter(id => id !== dep.id))
                                      }}
                                    >
                                      {t('board.detail.dependencies.remove')}
                                    </Button>
                                  )
                                  : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      {actions.onSetTicketDependencies !== undefined
                        ? (
                          <div className={css.detailWorktreeActions}>
                            {(detail.ticket.waitingOn?.length ?? 0) > 0
                              ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={updatingDeps}
                                  onClick={() => { updateDeps([]) }}
                                >
                                  {updatingDeps ? t('board.detail.dependencies.unlocking') : t('board.detail.dependencies.unlock')}
                                </Button>
                              )
                              : null}
                            <div className={css.attentionAnswerRow}>
                              <input
                                className={css.manualInput}
                                value={depInput}
                                onChange={event => setDepInput(event.target.value)}
                                placeholder={t('board.detail.dependencies.addPlaceholder')}
                              />
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={updatingDeps || depInput.trim() === ''}
                                onClick={() => {
                                  const next = [...(detail.ticket.dependsOn ?? []), depInput.trim()]
                                  updateDeps(next)
                                }}
                              >
                                {t('board.detail.dependencies.add')}
                              </Button>
                            </div>
                          </div>
                        )
                        : null}
                    </section>
                  )
                  : null}
                {detail.ticket.fanIn !== undefined && detail.ticket.fanIn.length > 0
                  ? (
                    <section className={css.detailSection}>
                      <h3>{t('board.detail.fanIn.title')}</h3>
                      <ul className={css.detailList}>
                        {detail.ticket.fanIn.map(item => (
                          <li key={item.id} className={css.detailSidebarItem}>
                            {hasExternalUrl(item.url)
                              ? <a href={item.url} target="_blank" rel="noreferrer">{t('board.card.fanIn', { external: item.externalKey })}</a>
                              : <span>{t('board.card.fanIn', { external: item.externalKey })}</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                  : null}
                <FollowUpChain detail={detail} t={t} onOpenTicket={onOpenTicket} />

                <section className={css.detailSection}>
                  <h3>{t('board.detail.deliverables')}</h3>
                  {detail.deliverables.length === 0 ? <p className={css.detailStatus}>{t('board.detail.deliverables.empty')}</p> : null}
                  <ul className={css.detailList}>
                    {detail.deliverables.map((deliverable: DeliverableRef, index) => (
                      <li key={`${deliverable.sessionId}-${deliverable.turn}-${index}`} className={css.detailSidebarItem}>
                        <code className={css.detailPath}>{deliverable.path}</code>
                        <span className={css.detailRef}>
                          {t('board.detail.ref', { session: deliverable.sessionId, turn: deliverable.turn })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className={css.detailSection}>
                  <h3>{t('board.detail.changes')}</h3>
                  {detail.changes.length === 0 ? <p className={css.detailStatus}>{t('board.detail.changes.empty')}</p> : null}
                  <ul className={css.detailList}>
                    {detail.changes.map((change: ChangesRef) => (
                      <li key={`${change.sessionId}-${change.seq}`} className={css.detailSidebarItem}>
                        <span>{t('board.detail.change.files', { turn: change.turn, files: change.files })}</span>
                        <span className={css.detailChangeFiles}>
                          {Array.from({ length: change.files }, (_, index) => (
                            <button key={index} type="button" className={css.detailChangeFile} onClick={() => { openDiff(change, index) }}>
                              #{index + 1}
                            </button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {openChange !== undefined
                    ? (
                      <div className={css.diffView}>
                        <h4>{t('board.detail.diff.title', { turn: openChange.turn })}</h4>
                        {diffLoading ? <p className={css.detailStatus}>{t('board.detail.diff.loading')}</p> : null}
                        {!diffLoading && diff === undefined ? <p className={css.detailStatus}>{t('board.detail.diff.missing')}</p> : null}
                        {diff !== undefined && diff.kind !== 'text'
                          ? <p className={css.detailStatus}>{t(diff.kind === 'binary' ? 'board.detail.diff.binary' : 'board.detail.diff.oversized')}</p>
                          : null}
                        {diff?.kind === 'text'
                          ? (
                            <>
                              <p className={css.detailPath}><code>{diff.display}</code></p>
                              {diff.hunks.length === 0 ? <p className={css.detailStatus}>{t('board.detail.diff.unchanged')}</p> : null}
                              {diff.hunks.map((hunk, hunkIndex) => (
                                <table key={hunkIndex} className={css.diffTable}>
                                  <tbody>
                                    {hunk.lines.map((line, lineIndex) => (
                                      <tr
                                        key={lineIndex}
                                        className={css.diffRow}
                                        data-diff={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'}
                                      >
                                        <td className={css.diffSign}>{line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' '}</td>
                                        <td className={css.diffText}>{line.slice(1)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ))}
                            </>
                          )
                          : null}
                      </div>
                    )
                    : null}
                </section>
              </aside>
            </div>
          )
          : null}
      </div>
    </div>
  )
}
