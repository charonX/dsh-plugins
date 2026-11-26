/**
 * The ticket workbench: a right-side drawer that keeps one ticket's whole
 * conversation in place. The timeline is the ticket's own ledger (not the live
 * Session's), the composer at the bottom means "dispatch / steer / continue"
 * depending on state, and every property block folds into one disclosure.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, MarkdownText, Tag, type MarkdownLabels, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangesRef, DeliverableRef, FileDiffView, TicketChangeDiffInput, TicketDetailView, WorktreeInspectionView } from '../dispatch/wire-types.ts'
import type { AttentionView } from '../attention/wire-types.ts'
import type { ConnectionView } from '../connections/wire-types.ts'
import type { FlowTimelineView } from '../flow/flow-core.ts'
import type { ProjectRef } from '../mappings/wire-types.ts'
import type { ContinueTicketResult } from '../dispatch/wire-types.ts'
import { TicketComposer } from './TicketComposer.tsx'
import { TicketTimeline } from './TicketTimeline.tsx'
import { hasExternalUrl } from './url.ts'
import css from './BoardPage.module.css'

/** The reads and writes the workbench makes through the injected board source. */
export interface TicketDetailActions {
  /** Read one ticket's whole detail; `undefined` marks a failed read. */
  readonly onTicketDetail: (ticketId: string) => Promise<TicketDetailView | undefined>
  /** Read one ticket's pipeline walk; `undefined` when the ticket walks no pipeline. */
  readonly onFlowTimeline?: (ticketId: string) => Promise<FlowTimelineView | undefined>
  /** Resolve one change ref through the harness diff view; `undefined` marks a failed read. */
  readonly onTicketChangeDiff: (input: TicketChangeDiffInput) => Promise<FileDiffView | undefined>
  /** Enqueue a new dispatch for a todo ticket. */
  readonly onDispatchTicket?: (ticketId: string) => Promise<boolean>
  /** Cancel a queued or running dispatch on user request. */
  readonly onDispatchCancel?: (dispatchId: string) => Promise<boolean>
  /** Append one instruction to the ticket, resuming its session when it had ended. */
  readonly onContinueTicket?: (input: { readonly ticketId: string; readonly text: string; readonly newSession?: boolean }) => Promise<ContinueTicketResult | undefined>
  /** Read the ticket's mapped git worktree inspection, if any. */
  readonly onTicketWorktree?: (ticketId: string) => Promise<WorktreeInspectionView | undefined>
  /** Clean up the ticket's mapped git worktree directory. */
  readonly onTicketWorktreeRemove?: (ticketId: string) => Promise<boolean>
  /** Update the ticket's prerequisite dependencies (`dependsOn`). */
  readonly onSetTicketDependencies?: (input: { readonly ticketId: string; readonly dependsOn: readonly string[] }) => Promise<boolean>
  /** Manually close/abandon the ticket (`ended`). */
  readonly onCloseTicket?: (input: { readonly ticketId: string; readonly reason?: string }) => Promise<boolean>
  /** Open the dispatch's Session in the host workspace, when one exists. */
  readonly onOpenSession?: (sessionId: string) => void
}

const DISPATCH_OUTCOME_KEYS = {
  'ready': 'board.detail.dispatch.outcome.ready',
  'failed': 'board.detail.dispatch.outcome.failed',
  'not-needed': 'board.detail.dispatch.outcome.not-needed',
  'interrupted': 'board.detail.dispatch.outcome.interrupted',
} as const

const OUTCOME_TONE: Record<'ready' | 'failed' | 'not-needed' | 'interrupted', TagTone> = {
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

/** Pipeline walk block: stage progression, skip decisions, and per-stage refs. */
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

/** Follow-up chain block: parent ticket and minted downstream tickets. */
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

function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Ticket workbench drawer: timeline + composer, with the property blocks folded
 * into one disclosure so the conversation keeps the whole column.
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
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const [removingWorktree, setRemovingWorktree] = useState(false)
  const [updatingDeps, setUpdatingDeps] = useState(false)
  const [closingTicket, setClosingTicket] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
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
    setClosingTicket(false)
    setFailed(false)
    setOpenChange(undefined)
    setDiff(undefined)
    setSendFailed(false)
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const cancelRun = (dispatchId: string): void => {
    if (actions.onDispatchCancel === undefined) return
    setCancellingId(dispatchId)
    void actions.onDispatchCancel(dispatchId)
      .finally(() => {
        setCancellingId(undefined)
        setReloadSeq(seq => seq + 1)
      })
  }
  const sendInstruction = (text: string): void => {
    if (actions.onContinueTicket === undefined || sending) return
    setSending(true)
    setSendFailed(false)
    void actions.onContinueTicket({ ticketId, text })
      .then((result) => {
        if (result === undefined || result.ok !== true) setSendFailed(true)
        else setReloadSeq(seq => seq + 1)
      })
      .finally(() => { setSending(false) })
  }
  const dispatchNow = (): void => {
    if (actions.onDispatchTicket === undefined || dispatching) return
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
    setClosingTicket(true)
    void actions.onCloseTicket({ ticketId })
      .finally(() => setClosingTicket(false))
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
  const pendingAttention = (attentions ?? []).find(attention => attention.status === 'pending')
  const hasPendingAttention = pendingAttention !== undefined || detail?.ticket.state === 'attention'
  const turns = detail?.events?.filter(event => event.turnId !== undefined) ?? []

  return (
    <div className={css.wbOverlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={css.wbScrim} aria-hidden="true" />
      <aside className={css.wb} role="dialog" aria-label={t('board.detail.title')} aria-modal="false">
        <header className={css.wbHead}>
          <div className={css.wbHeadMain}>
            <div className={css.wbTitleRow}>
              {detail !== undefined
                ? <Tag tone={TICKET_STATE_TONE[detail.ticket.state]}>{t(`board.column.${detail.ticket.state}`)}</Tag>
                : null}
              <strong className={css.wbTitle}>{detail?.ticket.title ?? ticketId}</strong>
              <code className={css.detailPath}>{detail?.ticket.externalKey ?? ticketId}</code>
            </div>
            <div className={css.wbMeta}>
              <span>{t(`crew.agentKind.${activeAgentKind}`)}</span>
              {resolvedProjectName !== undefined ? <span>{resolvedProjectName}</span> : null}
              {worktree?.branch !== undefined ? <span className={css.wbBranch}>{worktree.branch}</span> : null}
              <span>{t('board.workbench.turns', { n: turns.length })}</span>
              {hasActiveDispatch ? <span className={css.detailLiveBadge}>{t('board.detail.live')}</span> : null}
            </div>
          </div>
          <div className={css.wbHeadActions}>
            {rawSessionId !== undefined && actions.onOpenSession !== undefined
              ? (
                <Button variant="ghost" size="sm" onClick={() => { actions.onOpenSession?.(rawSessionId) }}>
                  {t('board.workbench.openSession')}
                </Button>
              )
              : null}
            {detail?.ticket.state === 'todo' ? (
              <Button variant="outline" size="sm" disabled={dispatching} onClick={dispatchNow}>
                {dispatching
                  ? t('board.detail.dispatch.retrying')
                  : detail.dispatches.length > 0 ? t('board.detail.dispatch.retry') : t('board.composer.dispatch')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => { setReloadSeq(seq => seq + 1) }}>
              {t('board.detail.refresh')}
            </Button>
            <button type="button" className={css.detailClose} onClick={onClose} aria-label={t('board.detail.close')}>×</button>
          </div>
        </header>

        {failed ? <div className={css.wbScroll}><p className={css.detailStatus}>{t('board.detail.failed')}</p></div> : null}
        {!failed && detail === undefined ? <div className={css.wbScroll}><p className={css.detailStatus}>{t('board.detail.loading')}</p></div> : null}

        {detail !== undefined
          ? (
            <>
              <div className={css.wbScroll}>
                <TicketTimeline
                  detail={detail}
                  attentions={attentions}
                  t={t}
                  markdownLabels={markdownLabels}
                  cancellingId={cancellingId}
                  {...(actions.onDispatchCancel === undefined ? {} : { onCancel: cancelRun })}
                  {...(onAnswerAttention === undefined ? {} : { onAnswerAttention })}
                />

                {detail.ticket.state === 'ended'
                  ? <div className={css.wbNotice}>{t('board.workbench.endedNotice')}</div>
                  : null}
                {detail.ticket.state === 'attention' && pendingAttention === undefined
                  ? <div className={css.wbNotice}>{t('board.workbench.attentionNotice')}</div>
                  : null}

                <details className={css.wbInfo}>
                  <summary className={css.wbInfoSummary}>
                    <span>{t('board.workbench.info')}</span>
                    <span className={css.wbInfoHint}>
                      {t('board.workbench.infoHint', {
                        dispatches: detail.dispatches.length,
                        deliverables: detail.deliverables.length,
                      })}
                    </span>
                  </summary>
                  <div className={css.wbInfoBody}>
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
                      : <p className={css.detailStatus}>{t('board.detail.mandate.missing')}</p>}

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
                        {rawSessionId !== undefined
                          ? (
                            <>
                              <span className={css.detailPropLabel}>{t('board.detail.properties.session')}</span>
                              <span className={css.detailPropValue} title={rawSessionId}>
                                <code className={css.detailPath}>{rawSessionId}</code>
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
                                    onChange={event => { setDepInput(event.target.value) }}
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

                    {detail.dispatches.length > 0
                      ? (
                        <section className={css.detailSection}>
                          <h3>{t('board.workbench.dispatchHistory')}</h3>
                          <ul className={css.detailList}>
                            {detail.dispatches.map((dispatch, index) => (
                              <li key={dispatch.id} className={css.detailSidebarItem} data-dispatch-state={dispatch.state}>
                                <span className={css.detailDispatchState}>
                                  {t('board.workbench.turn', { n: detail.dispatches.length - index })}
                                </span>
                                {dispatch.outcome !== undefined
                                  ? <Tag tone={OUTCOME_TONE[dispatch.outcome]}>{t(DISPATCH_OUTCOME_KEYS[dispatch.outcome])}</Tag>
                                  : null}
                                <span className={css.detailStatus}>{formatTime(dispatch.updatedAt)}</span>
                                {dispatch.prompt !== undefined
                                  ? (
                                    <details className={css.detailToolGroup}>
                                      <summary className={css.detailToolSummary}>
                                        {t('board.detail.dispatch.prompt.title')} · {t('board.detail.dispatch.prompt.revision', { rev: dispatch.prompt.templateRevision })}
                                      </summary>
                                      <pre className={css.detailDiffPre}>{dispatch.prompt.text}</pre>
                                    </details>
                                  )
                                  : null}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )
                      : null}

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

                    {detail.ticket.state !== 'ended' && actions.onCloseTicket !== undefined
                      ? (
                        <div className={css.detailWorktreeActions}>
                          {confirmingClose
                            ? (
                              <>
                                <Button variant="ghost" size="sm" onClick={() => { setConfirmingClose(false) }}>
                                  {t('board.detail.ticket.cancelClose')}
                                </Button>
                                <Button variant="primary" size="sm" disabled={closingTicket} onClick={closeCurrentTicket}>
                                  {closingTicket ? t('board.detail.ticket.closing') : t('board.detail.ticket.confirmClose')}
                                </Button>
                              </>
                            )
                            : (
                              <Button variant="ghost" size="sm" onClick={() => { setConfirmingClose(true) }}>
                                {t('board.detail.ticket.close')}
                              </Button>
                            )}
                        </div>
                      )
                      : null}
                  </div>
                </details>
              </div>

              <TicketComposer
                ticketId={ticketId}
                state={detail.ticket.state}
                hasPendingAttention={hasPendingAttention}
                sending={sending}
                failed={sendFailed}
                onSend={sendInstruction}
                t={t}
              />
            </>
          )
          : null}
      </aside>
    </div>
  )
}
