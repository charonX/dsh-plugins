/**
 * Wire-level types and input schemas of the eval records API — shared by the
 * Host service and the client contribution.
 */
import { z as zod } from 'zod'

/** The decision verbs, including the system-recorded `incomplete`. */
export const DECISION_ACTIONS = ['accept', 'stop', 'ignore', 'incomplete'] as const

export type DecisionAction = (typeof DECISION_ACTIONS)[number]

/** One trigger in an eval's batch, as the wire sees it. */
export interface EvalTriggerView {
  readonly id: string
  readonly externalKey: string
  readonly url: string
}

/** The decision attached to one eval, as the wire sees it. */
export interface DecisionView {
  readonly action: DecisionAction
  readonly strength?: 'explicit' | 'inferred'
  readonly scope?: string
  readonly supersededBy?: string
  readonly policyVersion: string
  readonly rationale: string
  readonly decidedAt: number
}

/** The eval lifecycle statuses, as the wire sees them. */
export const EVAL_STATUSES = ['running', 'accepted', 'candidate', 'rejected', 'failed', 'incomplete'] as const
export type EvalStatus = (typeof EVAL_STATUSES)[number]

/** One eval joined with its decision and batch, as the wire sees it. */
export interface EvalRecordView {
  readonly id: string
  readonly threadId: string
  readonly status: EvalStatus
  readonly startedAt: number
  readonly finishedAt?: number
  readonly policyVersion: string
  /** The decision recorded for this eval, when one exists. */
  readonly decision?: DecisionView
  /** The connection the batch's thread came from, when known. */
  readonly sourceConnectionId?: string
  /** The accepted ticket's pipeline stage, when the ticket walks a pipeline. */
  readonly flow?: { readonly pipelineName: string; readonly stageIndex: number; readonly stageCount: number }
  /** The evaluated trigger batch, in arrival order. */
  readonly triggers: readonly EvalTriggerView[]
}

/** Filters of the eval records list. */
export interface EvalListInput {
  /** Keep only evals whose decision carries this action. */
  readonly action?: DecisionAction
  /** Keep only evals in this lifecycle status. */
  readonly status?: EvalStatus
  /** Keep only evals whose thread came from this connection. */
  readonly connectionId?: string
}

export const evalListInputSchema = zod.object({
  action: zod.enum(DECISION_ACTIONS).optional(),
  status: zod.enum(EVAL_STATUSES).optional(),
  connectionId: zod.string().min(1).optional(),
})

/** Input addressing one candidate eval. */
export interface AcceptCandidateInput {
  readonly evalId: string
}

export const acceptCandidateInputSchema = zod.object({
  evalId: zod.string().min(1),
})

/** One acceptance candidate waiting for a human, as the wire sees it. */
export interface CandidateView {
  readonly evalId: string
  readonly threadId: string
  /** The would-be ticket title from the recorded acceptance, when present. */
  readonly title?: string
  /** The external object the candidate's batch arrived on, when known. */
  readonly externalKey?: string
  readonly url?: string
  /** The rationale of the recorded acceptance, when present. */
  readonly rationale?: string
  /** The evidence strength the recorded acceptance rested on. */
  readonly strength?: 'explicit' | 'inferred'
}

/** The kinds of steward activity the status feed reports. */
export const STEWARD_ACTIVITY_KINDS = ['eval-start', 'eval-decision', 'eval-incomplete', 'eval-failed', 'review'] as const
export type StewardActivityKind = (typeof STEWARD_ACTIVITY_KINDS)[number]

/** One steward activity entry: what happened, rendered as a detail line. */
export interface StewardActivityView {
  readonly at: number
  readonly kind: StewardActivityKind
  /** The detail line: thread or ticket identifiers, an action, an error. */
  readonly text: string
}

/** The steward's live status for the client's status card and feed. */
export interface StewardStatusView {
  /** Whether an eval, review, or end-suggestion turn is in flight. */
  readonly busy: boolean
  /** How many thread batches wait for the steward's next tick. */
  readonly backlog: number
  /** The default accept mode; a thread's source may override it. */
  readonly mode: 'auto' | 'confirm'
  /** Recent activity, newest first; the process keeps the last 50 entries. */
  readonly activity: readonly StewardActivityView[]
}
