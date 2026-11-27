/** Authoritative board snapshot for the kanban page: summary, ticket cards, and inbox candidates. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BoardSummary, TicketView } from '../board-domain.ts'
import type { BoardFilter } from '../board/wire-types.ts'
import type { CandidateView, EvalRecordView } from '../evals/wire-types.ts'
import type { ConnectionView } from '../connections/wire-types.ts'
import type { ProjectRef } from '../mappings/wire-types.ts'
import type { ContinueTicketResult, FileDiffView, TicketChangeDiffInput, TicketDetailView, WorktreeInspectionView } from '../dispatch/wire-types.ts'
import type { FlowTimelineView } from '../flow/flow-core.ts'
import type { AttentionAnswerInput, AttentionView } from '../attention/wire-types.ts'

/** The localStorage key the board filter persists under. */
const FILTER_STORAGE_KEY = 'dsh-manager.board.filter'

/** Read the persisted filter; a corrupt record reads as no filter. */
function loadFilter(): BoardFilter {
  try {
    const raw = globalThis.localStorage?.getItem(FILTER_STORAGE_KEY)
    if (raw === null || raw === undefined || raw === '') return {}
    const parsed = JSON.parse(raw) as BoardFilter
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** Query state exposed to the board page. */
export interface BoardSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** Present once a read has succeeded; a failed read keeps the last one. */
  readonly summary?: BoardSummary
  /** The ticket cards, newest accepted first. */
  readonly tickets?: readonly TicketView[]
  /** The acceptance candidates waiting in the inbox, newest first. */
  readonly candidates?: readonly CandidateView[]
  /** The rework pool: failed/incomplete evals the steward gave up on, newest first. */
  readonly pool?: readonly EvalRecordView[]
  /** The active combined filter. */
  readonly filter?: BoardFilter
  /** The pending attentions, newest first; the 待人工 column and the cards read them. */
  readonly attentions?: readonly AttentionView[]
  /** The connections behind the connection filter. */
  readonly connections?: readonly ConnectionView[]
  /** The DSH projects behind the project filter. */
  readonly projects?: readonly ProjectRef[]
}

/** Remote read and invalidation scoped by the registering entry. */
export interface BoardDependencies {
  /** Read one whole-board snapshot under the filter; `undefined` marks a failed read. */
  readonly read: (filter: BoardFilter) => Promise<BoardSummary | undefined>
  /** Read every ticket card under the filter; `undefined` marks a failed read. */
  readonly readTickets: (filter: BoardFilter) => Promise<readonly TicketView[] | undefined>
  /** Read the inbox candidates; `undefined` marks a failed read. */
  readonly readCandidates?: () => Promise<readonly CandidateView[] | undefined>
  /** Read every eval record; the pool filters to failed/incomplete client-side. */
  readonly readEvals?: () => Promise<readonly EvalRecordView[] | undefined>
  /** Read the connections behind the connection filter. */
  readonly readConnections?: () => Promise<readonly ConnectionView[] | undefined>
  /** Read the DSH projects behind the project filter. */
  readonly readProjects?: () => Promise<readonly ProjectRef[] | undefined>
  /** Accept one candidate on the host; the human confirmation mints its ticket. */
  readonly accept: (evalId: string) => Promise<{ ok: boolean; error?: unknown }>
  /** Re-queue one retired eval; the steward re-evaluates its batch. */
  readonly requeue: (evalId: string) => Promise<{ ok: boolean; error?: unknown }>
  /** Submit one manual entry; it walks the normal eval path. */
  readonly submitManual: (input: { title: string; description: string; projectId?: string }) => Promise<{ ok: boolean; error?: unknown }>
  /** Read one ticket's whole detail: card, dispatches, deliverables, and changes. */
  readonly readTicketDetail?: (ticketId: string) => Promise<TicketDetailView | undefined>
  /** Read one ticket's pipeline walk; `undefined` when the ticket walks no pipeline. */
  readonly readFlowTimeline?: (ticketId: string) => Promise<FlowTimelineView | undefined>
  /** Resolve one change ref through the harness diff view. */
  readonly readTicketChangeDiff?: (input: TicketChangeDiffInput) => Promise<FileDiffView | undefined>
  /** Enqueue one fresh dispatch for an unfinished ticket. */
  readonly dispatchTicket?: (ticketId: string) => Promise<boolean>
  /** Cancel an active dispatch on operator request. */
  readonly cancelDispatch?: (dispatchId: string) => Promise<boolean>
  /** Jump to one Session in the host workspace, when the host exposes it. */
  readonly openSession?: (sessionId: string) => boolean
  /** Continue one ticket with a new instruction (deliver, queue, or resume). */
  readonly continueTicket?: (input: { readonly ticketId: string; readonly text: string; readonly newSession?: boolean }) => Promise<ContinueTicketResult | undefined>
  /** Inspect a ticket's mapped git worktree (`status` + `diff`). */
  readonly readTicketWorktree?: (ticketId: string) => Promise<WorktreeInspectionView | undefined>
  /** Remove a ticket's mapped git worktree directory. */
  readonly removeTicketWorktree?: (ticketId: string) => Promise<boolean>
  /** Update a ticket's prerequisite dependencies (`dependsOn`). */
  readonly setTicketDependencies?: (input: { readonly ticketId: string; readonly dependsOn: readonly string[] }) => Promise<boolean>
  /** Manually close/abandon a ticket so it moves to `ended`. */
  readonly closeTicket?: (input: { readonly ticketId: string; readonly reason?: string }) => Promise<boolean>
  /** Read the pending attentions; `undefined` marks a failed read. */
  readonly readAttentions?: () => Promise<readonly AttentionView[] | undefined>
  /** Answer one attention on the host; the delivery reaches the Executor Session. */
  readonly answerAttention?: (input: AttentionAnswerInput) => Promise<{ ok: boolean }>
  /** Subscribe to a connection reset that invalidates the snapshot. */
  readonly subscribeReset: (listener: () => void) => () => void
  /** Poll cadence for background-change refresh in millis; 0 disables. */
  readonly pollMs?: number
}

/** Props injected through the board slots. */
export interface BoardInjected {
  readonly hooks: { readonly board: HostObservable<BoardSnapshot> }
  /** Change the combined filter (every field optional) and re-read. */
  readonly onFilter: (filter: BoardFilter) => void
  /** Accept one candidate; the human confirmation mints its ticket. */
  readonly onAcceptCandidate: (evalId: string) => Promise<boolean>
  /** Re-queue one pool eval; the steward re-evaluates its batch. */
  readonly onEvalRequeue: (evalIds: readonly string[]) => Promise<number>
  /** Submit one manual entry; resolves `false` when the host rejected it. */
  readonly onManualInput: (input: { title: string; description: string; projectId?: string }) => Promise<boolean>
  /** Append one instruction to a ticket, resuming its session when it had ended. */
  readonly onContinueTicket: (input: { readonly ticketId: string; readonly text: string; readonly newSession?: boolean }) => Promise<ContinueTicketResult | undefined>
  /** Read one ticket's whole detail; `undefined` marks a failed read. */
  readonly onTicketDetail: (ticketId: string) => Promise<TicketDetailView | undefined>
  /** Read one ticket's pipeline walk; `undefined` when the ticket walks no pipeline. */
  readonly onFlowTimeline: (ticketId: string) => Promise<FlowTimelineView | undefined>
  /** Resolve one change ref through the harness diff view; `undefined` marks a failed read. */
  readonly onTicketChangeDiff: (input: TicketChangeDiffInput) => Promise<FileDiffView | undefined>
  /** Re-enqueue a dispatch for a ticket whose previous dispatch failed/interrupted. */
  readonly onDispatchTicket: (ticketId: string) => Promise<boolean>
  /** Cancel a queued or running dispatch; resolves `true` when cancelled. */
  readonly onDispatchCancel: (dispatchId: string) => Promise<boolean>
  /** Open the ticket's Executor Session in the host workspace. */
  readonly onOpenSession: (sessionId: string) => boolean
  /** Inspect a ticket's git worktree status and diff; `undefined` when unmapped or failed. */
  readonly onTicketWorktree: (ticketId: string) => Promise<WorktreeInspectionView | undefined>
  /** Remove a ticket's git worktree directory; resolves `true` when removed. */
  readonly onTicketWorktreeRemove: (ticketId: string) => Promise<boolean>
  /** Update a ticket's prerequisite dependencies (`dependsOn`); optional for older mocks. */
  readonly onSetTicketDependencies?: (input: { readonly ticketId: string; readonly dependsOn: readonly string[] }) => Promise<boolean>
  /** Manually close/abandon a ticket (`ended`); optional for older mocks. */
  readonly onCloseTicket?: (input: { readonly ticketId: string; readonly reason?: string }) => Promise<boolean>
  /** Answer one attention; resolves `false` when the host rejected it. */
  readonly onAnswerAttention: (input: AttentionAnswerInput) => Promise<boolean>
  /** Read the board again after a failure. */
  readonly onBoardRetry: () => void
}

/**
 * Create a board source whose Remote reads follow its framework subscribers
 * and poll on a cadence, so background changes (a new trigger accepted by the
 * Steward) land on the board without user action. The combined filter lives
 * in the source, persists across page reloads through localStorage, and every
 * read (poll, reset, retry) carries it.
 * @param deps - Remote reads, invalidation subscription, and poll cadence.
 * @returns the observable board, the filter/accept/manual actions, and the retry callback.
 */
export function createBoardSource(deps: BoardDependencies): Pick<BoardInjected, 'hooks' | 'onFilter' | 'onAcceptCandidate' | 'onEvalRequeue' | 'onManualInput' | 'onTicketDetail' | 'onFlowTimeline' | 'onTicketChangeDiff' | 'onDispatchTicket' | 'onDispatchCancel' | 'onContinueTicket' | 'onOpenSession' | 'onTicketWorktree' | 'onTicketWorktreeRemove' | 'onSetTicketDependencies' | 'onCloseTicket' | 'onAnswerAttention' | 'onBoardRetry'> {
  let snapshot: BoardSnapshot = { status: 'loading' }
  let filter: BoardFilter = loadFilter()
  const listeners = new Set<() => void>()
  let disposers: readonly (() => void)[] = []
  let epoch = 0
  const publish = (next: BoardSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (current: number): Promise<void> => {
    // A rejecting transport reads as a failed read: refresh() is fired void,
    // so the rejection must never escape this async boundary.
    let summary: BoardSummary | undefined
    let tickets: readonly TicketView[] | undefined
    let candidates: readonly CandidateView[] | undefined
    let pool: readonly EvalRecordView[] | undefined
    let connections: readonly ConnectionView[] | undefined
    let projects: readonly ProjectRef[] | undefined
    let attentions: readonly AttentionView[] | undefined
    try {
      const [summaryResult, ticketResult, candidateResult, evalResult, connectionResult, projectResult, attentionResult] = await Promise.all([
        deps.read(filter),
        deps.readTickets(filter),
        deps.readCandidates?.().catch(() => undefined) ?? Promise.resolve(undefined),
        deps.readEvals?.().catch(() => undefined) ?? Promise.resolve(undefined),
        deps.readConnections?.().catch(() => undefined) ?? Promise.resolve(undefined),
        deps.readProjects?.().catch(() => undefined) ?? Promise.resolve(undefined),
        deps.readAttentions?.().catch(() => undefined) ?? Promise.resolve(undefined),
      ])
      summary = summaryResult
      tickets = ticketResult
      candidates = candidateResult
      const resolvedThreads = new Set<string>([
        ...(ticketResult ?? []).map(ticket => ticket.threadId),
        ...(evalResult ?? [])
          .filter(evalRecord => evalRecord.status === 'accepted' || evalRecord.status === 'candidate' || evalRecord.status === 'rejected')
          .map(evalRecord => evalRecord.threadId),
      ])
      // The pool is the retired slice whose thread has not later resolved, newest first.
      pool = evalResult?.filter(evalRecord =>
        (evalRecord.status === 'failed' || evalRecord.status === 'incomplete')
        && !resolvedThreads.has(evalRecord.threadId),
      )
      connections = connectionResult
      projects = projectResult
      attentions = attentionResult
    } catch {
      summary = undefined
    }
    if (current !== epoch) return
    if (summary === undefined) {
      publish(snapshot.summary === undefined
        ? { status: 'error', ...(filter === undefined ? {} : { filter }) }
        : {
          status: 'error',
          summary: snapshot.summary,
          ...(snapshot.tickets === undefined ? {} : { tickets: snapshot.tickets }),
          ...(snapshot.candidates === undefined ? {} : { candidates: snapshot.candidates }),
          ...(snapshot.pool === undefined ? {} : { pool: snapshot.pool }),
          ...(snapshot.attentions === undefined ? {} : { attentions: snapshot.attentions }),
          ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }),
          ...(snapshot.projects === undefined ? {} : { projects: snapshot.projects }),
          filter,
        })
      return
    }
    publish({
      status: 'ready',
      summary,
      ...(tickets === undefined ? {} : { tickets }),
      ...(candidates === undefined ? {} : { candidates }),
      ...(pool === undefined ? {} : { pool }),
      ...(attentions === undefined ? {} : { attentions }),
      ...(connections === undefined ? {} : { connections }),
      ...(projects === undefined ? {} : { projects }),
      filter,
    })
  }
  const refresh = (): Promise<void> => read(++epoch)
  const invalidate = (): void => { void refresh() }
  return {
    hooks: {
      board: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            const handles: (() => void)[] = [deps.subscribeReset(invalidate)]
            if (deps.pollMs !== undefined && deps.pollMs > 0) {
              const timer = setInterval(invalidate, deps.pollMs)
              handles.push(() => { clearInterval(timer) })
            }
            disposers = handles
            invalidate()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
            epoch++
          }
        },
      },
    },
    onFilter(next) {
      filter = next
      try {
        globalThis.localStorage?.setItem(FILTER_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // A failing store must not break the filter; the session keeps it.
      }
      invalidate()
    },
    async onAcceptCandidate(evalId) {
      try {
        const result = await deps.accept(evalId)
        if (!result.ok) return false
        await refresh()
        return true
      } catch {
        return false
      }
    },
    async onEvalRequeue(evalIds) {
      let requeued = 0
      for (const evalId of evalIds) {
        try {
          const result = await deps.requeue(evalId)
          if (result.ok) requeued += 1
        } catch {
          // One refused requeue must not stop the rest of the selection.
        }
      }
      await refresh()
      return requeued
    },
    async onManualInput(input) {
      try {
        const result = await deps.submitManual(input)
        if (!result.ok) return false
        await refresh()
        return true
      } catch {
        return false
      }
    },
    async onTicketDetail(ticketId) {
      if (deps.readTicketDetail === undefined) return undefined
      try {
        return await deps.readTicketDetail(ticketId)
      } catch {
        return undefined
      }
    },
    async onFlowTimeline(ticketId) {
      if (deps.readFlowTimeline === undefined) return undefined
      try {
        return await deps.readFlowTimeline(ticketId)
      } catch {
        return undefined
      }
    },
    async onTicketChangeDiff(input) {
      if (deps.readTicketChangeDiff === undefined) return undefined
      try {
        return await deps.readTicketChangeDiff(input)
      } catch {
        return undefined
      }
    },
    async onDispatchTicket(ticketId) {
      if (deps.dispatchTicket === undefined) return false
      try {
        const queued = await deps.dispatchTicket(ticketId)
        if (queued) await refresh()
        return queued
      } catch {
        return false
      }
    },
    onOpenSession(sessionId) {
      return deps.openSession?.(sessionId) ?? false
    },
    async onContinueTicket(input: { readonly ticketId: string; readonly text: string; readonly newSession?: boolean }) {
      if (deps.continueTicket === undefined) return undefined
      try {
        const result = await deps.continueTicket(input)
        if (result?.ok === true) await refresh()
        return result
      } catch {
        return undefined
      }
    },
    async onDispatchCancel(dispatchId) {
      if (deps.cancelDispatch === undefined) return false
      try {
        const cancelled = await deps.cancelDispatch(dispatchId)
        if (cancelled) await refresh()
        return cancelled
      } catch {
        return false
      }
    },
    async onTicketWorktree(ticketId) {
      if (deps.readTicketWorktree === undefined) return undefined
      try {
        return await deps.readTicketWorktree(ticketId)
      } catch {
        return undefined
      }
    },
    async onTicketWorktreeRemove(ticketId) {
      if (deps.removeTicketWorktree === undefined) return false
      try {
        const removed = await deps.removeTicketWorktree(ticketId)
        if (removed) await refresh()
        return removed
      } catch {
        return false
      }
    },
    async onSetTicketDependencies(input) {
      if (deps.setTicketDependencies === undefined) return false
      try {
        const updated = await deps.setTicketDependencies(input)
        if (updated) await refresh()
        return updated
      } catch {
        return false
      }
    },
    async onCloseTicket(input) {
      if (deps.closeTicket === undefined) return false
      try {
        const closed = await deps.closeTicket(input)
        if (closed) await refresh()
        return closed
      } catch {
        return false
      }
    },
    async onAnswerAttention(input) {
      if (deps.answerAttention === undefined) return false
      try {
        const result = await deps.answerAttention(input)
        if (!result.ok) return false
        await refresh()
        return true
      } catch {
        return false
      }
    },
    onBoardRetry: () => { void refresh() },
  }
}
