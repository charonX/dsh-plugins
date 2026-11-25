import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { attentionRecord, type AttentionRecord } from './attention/attention-core.ts'
import { dispatchRecord, type DispatchRecord } from './dispatch/dispatch-core.ts'
import { reviewRecord, type ReviewRecord } from './review/review-core.ts'

/** Stable ticket identity. */
export type TicketId = Branded<'TicketId'>

/** Stable eval identity. */
export type EvalId = Branded<'EvalId'>

/** Lifecycle states a ticket moves through; board columns derive from it. */
export const TICKET_STATES = ['todo', 'running', 'attention', 'ended'] as const
export type TicketState = (typeof TICKET_STATES)[number]

/** How strong the evidence behind a decision is. */
export const STRENGTHS = ['explicit', 'inferred'] as const
export type Strength = (typeof STRENGTHS)[number]

/** The mandate a ticket carries: what the Steward was authorized to do. */
export const mandateRecord = z.object({
  /** Evidence strength the acceptance rested on. */
  strength: z.enum(STRENGTHS),
  /** What the mandate covers (e.g. a project directory or a change scope). */
  scope: z.string(),
  /** The policy version the acceptance decision ran under. */
  policyVersion: z.string(),
})

export type Mandate = z.infer<typeof mandateRecord>

/** The flow annotation a routed ticket carries: which pipeline, which stage. */
export const ticketFlow = z.object({
  /** The pipeline the ticket walks (the id, for stage reads). */
  pipelineId: z.string(),
  /** The pipeline's name at accept time; template renames never rewrite live tickets. */
  pipelineName: z.string(),
  /** This ticket's zero-based stage index in the pipeline. */
  stageIndex: z.number().int().min(0),
  /** The pipeline's stage count at accept time. */
  stageCount: z.number().int().min(1),
  /** The stages skipped before this ticket, with the steward's reasons. */
  skipped: z.array(z.object({
    stageIndex: z.number().int().min(0),
    reason: z.string(),
  })).optional(),
  /** The skip decision awaiting the human's approval, exactly while a skip attention is pending. */
  pendingSkip: z.object({
    /** The stage whose skip waits for approval. */
    stageIndex: z.number().int().min(0),
    /** The steward's skip rationale. */
    reason: z.string(),
  }).optional(),
})

export type TicketFlow = z.infer<typeof ticketFlow>

/** Worktree execution mode decided for a ticket (by Steward or executor). */
export const WORKTREE_MODES = ['worktree', 'in-place', 'none'] as const
export type WorktreeMode = (typeof WORKTREE_MODES)[number]

/** Structured worktree & repository-target plan stored on a ticket. */
export const ticketWorktreePlan = z.object({
  mode: z.enum(WORKTREE_MODES).default('worktree'),
  repoRoot: z.string().optional(),
  baseBranch: z.string().optional(),
  branch: z.string().optional(),
  mergeTarget: z.string().optional(),
  path: z.string().optional(),
})

export type TicketWorktreePlan = z.infer<typeof ticketWorktreePlan>

/** One ticket on the board; the record shape grows with later tickets. */
export const ticketRecord = z.object({
  /** Stable ticket id. */
  id: z.string(),
  /** Human-readable ticket title. */
  title: z.string(),
  /** The Thread the ticket's triggers arrived on. */
  threadId: z.string().default(''),
  /** The DSH project the ticket belongs to, when mapped. */
  projectId: z.string().optional(),
  /** Current lifecycle state; never stored as a column. */
  state: z.enum(TICKET_STATES).default('todo'),
  /** The mandate carried from acceptance; present from ticket birth. */
  mandate: mandateRecord.optional(),
  /** The flow annotation when the Steward routed this ticket onto a pipeline. */
  flow: ticketFlow.optional(),
  /** Worktree & target repository plan analyzed by Steward or updated by Executor. */
  worktree: ticketWorktreePlan.optional(),
  /** The connection the originating external object lives under. */
  sourceConnectionId: z.string().optional(),
  /** The ticket this one follows up, when the Steward minted it as the next step. */
  followUpOf: z.string().optional(),
  /** The connector-specific external object key (e.g. a Jira issue key). */
  externalKey: z.string().optional(),
  /** Deep link back to the external object. */
  url: z.string().optional(),
  /** Originating conversation Session when handed off directly from chat. */
  handoffSessionId: z.string().optional(),
  /** Agreed acceptance criteria captured during interactive requirement alignment. */
  acceptanceCriteria: z.string().optional(),
  /** Shared scratch directory for intermediate process artifacts across pipeline stages. */
  scratchDir: z.string().optional(),
  /** Prerequisite root ticket IDs that must reach `ended` before this ticket dispatches. */
  dependsOn: z.array(z.string()).optional(),
  /** Existing ticket ID that absorbed/resolved this work (duplicate/subsumed tracking). */
  supersededBy: z.string().optional(),
  /** Epoch millis when the ticket was accepted. */
  createdAt: z.number(),
  /** Epoch millis of the last durable mutation. */
  updatedAt: z.number().default(0),
})

export type TicketRecord = z.infer<typeof ticketRecord>

/** One batched Eval over one Thread's pending triggers. */
export const evalRecord = z.object({
  id: z.string(),
  /** The Thread the evaluated triggers belong to. */
  threadId: z.string(),
  /** The trigger ids in this batch, in arrival order. */
  triggerIds: z.array(z.string()),
  /**
   * `running` is in flight; `accepted` minted a ticket; `candidate` recorded
   * an acceptance the Policy wants a human to confirm; `rejected` was
   * declined; `failed` was inconclusive and its triggers re-queue;
   * `incomplete` ended without a decision after repeated inconclusive runs or
   * a policy change, and its triggers stay retired.
   */
  status: z.enum(['running', 'accepted', 'candidate', 'rejected', 'failed', 'incomplete']),
  /** The ticket the acceptance produced, when accepted. */
  ticketId: z.string().optional(),
  /** Epoch millis the eval started. */
  startedAt: z.number(),
  /** Epoch millis the eval finished, when finished. */
  finishedAt: z.number().optional(),
  /** The Policy version the eval ran under. */
  policyVersion: z.string().default('1'),
})

export type EvalRecord = z.infer<typeof evalRecord>

/**
 * Durable board state. Ticket records carry lifecycle state; board columns
 * are never stored — every column derives from ticket state. Evals record
 * the batching and decisions that produced tickets; dispatches record the
 * Executor Sessions working tickets.
 */
export const boardDomain = defineDomain({
  name: 'dsh_manager_board',
  version: 1,
  tables: {
    tickets: domainTable<TicketId, TicketRecord>(ticketRecord),
    evals: domainTable<EvalId, EvalRecord>(evalRecord),
    dispatches: domainTable<Branded<'DispatchId'>, DispatchRecord>(dispatchRecord),
    attentions: domainTable<Branded<'AttentionId'>, AttentionRecord>(attentionRecord),
    reviews: domainTable<Branded<'ReviewId'>, ReviewRecord>(reviewRecord),
  },
})

/** Stable board column id; the client owns the localized title for each. */
export type BoardColumnId = 'inbox' | 'pool' | 'todo' | 'running' | 'attention' | 'ended'

/** One board column as the wire sees it. */
export interface BoardColumn {
  /** Stable column id; the client owns the localized title. */
  readonly id: BoardColumnId
  /** Tickets currently projecting onto the column. */
  readonly count: number
}

/** Whole-board snapshot served to the kanban page. */
export interface BoardSummary {
  /** Fixed column order with one count each. */
  readonly columns: readonly BoardColumn[]
}

/** One ticket card as the wire sees it. */
export interface TicketView {
  readonly id: string
  readonly title: string
  readonly state: (typeof TICKET_STATES)[number]
  /** The Thread the ticket's triggers arrived on. */
  readonly threadId: string
  /** The DSH project the ticket belongs to, when mapped. */
  readonly projectId?: string
  /** Human-readable project/workspace name when resolved on the host. */
  readonly projectName?: string
  /** The originating connection id, when the ticket came from a Source. */
  readonly sourceConnectionId?: string
  /** Human-readable connection name when resolved on the host. */
  readonly sourceConnectionName?: string
  /** The connector-specific external object key, when it came from a Source. */
  readonly externalKey?: string
  /** Deep link back to the external object, when it has one. */
  readonly url?: string
  /** The mandate carried from acceptance, when present. */
  readonly mandate?: { readonly strength: 'explicit' | 'inferred'; readonly scope: string; readonly policyVersion: string }
  /** The flow annotation when the ticket walks a pipeline stage. */
  readonly flow?: TicketFlow
  /** Worktree & target repository plan attached to this ticket. */
  readonly worktree?: TicketWorktreePlan
  /** Shared scratch directory for intermediate process artifacts. */
  readonly scratchDir?: string
  /** Prerequisite ticket IDs configured on this ticket. */
  readonly dependsOn?: readonly string[]
  /** Unresolved prerequisite tickets currently blocking dispatch. */
  readonly waitingOn?: readonly { readonly id: string; readonly title: string; readonly state: TicketState }[]
  /** Existing ticket ID that absorbed/resolved this work, when superseded. */
  readonly supersededBy?: string
  /** The thread triggers fanned in after acceptance, newest first (live tickets only). */
  readonly fanIn?: readonly {
    readonly id: string
    readonly externalKey: string
    readonly url: string
    readonly occurredAt?: number
    readonly collectedAt: number
  }[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Project the stored tickets onto the board columns.
 * @param tickets - every stored ticket record.
 * @param inbox - count of pending (not yet evaluated) threads, derived from the trigger side.
 * @param pool - count of failed/incomplete evals waiting in the rework pool.
 * @returns the fixed column order with one count each.
 */
export function boardSummaryOf(tickets: readonly TicketRecord[], inbox = 0, pool = 0): BoardSummary {
  const counts: Record<TicketState, number> = { todo: 0, running: 0, attention: 0, ended: 0 }
  for (const ticket of tickets) counts[ticket.state] += 1
  return {
    columns: [
      { id: 'inbox', count: inbox },
      { id: 'pool', count: pool },
      { id: 'todo', count: counts.todo },
      { id: 'running', count: counts.running },
      { id: 'attention', count: counts.attention },
      { id: 'ended', count: counts.ended },
    ],
  }
}
