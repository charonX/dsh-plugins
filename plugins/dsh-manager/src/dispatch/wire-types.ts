/**
 * Wire-level types and input schemas of the executor dispatch API — shared
 * by the Host service and the client contribution.
 */
import { z as zod } from 'zod'
import { DISPATCH_OUTCOMES, DISPATCH_STATES, REPORT_KINDS, type DispatchOutcome, type DispatchPromptRecord, type DispatchState, type ReportActivity, type ReportActivityCategory, type ReportKind } from './dispatch-core.ts'
import type { AgentKind } from '../flow/flow-ir.ts'
import type { TicketView } from '../board-domain.ts'
import type { TimelineEvent } from '../timeline/timeline-core.ts'

/** One executor report as the wire sees it. */
export interface ReportView {
  readonly id: string
  readonly kind: ReportKind
  readonly message: string
  readonly activity?: ReportActivity
  readonly at: number
}

/** Unified readable message / activity item across both built-in DSH Sessions and external CLIs. */
export interface DispatchMessageView {
  readonly id: string
  readonly role: 'assistant' | 'tool' | 'report'
  readonly text: string
  readonly toolName?: string
  readonly category?: ReportActivityCategory
  readonly at: number
}

export type DispatchPromptView = DispatchPromptRecord

/** One dispatch as the wire sees it. */
export interface DispatchView {
  readonly id: string
  readonly ticketId: string
  readonly state: DispatchState
  /** Set exactly when the state is `ended`. */
  readonly outcome?: DispatchOutcome
  /** The Executor Session id, set once the session starts. */
  readonly sessionId?: string
  /** Human-readable session or stage-runner label for display instead of raw UUIDs. */
  readonly sessionTitle?: string
  /** Execution backend kind when recorded. */
  readonly agentKind?: AgentKind
  /** Sticky external CLI session id when executed by an external CLI. */
  readonly externalSessionId?: string
  /** Actual rendered prompt dispatched to this executor run (absent on legacy pre-template records). */
  readonly prompt?: DispatchPromptView
  readonly reports: readonly ReportView[]
  /** Chronological conversation & tool stream assembled from Session events or external CLI reports. */
  readonly messages?: readonly DispatchMessageView[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * One deliverable reference: the "Session id + conversation turn" the spec
 * names — the file lives in the referenced session log, no copy is stored.
 */
export interface DeliverableRef {
  readonly sessionId: string
  readonly turn: number
  /** The file's position inside that turn's present call. */
  readonly index: number
  readonly path: string
  readonly description?: string
}

/**
 * One workspace-changes reference: the harness diff view resolves it by
 * Session id and event seq — no diff copy is stored here.
 */
export interface ChangesRef {
  readonly sessionId: string
  /** The session log sequence of the `workspace/changes` event. */
  readonly seq: number
  /** The turn whose workspace changes these are. */
  readonly turn: number
  /** How many files that turn changed. */
  readonly files: number
}

/** One linked ticket as the detail view's chain shows it. */
export interface TicketLinkView {
  readonly id: string
  readonly title: string
  readonly state: TicketView['state']
}

/** One ticket's whole detail: card, dispatch history, and deliverable refs. */
export interface TicketDetailView {
  readonly ticket: TicketView
  readonly dispatches: readonly DispatchView[]
  readonly deliverables: readonly DeliverableRef[]
  /** The executor sessions' workspace changes, per turn with actual edits. */
  readonly changes: readonly ChangesRef[]
  /** The ticket's ledger, oldest first; independent of any Executor Session. */
  readonly events: readonly TimelineEvent[]
  /** The ticket this one follows up, when it is a follow-up itself. */
  readonly followUpOf?: TicketLinkView
  /** The follow-up tickets minted after this one, oldest first. */
  readonly followUps: readonly TicketLinkView[]
}

export const dispatchTicketInputSchema = zod.object({
  ticketId: zod.string().min(1),
})

export type DispatchTicketInput = zod.infer<typeof dispatchTicketInputSchema>

/** How a continued instruction reached the ticket's current turn. */
export type ContinueTicketMode = 'delivered' | 'queued' | 'started' | 'resumed' | 'new-session'

/** One continuation outcome as the wire sees it. */
export interface ContinueTicketResult {
  readonly ok: boolean
  readonly mode: ContinueTicketMode
  readonly dispatchId?: string
}

export const continueTicketInputSchema = zod.object({
  ticketId: zod.string().min(1),
  text: zod.string().min(1),
  /** Start a fresh Executor Session instead of resuming the ticket's last one. */
  newSession: zod.boolean().optional(),
})

export type ContinueTicketInput = zod.infer<typeof continueTicketInputSchema>

export const dispatchListInputSchema = zod.object({
  ticketId: zod.string().min(1).optional(),
})

export type DispatchListInput = zod.infer<typeof dispatchListInputSchema>

export const ticketDetailInputSchema = zod.object({
  ticketId: zod.string().min(1),
})

export type TicketDetailInput = zod.infer<typeof ticketDetailInputSchema>

/** One hunk of a served file comparison, the harness diff view's shape. */
export interface DiffHunkView {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  readonly lines: readonly string[]
}

/** One changed file's comparison as the wire sees it — the harness diff view's own contract. */
export type FileDiffView =
  | {
    readonly kind: 'text'
    readonly path: string
    readonly display: string
    /** Whether the file existed at turn start. */
    readonly before: boolean
    /** Whether the file existed at turn end. */
    readonly after: boolean
    readonly hunks: readonly DiffHunkView[]
    /** True when the line comparison degraded and every line shows as replaced. */
    readonly coarse: boolean
  }
  | { readonly kind: 'binary'; readonly path: string; readonly display: string }
  | { readonly kind: 'oversized'; readonly path: string; readonly display: string }

export const ticketChangeDiffInputSchema = zod.object({
  sessionId: zod.string().min(1),
  /** The session log sequence of the `workspace/changes` event. */
  seq: zod.number().int(),
  /** The file's index in that summary. */
  index: zod.number().int().min(0),
})

export type TicketChangeDiffInput = zod.infer<typeof ticketChangeDiffInputSchema>

export const dispatchCancelInputSchema = zod.object({
  dispatchId: zod.string().min(1),
})

export type DispatchCancelInput = zod.infer<typeof dispatchCancelInputSchema>

/** Git worktree inspection for a ticket mapped to a repository project. */
export interface WorktreeInspectionView {
  readonly exists: boolean
  readonly path: string
  readonly branch: string
  readonly dirtyFiles: readonly string[]
  readonly stat: string
  readonly diff: string
  readonly truncated: boolean
}
