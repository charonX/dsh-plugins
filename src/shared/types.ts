/**
 * Core type definitions for Autoloop microkernel and its plugins.
 *
 * @module @charonx/dsh-autoloop/shared/types
 */

/** Raw external event entering the Autoloop kernel */
export interface IngressEvent {
  /** Unique event identifier */
  id: string
  /** Source category: "feishu" | "github" | "cron" | "manual-ui" | "system" */
  source: string
  /** Thread or topic key to bind conversation context (e.g. "feishu:topic:123", "github:issue:42") */
  threadId: string
  /** Event action type: "task.create" | "comment.add" | "alert.fired" | "pipeline.next" */
  type: string
  /** One-line human-readable summary */
  summary: string
  /** Untrusted external data payload */
  payload?: Record<string, unknown>
  /** Sender metadata */
  sender?: {
    id?: string
    name?: string
  }
  /** Hop count for chained agent-to-agent triggers to prevent infinite recursion (starts at 0) */
  hopCount?: number
  /** Timestamp in milliseconds */
  receivedAt?: number
}

/** Status of an Autoloop Ticket */
export type TicketStatus =
  | 'pending'
  | 'running'
  | 'waiting_attention'
  | 'completed'
  | 'failed'
  | 'circuit_broken'

/** Task Priority Level */
export type PriorityLevel = 'p0' | 'p1' | 'p2' | 'p3'

/** Task Execution Schedule Mode */
export type ScheduleMode = 'immediate' | 'nightly' | 'scheduled'

/** Task Category / Intent */
export type TaskCategory =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'testing'
  | 'documentation'
  | 'review'
  | 'general'
  | string

/** Source of task */
export type TaskSource =
  | 'manual-ui'
  | 'feishu'
  | 'github'
  | 'sentry'
  | 'cron'
  | 'webhook'
  | string

/** Detailed audit record of how the task was triaged by IntentRouter */
export interface RouterTriage {
  /** Inferred or selected task intent/category */
  intent: TaskCategory
  /** Human-readable category label (e.g. "缺陷修复", "架构治理") */
  categoryLabel: string
  /** Assigned priority level */
  priority: PriorityLevel
  /** Execution schedule mode */
  scheduleMode: ScheduleMode
  /** Target scheduled timestamp (if scheduleMode === 'scheduled') */
  scheduledAt?: number
  /** Comprehensive reasoning explanation in natural language */
  reasoning: string
  /** Keywords or rules matched during triage */
  matchedRules: string[]
  /** Recommended or selected model */
  recommendedModel: string
  /** Recommended operational skills */
  recommendedSkills: string[]
  /** Permission preset assigned */
  permissionPreset: string
  /** Timestamp when triage evaluation occurred */
  evaluatedAt: number
}

/** Mandate issued to an agent */
export interface TicketMandate {
  /** Inferred or declared task intent: "coding" | "bugfix" | "review" | "cleanup" | "general" */
  intent: string
  /** Target workspace filesystem directory */
  workspacePath: string
  /** Model routing parameters */
  model: {
    provider?: string
    model?: string
  }
  /** Skills to mount */
  skills: string[]
  /** Safe, synthesized instruction (separate from untrusted payload) */
  instruction: string
  /** Permission preset (e.g. 'workspace-write' | 'danger-full-access' | 'read-only') */
  permissionPreset?: string
  /** Agent preset identity */
  agentPreset?: string
  /** Priority level */
  priority?: PriorityLevel
  /** Schedule mode */
  scheduleMode?: ScheduleMode
  /** Scheduled execution time */
  scheduledAt?: number
  /** Audit log of router triage */
  triage?: RouterTriage
}

/** Supplemental input fanned out to an active Ticket */
export interface TicketInput {
  id: string
  eventId: string
  text: string
  receivedAt: number
}

/** Human-in-the-loop decision card raised by an agent */
export interface AttentionRequest {
  id: string
  ticketId: string
  title: string
  question: string
  detail?: string
  options: Array<{
    label: string
    value: string
    style?: 'primary' | 'danger' | 'default'
  }>
  status: 'pending' | 'resolved' | 'expired'
  resolvedAnswer?: string
  createdAt: number
  resolvedAt?: number
}

/** Executed assignment tracking */
export interface TicketAssignment {
  assignmentId: string
  sessionId?: string
  startedAt: number
  endedAt?: number
  resultSummary?: string
  error?: string
}

/** Worktree isolation info */
export interface WorktreeInfo {
  enabled: boolean
  path?: string
  branch?: string
  baseCommit?: string
}

/** The durable Ticket entity */
export interface Ticket {
  id: string
  threadId: string
  title: string
  source: string
  status: TicketStatus
  priority: PriorityLevel
  scheduleMode: ScheduleMode
  scheduledAt?: number
  mandate: TicketMandate
  triage?: RouterTriage
  workspace: {
    sourceRoot: string
    worktree?: WorktreeInfo
  }
  assignment?: TicketAssignment
  inputs: TicketInput[]
  attention?: AttentionRequest
  hopCount: number
  createdAt: number
  updatedAt: number
}

/** Event sourcing journal entry types */
export type JournalEntry =
  | { type: 'ticket.created'; ticket: Ticket; at: number }
  | { type: 'ticket.input_added'; ticketId: string; input: TicketInput; at: number }
  | { type: 'ticket.status_changed'; ticketId: string; status: TicketStatus; at: number }
  | { type: 'ticket.schedule_changed'; ticketId: string; scheduleMode: ScheduleMode; priority?: PriorityLevel; at: number }
  | { type: 'ticket.assignment_started'; ticketId: string; assignment: TicketAssignment; at: number }
  | { type: 'ticket.assignment_ended'; ticketId: string; resultSummary?: string; error?: string; sessionId?: string; at: number }
  | { type: 'ticket.attention_raised'; ticketId: string; attention: AttentionRequest; at: number }
  | { type: 'ticket.attention_resolved'; ticketId: string; answer: string; at: number }

/** Snapshot returned to UI monitor and inspection routes */
export interface KernelStateSnapshot {
  stats: {
    totalTickets: number
    pendingCount: number
    runningCount: number
    attentionCount: number
    completedCount: number
    failedCount: number
  }
  tickets: Ticket[]
  maxHops: number
}

/** Approval channel port */
export interface ApprovalChannel {
  name: string
  sendAttention(attention: AttentionRequest): Promise<void>
}

/** Agent executor port */
export interface AgentExecutor {
  name: string
  execute(ticket: Ticket, signal: AbortSignal): Promise<{ summary?: string; error?: string; sessionId?: string }>
}
