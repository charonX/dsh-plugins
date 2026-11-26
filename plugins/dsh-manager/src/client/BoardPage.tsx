/** The kanban board page occupying a main panel. */
import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BoardColumnId, TicketView } from '../board-domain.ts'
import { BOARD_FILTER_KINDS, type BoardFilter } from '../board/wire-types.ts'
import type { AttentionView } from '../attention/wire-types.ts'
import type { BoardInjected, BoardSnapshot } from './board-source.ts'
import type { FlowInjected } from './flow-source.ts'
import type { NotificationsInjected, NotificationsSnapshot } from './notifications-source.ts'
import type { StewardInjected } from './steward-source.ts'
import type { AgentKindOption } from '../flow/flow-ir.ts'
import type { CandidateView, EvalRecordView } from '../evals/wire-types.ts'
import { AttentionAnswerForm } from './AttentionAnswerForm.tsx'
import { TicketDetailPanel } from './TicketDetail.tsx'
import { DshSelect } from './DshSelect.tsx'
import { SlashInput, type SlashCommandGroup } from './SlashInput.tsx'
import { hasExternalUrl } from './url.ts'
import css from './BoardPage.module.css'


/** Board page props derived from the framework and the injected sources. */
export type BoardPageProps = PropsRuntime<'main'>
  & InjectFace<BoardInjected>
  & InjectFace<NotificationsInjected>
  & Partial<Pick<InjectFace<FlowInjected>, 'useFlows' | 'onAgentKindOptions'>>
  & Partial<Pick<InjectFace<StewardInjected>, 'useSteward'>>
  & { readonly onOpenMonitor?: () => void }
  & PropsLocale<'dshManager'>

const COLUMN_KEYS = {
  'inbox': 'board.column.inbox',
  'pool': 'board.column.pool',
  'todo': 'board.column.todo',
  'running': 'board.column.running',
  'attention': 'board.column.attention',
  'ended': 'board.column.ended',
} as const satisfies Record<BoardColumnId, `board.column.${BoardColumnId}`>

/** The column each ticket state projects onto. */
const STATE_COLUMN: Record<TicketView['state'], BoardColumnId> = {
  'todo': 'todo',
  'running': 'running',
  'attention': 'attention',
  'ended': 'ended',
}

/** How long one toast stays on screen. */
const TOAST_MS = 6000
const MAX_TOAST_BODY_CHARS = 160

/**
 * The notifications to toast now: each notification toasts once per page
 * visit, auto-dismisses independently (surviving background poll updates to
 * `feed`), and can be manually dismissed at any time.
 */
function useToastFeed(notifications: NotificationsSnapshot): {
  readonly toasts: readonly { id: string; title: string }[]
  readonly dismiss: (id: string) => void
} {
  const [toasts, setToasts] = useState<readonly { id: string; title: string }[]>([])
  const notified = useRef(new Set<string>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const feed = notifications.notifications ?? []

  const dismiss = (id: string): void => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts(current => current.filter(toast => toast.id !== id))
  }

  useEffect(() => {
    const fresh = feed.filter(notification => !notified.current.has(notification.id))
    if (fresh.length === 0) return
    for (const notification of fresh) {
      notified.current.add(notification.id)
      const timer = setTimeout(() => {
        timers.current.delete(notification.id)
        setToasts(current => current.filter(toast => toast.id !== notification.id))
      }, TOAST_MS)
      timers.current.set(notification.id, timer)
    }
    setToasts(current => [...current, ...fresh.map(({ id, title }) => ({ id, title }))])
  }, [feed])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  return { toasts, dismiss }
}

/** Compact Steward busy/idle status shortcut jumping to the Monitor tab. */
function BoardStewardChip({ useSteward, onOpenMonitor, t }: {
  useSteward: InjectFace<StewardInjected>['useSteward']
  onOpenMonitor?: (() => void) | undefined
  t: TranslateNS<'dshManager'>
}) {
  const snapshot = useSteward(s => s)
  if (snapshot.status !== 'ready' || snapshot.steward === undefined || onOpenMonitor === undefined) {
    return null
  }
  const { busy } = snapshot.steward
  const stateLabel = busy ? t('steward.busy') : t('steward.idle')
  return (
    <button
      type="button"
      className={css.stewardChip}
      onClick={onOpenMonitor}
      title={t('monitor.panel')}
    >
      <StateDot state={busy ? 'ongoing' : 'idle'} />
      <span>{t('board.steward.chip', { state: stateLabel })}</span>
    </button>
  )
}

/** Render the six board columns with their ticket cards, inbox candidates, and the rework pool. */
export function BoardPage(props: BoardPageProps) {  const { useBoard, useNotifications, useSteward, onOpenMonitor, onMarkSeen, onFilter, onAcceptCandidate, onEvalRequeue, onManualInput, onTicketDetail, onFlowTimeline, onTicketChangeDiff, onDispatchTicket, onDispatchCancel, onTicketWorktree, onTicketWorktreeRemove, onSetTicketDependencies, onCloseTicket, onAnswerAttention, onBoardRetry, t } = props
  const [openTicketId, setOpenTicketId] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const snapshot = useBoard(snapshot => snapshot)
  const notifications = useNotifications(snapshot => snapshot)
  // Opening the board page has seen the feed; the badge clears.
  useEffect(() => { onMarkSeen() }, [onMarkSeen])
  const { toasts: toastNotifications, dismiss: dismissToast } = useToastFeed(notifications)
  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <button type="button" className={css.retry} onClick={onBoardRetry}>{t('board.retry')}</button>
      </div>
    )
  }
  const summary = snapshot.summary
  if (snapshot.status === 'loading' || summary === undefined) {
    return <div className={css.empty}>{t('board.loading')}</div>
  }
  const filter = snapshot.filter ?? {}
  const changeFilter = (patch: Partial<BoardFilter>): void => {
    const next: BoardFilter = {
      ...(filter.connectionId === undefined ? {} : { connectionId: filter.connectionId }),
      ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.search === undefined ? {} : { search: filter.search }),
      ...patch,
    }
    onFilter({
      ...(next.connectionId === undefined ? {} : { connectionId: next.connectionId }),
      ...(next.projectId === undefined ? {} : { projectId: next.projectId }),
      ...(next.kind === undefined ? {} : { kind: next.kind }),
      ...(next.search === undefined ? {} : { search: next.search }),
    })
  }
  return (
    <div className={css.page}>
      <div className={css.toolbarRow}>
        <div className={css.filterRow}>
          <label className={css.manualField}>
            <span>{t('board.filter.connection')}</span>
            <DshSelect
              value={filter.connectionId ?? ''}
              options={[
                { value: '', label: t('board.filter.all') },
                ...(snapshot.connections ?? []).map(connection => ({ value: connection.id, label: connection.name })),
              ]}
              onChange={next => changeFilter({ connectionId: next === '' ? undefined : next })}
            />
          </label>
          <label className={css.manualField}>
            <span>{t('board.filter.project')}</span>
            <DshSelect
              value={filter.projectId ?? ''}
              options={[
                { value: '', label: t('board.filter.all') },
                ...(snapshot.projects ?? []).map(project => ({ value: project.id, label: project.name })),
              ]}
              onChange={next => changeFilter({ projectId: next === '' ? undefined : next })}
            />
          </label>
          <label className={css.manualField}>
            <span>{t('board.filter.kind')}</span>
            <DshSelect
              value={filter.kind ?? ''}
              options={[
                { value: '', label: t('board.filter.all') },
                ...BOARD_FILTER_KINDS.map(kind => ({ value: kind, label: t(`triggers.sources.kind.${kind}`) })),
              ]}
              onChange={next => changeFilter({ kind: next === '' ? undefined : next as BoardFilter['kind'] })}
            />
          </label>
          <label className={css.manualField}>
            <span>{t('board.filter.search')}</span>
            <input className={css.manualInput} value={search} onChange={event => setSearch(event.target.value)}
              placeholder={t('board.filter.searchPlaceholder')} />
          </label>
          <button type="button" className={css.detailOpen} onClick={() => { changeFilter({ search: search.trim() === '' ? undefined : search.trim() }) }}>
            {t('board.filter.apply')}
          </button>
        </div>
        <div className={css.toolbarActions}>
          {useSteward !== undefined
            ? <BoardStewardChip useSteward={useSteward} onOpenMonitor={onOpenMonitor} t={t} />
            : null}
          <ManualInputForm t={t} onManualInput={onManualInput} onAgentKindOptions={props.onAgentKindOptions} useFlows={props.useFlows} />
        </div>
      </div>
      <BoardColumns
        snapshot={snapshot}
        t={t}
        onAccept={onAcceptCandidate}
        onRequeue={onEvalRequeue}
        onOpenTicket={setOpenTicketId}
        onAnswerAttention={onAnswerAttention}
      />
      {toastNotifications.length > 0
        ? (
          <div className={css.toastStack} role="status">
            {toastNotifications.map(notification => (
              <div key={notification.id} className={css.toast}>
                <div className={css.toastHeader}>
                  <span className={css.toastTitle}>{t('board.toast.attention')}</span>
                  <button
                    type="button"
                    className={css.toastDismiss}
                    aria-label={t('board.toast.dismiss')}
                    onClick={() => { dismissToast(notification.id) }}
                  >
                    ×
                  </button>
                </div>
                <span className={css.toastBody}>
                  {notification.title.length > MAX_TOAST_BODY_CHARS
                    ? `${notification.title.slice(0, MAX_TOAST_BODY_CHARS)}…`
                    : notification.title}
                </span>
              </div>
            ))}
          </div>
        )
        : null}
      {openTicketId !== undefined
        ? (
          <TicketDetailPanel
            ticketId={openTicketId}
            attentions={(snapshot.attentions ?? []).filter(attention => attention.ticketId === openTicketId)}
            projects={snapshot.projects}
            connections={snapshot.connections}
            t={t}
            onClose={() => { setOpenTicketId(undefined) }}
            onOpenTicket={setOpenTicketId}
            onAnswerAttention={onAnswerAttention}
            actions={{ onTicketDetail, onFlowTimeline, onTicketChangeDiff, onDispatchTicket, onDispatchCancel, onTicketWorktree, onTicketWorktreeRemove, ...(onSetTicketDependencies === undefined ? {} : { onSetTicketDependencies }), ...(onCloseTicket === undefined ? {} : { onCloseTicket }) }}
          />
        )
        : null}
    </div>
  )
}

/** The manual-entry modal: the user's own request walks the normal eval path. */
function ManualInputForm({ t, onManualInput, onAgentKindOptions, useFlows }: {
  t: TranslateNS<'dshManager'>
  onManualInput: (input: { title: string; description: string; projectId?: string }) => Promise<boolean>
  onAgentKindOptions?: ((refresh?: boolean) => Promise<readonly AgentKindOption[]>) | undefined
  useFlows?: BoardPageProps['useFlows']
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [kindOptions, setKindOptions] = useState<readonly AgentKindOption[]>([])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const flowSnapshot = useFlows?.(s => s)
  const formValid = title.trim() !== '' && description.trim() !== ''
  const skillCommands = (flowSnapshot?.skills ?? [])
    .map(skill => ({
      name: skill.name,
      ...(skill.description === '' ? {} : { description: skill.description }),
    }))
  const commandGroups: readonly SlashCommandGroup[] = [
    ...(skillCommands.length > 0
      ? [{ agentId: 'skills', agentLabel: 'Skills', commands: skillCommands }]
      : []),
    ...kindOptions
      .filter(option => option.available && (option.slashCommands?.length ?? 0) > 0)
      .map(option => ({
        agentId: option.kind,
        agentLabel: option.kind,
        commands: option.slashCommands ?? [],
      })),
  ]
  const openModal = (): void => {
    setOpen(true)
    if (typeof onAgentKindOptions === 'function') {
      void onAgentKindOptions(false).then(setKindOptions).catch(() => {})
    }
  }
  const close = (): void => {
    setOpen(false)
    setFailed(false)
  }
  const submit = (): void => {
    if (!formValid || busy) return
    setBusy(true)
    setFailed(false)
    void onManualInput({ title: title.trim(), description: description.trim(), ...(projectId === '' ? {} : { projectId }) })
      .then((accepted) => {
        if (accepted) {
          setTitle('')
          setDescription('')
          setProjectId('')
          setOpen(false)
        } else {
          setFailed(true)
        }
      })
      .finally(() => { setBusy(false) })
  }
  return (
    <>
      <button type="button" className={css.accept} onClick={openModal}>
        {t('board.manual.title')}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('board.manual.title')}
        closeLabel={t('connections.cancel')}
      >
        <label className={css.manualField}>
          <span>{t('board.manual.title')}</span>
          <input className={css.manualInput} value={title} onChange={event => setTitle(event.target.value)}
            placeholder={t('board.manual.titlePlaceholder')} />
        </label>
        <label className={css.manualField}>
          <span>{t('board.manual.description')}</span>
          <SlashInput
            as="input"
            className={css.manualInput}
            value={description}
            groups={commandGroups}
            onChange={setDescription}
            placeholder={t('board.manual.descriptionPlaceholder')}
          />
        </label>
        <label className={css.manualField}>
          <span>{t('board.manual.project')}</span>
          <input className={css.manualInput} value={projectId} onChange={event => setProjectId(event.target.value)}
            placeholder={t('board.manual.projectPlaceholder')} />
        </label>
        {failed ? <p className={css.invalid}>{t('board.manual.failed')}</p> : null}
        <footer className={css.modalFooter}>
          <button type="button" className={css.action} onClick={close}>{t('connections.cancel')}</button>
          <button type="button" className={css.accept} disabled={!formValid || busy} onClick={submit}>
            {t('board.manual.submit')}
          </button>
        </footer>
      </Modal>
    </>
  )
}

/** The board columns with their ticket cards, inbox candidates, and the rework pool. */
function BoardColumns({ snapshot, t, onAccept, onRequeue, onOpenTicket, onAnswerAttention }: {
  snapshot: BoardSnapshot
  t: TranslateNS<'dshManager'>
  onAccept: (evalId: string) => Promise<boolean>
  onRequeue: (evalIds: readonly string[]) => Promise<number>
  onOpenTicket: (ticketId: string) => void
  onAnswerAttention: (input: { attentionId: string; answer: string }) => Promise<boolean>
}) {
  const summary = snapshot.summary
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [dropping, setDropping] = useState(false)
  const [requeueBusy, setRequeueBusy] = useState(false)
  const [openCandidate, setOpenCandidate] = useState<CandidateView | undefined>()
  const [openPoolEval, setOpenPoolEval] = useState<EvalRecordView | undefined>()
  if (summary === undefined) return null
  const tickets = snapshot.tickets ?? []
  const candidates = snapshot.candidates ?? []
  const pool = snapshot.pool ?? []
  const total = summary.columns.reduce((sum, column) => sum + column.count, 0)
  const toggle = (evalId: string): void => {
    const next = new Set(selected)
    if (next.has(evalId)) next.delete(evalId)
    else next.add(evalId)
    setSelected(next)
  }
  const requeueIds = (evalIds: readonly string[]): void => {
    if (evalIds.length === 0 || requeueBusy) return
    setRequeueBusy(true)
    void onRequeue(evalIds).then(() => {
      setSelected(new Set())
    }).finally(() => { setRequeueBusy(false) })
  }
  // Dragging pool cards onto the inbox column hands them back to the steward:
  // a single card drags itself; a selection drag carries the whole selection.
  const dropIds = (event: DragEvent): void => {
    event.preventDefault()
    setDropping(false)
    const raw = event.dataTransfer.getData(POOL_DRAG_TYPE)
    if (raw === '') return
    try {
      const ids = JSON.parse(raw) as string[]
      requeueIds(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])
    } catch {
      // A malformed payload is a foreign drag; ignore it.
    }
  }
  return (
    <>
      {selected.size > 0
        ? (
          <div className={css.bulkBar} role="toolbar">
            <span>{t('board.pool.selected', { count: selected.size })}</span>
            <button type="button" className={css.accept} disabled={requeueBusy} onClick={() => { requeueIds([...selected]) }}>
              {t('board.pool.retry')}
            </button>
            <button type="button" className={css.action} onClick={() => { setSelected(new Set()) }}>
              {t('board.pool.clear')}
            </button>
          </div>
        )
        : null}
      {total === 0 ? <p className={css.emptyInline}>{t('board.empty')}</p> : null}
      <div className={css.columns}>
        {summary.columns.map(column => {
          const columnTickets = tickets.filter(ticket => STATE_COLUMN[ticket.state] === column.id)
          const dropTarget = column.id === 'inbox'
          return (
            <section
              key={column.id}
              className={css.column}
              data-drop={dropTarget && dropping ? 'open' : undefined}
              onDragOver={dropTarget && dropping ? (event) => { event.preventDefault() } : undefined}
              onDragEnter={dropTarget ? (event) => {
                if (event.dataTransfer.types.includes(POOL_DRAG_TYPE)) setDropping(true)
              } : undefined}
              onDragLeave={dropTarget ? () => { setDropping(false) } : undefined}
              onDrop={dropTarget ? dropIds : undefined}
            >
              <header className={css.columnHeader}>{t(COLUMN_KEYS[column.id])}</header>
              <div className={css.count}>{column.count}</div>
              {column.id === 'inbox'
                ? (
                  <ul className={css.cards}>
                    {candidates.map(candidate => (
                      <CandidateCard key={candidate.evalId} candidate={candidate} t={t} onAccept={onAccept} onOpen={() => { setOpenCandidate(candidate) }} />
                    ))}
                  </ul>
                )
                : null}
              {column.id === 'pool'
                ? (
                  <ul className={css.cards}>
                    {pool.map(evalRecord => (
                      <PoolCard key={evalRecord.id} evalRecord={evalRecord} selected={selected.has(evalRecord.id)}
                        dragIds={selected.has(evalRecord.id) ? [...selected] : [evalRecord.id]}
                        t={t} onToggle={() => { toggle(evalRecord.id) }} onOpen={() => { setOpenPoolEval(evalRecord) }} />
                    ))}
                  </ul>
                )
                : null}
              <ul className={css.cards}>
                {columnTickets.map(ticket => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    attentions={(snapshot.attentions ?? []).filter(attention => attention.ticketId === ticket.id)}
                    t={t}
                    onOpen={() => { onOpenTicket(ticket.id) }}
                    onAnswerAttention={onAnswerAttention}
                  />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      {openCandidate !== undefined
        ? (
          <CandidateDetailModal
            candidate={openCandidate}
            t={t}
            onClose={() => { setOpenCandidate(undefined) }}
            onAccept={async (evalId) => {
              const accepted = await onAccept(evalId)
              if (accepted) setOpenCandidate(undefined)
              return accepted
            }}
          />
        )
        : null}
      {openPoolEval !== undefined
        ? (
          <PoolDetailModal
            evalRecord={openPoolEval}
            t={t}
            onClose={() => { setOpenPoolEval(undefined) }}
          />
        )
        : null}
    </>
  )
}

/** Whether an event inside a clickable card targets an interactive sub-control rather than the card surface. */
function isCardInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button, input, textarea, label, [data-no-card-open]') !== null
}

/** The drag payload type a pool card sets and the inbox column accepts. */
const POOL_DRAG_TYPE = 'application/x-dsh-manager-pool'

/** One inbox candidate: compact summary on the card, full rationale in its modal. */
function CandidateCard({ candidate, t, onAccept, onOpen }: {
  candidate: CandidateView
  t: TranslateNS<'dshManager'>
  onAccept: (evalId: string) => Promise<boolean>
  onOpen: () => void
}) {
  return (
    <li
      className={css.card}
      data-state="inbox"
      data-clickable="true"
      onClick={(event) => {
        if (!isCardInteractiveTarget(event.target)) onOpen()
      }}
    >
      <strong className={css.cardTitle}>{candidate.title ?? candidate.externalKey ?? candidate.evalId}</strong>
      {candidate.rationale !== undefined
        ? <div className={`${css.cardDetail} ${css.cardClamp}`}><span>{candidate.rationale}</span></div>
        : null}
      <div className={css.cardFooter}>
        <button type="button" className={css.accept} onClick={() => { void onAccept(candidate.evalId) }}>
          {t('board.candidate.accept')}
        </button>
      </div>
    </li>
  )
}

/** Modal displaying the complete details of an inbox candidate. */
function CandidateDetailModal({ candidate, t, onClose, onAccept }: {
  candidate: CandidateView
  t: TranslateNS<'dshManager'>
  onClose: () => void
  onAccept: (evalId: string) => Promise<boolean>
}) {
  return (
    <Modal open onClose={onClose} title={t('board.candidate.detailTitle')} closeLabel={t('board.detail.close')}>
      <div className={css.modalBody}>
        <strong className={css.cardTitleFull}>{candidate.title ?? candidate.externalKey ?? candidate.evalId}</strong>
        <div className={css.detailPropGrid}>
          {candidate.externalKey !== undefined
            ? (
              <>
                <span className={css.detailPropLabel}>{t('board.detail.properties.externalKey')}</span>
                <span className={css.detailPropValue}>
                  {hasExternalUrl(candidate.url)
                    ? <a className={css.cardTitle} href={candidate.url} target="_blank" rel="noreferrer">{candidate.externalKey}</a>
                    : <code className={css.detailPath}>{candidate.externalKey}</code>}
                </span>
              </>
            )
            : null}
          {candidate.strength !== undefined
            ? (
              <>
                <span className={css.detailPropLabel}>{t('board.candidate.strength')}</span>
                <span className={css.detailPropValue}>{t(`records.strength.${candidate.strength}`)}</span>
              </>
            )
            : null}
          <span className={css.detailPropLabel}>{t('board.detail.properties.thread')}</span>
          <code className={`${css.detailPropValue} ${css.detailPath}`}>{candidate.threadId}</code>
        </div>
        {candidate.rationale !== undefined
          ? (
            <div className={css.detailSection}>
              <h4>{t('board.candidate.rationale')}</h4>
              <p className={css.attentionDetails}>{candidate.rationale}</p>
            </div>
          )
          : null}
        <footer className={css.modalFooter}>
          <button type="button" className={css.action} onClick={onClose}>{t('board.detail.close')}</button>
          <button type="button" className={css.accept} onClick={() => { void onAccept(candidate.evalId) }}>
            {t('board.candidate.accept')}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

/** One rework-pool card: compact summary on the card, full eval details on click.
    Checkboxes build a multi-selection; a drag onto the inbox column (alone or
    with the selection) hands the batch back for a fresh evaluation. */
function PoolCard({ evalRecord, selected, dragIds, t, onToggle, onOpen }: {
  evalRecord: EvalRecordView
  selected: boolean
  dragIds: readonly string[]
  t: TranslateNS<'dshManager'>
  onToggle: () => void
  onOpen: () => void
}) {
  const first = evalRecord.triggers[0]
  return (
    <li className={css.card} data-state="pool" data-selected={selected} data-clickable="true" draggable
      onClick={(event) => {
        if (!isCardInteractiveTarget(event.target)) onOpen()
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(POOL_DRAG_TYPE, JSON.stringify(dragIds))
        event.dataTransfer.effectAllowed = 'copy'
      }}>
      <label className={css.cardCheck}>
        <input type="checkbox" checked={selected} onChange={onToggle} />
        <span className={css.badge} data-status={evalRecord.status}>
          {evalRecord.status === 'failed' ? t('board.pool.failed') : t('board.pool.incomplete')}
        </span>
      </label>
      <strong className={css.cardTitle}>{first?.externalKey ?? evalRecord.threadId}</strong>
      <div className={`${css.cardMeta} ${css.cardClamp}`}>
        <span>{evalRecord.decision?.rationale ?? formatTime(evalRecord.finishedAt ?? evalRecord.startedAt)}</span>
      </div>
    </li>
  )
}

/** Modal displaying the complete details of a rework-pool eval record. */
function PoolDetailModal({ evalRecord, t, onClose }: {
  evalRecord: EvalRecordView
  t: TranslateNS<'dshManager'>
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose} title={t('board.pool.detailTitle')} closeLabel={t('board.detail.close')}>
      <div className={css.modalBody}>
        <div className={css.detailPropGrid}>
          <span className={css.detailPropLabel}>{t('board.detail.properties.state')}</span>
          <span className={css.detailPropValue}>
            <span className={css.badge} data-status={evalRecord.status}>
              {evalRecord.status === 'failed' ? t('board.pool.failed') : t('board.pool.incomplete')}
            </span>
          </span>
          <span className={css.detailPropLabel}>{t('board.detail.properties.thread')}</span>
          <code className={`${css.detailPropValue} ${css.detailPath}`}>{evalRecord.threadId}</code>
          <span className={css.detailPropLabel}>{t('board.pool.time')}</span>
          <span className={css.detailPropValue}>{formatTime(evalRecord.finishedAt ?? evalRecord.startedAt)}</span>
        </div>
        {evalRecord.decision?.rationale !== undefined
          ? (
            <div className={css.detailSection}>
              <h4>{t('board.pool.rationale')}</h4>
              <p className={css.attentionDetails}>{evalRecord.decision.rationale}</p>
            </div>
          )
          : null}
        {evalRecord.triggers.length > 0
          ? (
            <div className={css.detailSection}>
              <h4>{t('board.pool.triggers')}</h4>
              <ul className={css.detailList}>
                {evalRecord.triggers.map(trigger => (
                  <li key={trigger.id} className={css.detailSidebarItem}>
                    {hasExternalUrl(trigger.url)
                      ? <a className={css.cardTitle} href={trigger.url} target="_blank" rel="noreferrer">{trigger.externalKey}</a>
                      : <code className={css.detailPath}>{trigger.externalKey}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )
          : null}
        <footer className={css.modalFooter}>
          <button type="button" className={css.action} onClick={onClose}>{t('board.detail.close')}</button>
        </footer>
      </div>
    </Modal>
  )
}

/** Epoch millis as a locale date-time string. */
function formatTime(millis: number): string {
  return new Date(millis).toLocaleString()
}

/** One ticket card: primary summary (title, badges, source, project, compact attention prompt); click opens full detail. */
function TicketCard({ ticket, attentions, t, onOpen, onAnswerAttention }: {
  ticket: TicketView
  attentions: readonly AttentionView[]
  t: TranslateNS<'dshManager'>
  onOpen: () => void
  onAnswerAttention: (input: { attentionId: string; answer: string }) => Promise<boolean>
}) {
  const waitingCount = ticket.waitingOn?.length ?? 0
  const hasBadges = attentions.length > 0 || ticket.flow !== undefined || waitingCount > 0 || ticket.supersededBy !== undefined
  const hasMeta = (ticket.sourceConnectionId !== undefined && ticket.externalKey !== undefined) || ticket.projectId !== undefined
  return (
    <li
      className={css.card}
      data-state={ticket.state}
      data-clickable="true"
      onClick={(event) => {
        if (!isCardInteractiveTarget(event.target)) onOpen()
      }}
    >
      <strong className={css.cardTitle}>{ticket.title}</strong>
      {hasBadges
        ? (
          <div className={css.cardBadges}>
            {waitingCount > 0
              ? <span className={css.waitingBadge}>{t('board.card.waitingOn', { count: waitingCount })}</span>
              : null}
            {ticket.supersededBy !== undefined
              ? <span className={css.waitingBadge}>{t('board.card.superseded')}</span>
              : null}
            {attentions.length > 0
              ? <span className={css.attentionCount}>{t('board.card.attentionCount', { count: attentions.length })}</span>
              : null}
            {ticket.flow !== undefined
              ? <span className={css.flowBadge}>{t('board.card.flow', { pipeline: ticket.flow.pipelineName, stage: ticket.flow.stageIndex + 1, count: ticket.flow.stageCount })}</span>
              : null}
          </div>
        )
        : null}
      {hasMeta
        ? (
          <div className={css.cardMeta}>
            {ticket.sourceConnectionId !== undefined && ticket.externalKey !== undefined
              ? <span>{t('board.card.source', { connection: ticket.sourceConnectionId, external: ticket.externalKey })}</span>
              : null}
            {ticket.projectId !== undefined ? <span>{t('board.card.project', { project: ticket.projectId })}</span> : null}
          </div>
        )
        : null}
      {ticket.fanIn !== undefined && ticket.fanIn.length > 0
        ? (
          <ul className={css.fanIn}>
            {ticket.fanIn.map(item => (
              <li key={item.id}>
                {hasExternalUrl(item.url)
                  ? <a href={item.url} target="_blank" rel="noreferrer">{t('board.card.fanIn', { external: item.externalKey })}</a>
                  : <span>{t('board.card.fanIn', { external: item.externalKey })}</span>}
              </li>
            ))}
          </ul>
        )
        : null}
      {attentions.map(attention => (
        <AttentionAnswerForm key={attention.id} attention={attention} t={t} onAnswerAttention={onAnswerAttention} compact />
      ))}
      <div className={css.cardFooter}>
        <button type="button" className={css.detailOpen} onClick={onOpen}>{t('board.detail.open')}</button>
      </div>
    </li>
  )
}
