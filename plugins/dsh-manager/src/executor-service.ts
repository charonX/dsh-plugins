/**
 * The Executor: dispatches accepted tickets into per-ticket Executor
 * Sessions (spec §8). A dispatch starts through the durable effects queue,
 * runs under the concurrency ceiling (default 3), works inside a dedicated
 * agent preset with its own model, and reports through the `submit_report`
 * tool — the ticket's state never follows the dispatch's. Deliverables stay
 * in the executor's session log (the `present` tool's
 * `deliverables/presented` events) and are served as "Session id + turn"
 * references, never copied. The boot sweep marks interrupted runs so a crash
 * mid-dispatch never makes work silently disappear.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import z from '@deepseek-ai/schemastery'
import type { TicketRecord, TicketWorktreePlan } from './board-domain.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { answerAttention, askAttention, classifyConfirmationAnswer, isEscalationAttention, settleMatchingPendingAttentions, settlePendingEscalationAttentions, type AttentionAction, type AttentionRecord, type AttentionStorePort } from './attention/attention-core.ts'
import type { NotificationOrigin } from './notifications/notification-core.ts'
import { categorizeTool, requiresApproval } from './approval/approval-policy.ts'
import { resolveAgentModelOptions, type ModelOptionLayer } from './agent-model-options.ts'
import { createDomainAttentionStore } from './attention/storage-store.ts'
import { attentionAnswerInputSchema, attentionListInputSchema, type AttentionAnswerInput, type AttentionListInput, type AttentionView } from './attention/wire-types.ts'
import { cancelDispatch, enqueueDispatch, latestExternalSession, recordExternalSession, recordReport, startDispatch, touchDispatch, interruptDispatch, type DispatchRecord, type DispatchStorePort } from './dispatch/dispatch-core.ts'
import { buildExternalCliPrompt, runCliBackend, type ExternalAgentKind } from './dispatch/cli-backend.ts'
import type { AgentKind, CrewMember } from './crew/crew-core.ts'
import { ensureTicketWorktree, inspectTicketWorktree, removeTicketWorktree, worktreeBranchFor, worktreePathFor } from './dispatch/worktree.ts'
import { resolveTaskScratchDir } from './dispatch/scratch-artifacts.ts'
import { discoverWorkspaceSkills, formatSkillPromptLines } from './dispatch/workspace-skills.ts'
import { discoverProjectLandingFacts, formatLandingDiscoveryPromptLines, type ProjectLandingFacts } from './dispatch/landing-discovery.ts'
import { checkBranchRebaseStatus, createMrOrPr, localMergeBranch, pushBranch } from './dispatch/landing-ops.ts'
import { recordReview, type ReviewStorePort } from './review/review-core.ts'
import {
  dispatchCancelInputSchema,
  dispatchListInputSchema,
  dispatchTicketInputSchema,
  ticketChangeDiffInputSchema,
  ticketDetailInputSchema,
  type ChangesRef, type DeliverableRef, type DispatchCancelInput, type DispatchListInput, type DispatchMessageView,
  type DispatchTicketInput, type DispatchView, type FileDiffView, type ReportView,
  type TicketChangeDiffInput, type TicketDetailInput, type TicketDetailView, type TicketLinkView,
  type WorktreeInspectionView,
} from './dispatch/wire-types.ts'
import { flowChain, flowTimelineOf, type FlowTimelineView } from './flow/flow-core.ts'
import { unresolvedDependencies } from './board/dependency-core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The executor dispatch API served to the Dsh Manager client. */
    dshManagerExecutor: DshManagerExecutor
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed ticket does not exist. */
    'dshManager/ticket-not-found': { readonly id: string }
    /** The ticket already has a dispatch that has not ended. */
    'dshManager/dispatch-active': { readonly id: string }
    /** The ticket is waiting on unresolved prerequisite dependencies or a dependency update failed validation. */
    'dshManager/ticket-blocked': { readonly id: string; readonly waitingOn?: readonly string[] }
    /** The addressed dispatch does not exist. */
    'dshManager/dispatch-not-found': { readonly id: string }
    /** The addressed attention is missing or no longer pending. */
    'dshManager/attention-not-found': { readonly id: string }
  }
}

/** Executor facet configuration. */
export interface ExecutorConfig {
  /** The LLM provider route executor Sessions use; defaults to the profile default. */
  provider?: string
  /** The model executor Sessions use; defaults to the profile default. */
  model?: string
  /** The dispatch concurrency ceiling; defaults to 3. */
  maxConcurrent?: number
  /** The working directory for tickets without a mapped repo; defaults to the process cwd. */
  cwd?: string
  /** The executor turn budget in milliseconds; defaults to 5 minutes. */
  turnTimeoutMs?: number
  /** The idle scheduler tick in milliseconds; defaults to 5s. */
  tickMs?: number
}

export const ExecutorConfig: z<ExecutorConfig> = z.object({
  provider: z.string(),
  model: z.string(),
  maxConcurrent: z.natural(),
  cwd: z.string(),
  turnTimeoutMs: z.natural(),
  tickMs: z.natural(),
})

/** The dispatch effect kind: starting one Executor Session. */
const DISPATCH_EFFECT_KIND = 'dispatch-start'

/** The effect kind that delivers one answered attention into its Executor Session. */
const ANSWER_EFFECT_KIND = 'attention-answer'

/** The dedicated executor agent preset this service registers. */
const EXECUTOR_PRESET_ID = 'dsh-manager-executor'

/** The scheduler tick while idle. */
const DEFAULT_TICK_MS = 5_000

/** Build a recognizable DSH sidebar session title for an executor dispatch. */
function formatExecutorSessionTitle(ticket: TicketRecord): string {
  const externalKey = ticket.externalKey?.trim()
  const hasRealKey = externalKey !== undefined
    && externalKey !== ''
    && !externalKey.startsWith('manual-')
    && !externalKey.startsWith('ticket-')
  const label = hasRealKey ? `${externalKey} · ${ticket.title}` : ticket.title
  return `[工单] ${label}`
}

/** The concurrency ceiling when unconfigured. */
const DEFAULT_MAX_CONCURRENT = 3

export class DshManagerExecutor extends TypertRemoteService {
  /** Host services the executor reads. */
  static inject = ['agents', 'agentPresets', 'sessions', 'subprocess', 'workspaceRegistry', 'sandboxPolicy', 'workspaceChanges', 'dshManagerBoard', 'dshManagerMappings', 'dshManagerEffects', 'dshManagerNotifications', 'dshManagerChannel', 'dshManagerPolicy', 'dshManagerPipeline', 'dshManagerCrew']

  static Config: z<ExecutorConfig> = ExecutorConfig

  private config: ExecutorConfig
  private pumping = false
  private ticker?: ReturnType<typeof setInterval>
  /** The live executor agents by dispatch id; answer delivery follows up here. */
  private liveAgents = new Map<string, Agent>()
  /** Abort controllers for active dispatches (external CLIs and built-in turns). */
  private activeControllers = new Map<string, AbortController>()
  /** The parked approval decisions by attention id; the board's answer resolves them. */
  private parkedApprovals = new Map<string, (answer: string) => void>()

  constructor(ctx: Context, config: ExecutorConfig) {
    super(ctx, 'dshManagerExecutor', { namespace: 'dshManager' })
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    // A crash mid-run left `running` dispatches behind; this process owns
    // none of them, so every leftover is marked interrupted — queryable on
    // the ticket detail, never silently gone.
    const store = this.ctx.dshManagerBoard.dispatchStore()
    for (const record of store.listDispatches()) {
      if (record.state === 'running') await interruptDispatch(store, record.id, Date.now())
    }
    // The dedicated executor preset: the tools the dispatched work needs —
    // files and a shell for local edits and test runs, `present` for
    // deliverables. The shell row is platform-conditional (pwsh on Windows,
    // bash elsewhere). `workspace-changes` is deliberately absent: the host
    // loads it once at the root and observes every top-level session there —
    // a preset row would provide its service a second time and fail.
    const unregisterPreset = await this.ctx.agentPresets.register({
      id: EXECUTOR_PRESET_ID,
      name: 'Dsh Manager Executor',
      description: 'Per-ticket executor: local edits, diffs, and present deliverables.',
      plugins: [
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
        { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      ],
    })
    this.ctx.effect(() => unregisterPreset, 'dsh-manager: unregister executor preset')
    // The durable intent to start: the queue's delivery pumps the scheduler,
    // and the tick keeps it live between deliveries.
    this.ctx.dshManagerEffects.register(DISPATCH_EFFECT_KIND, async () => { void this.pump() })
    // An answered attention rides the same durable queue into its session.
    this.ctx.dshManagerEffects.register(ANSWER_EFFECT_KIND, async delivery => {
      const attentionId = (delivery.payload as { attentionId?: string }).attentionId
      if (typeof attentionId === 'string') await this.deliverAnswer(attentionId)
    })
    const tickMs = this.config.tickMs ?? DEFAULT_TICK_MS
    this.ticker = setInterval(() => { void this.pump() }, tickMs)
    this.ctx.effect(() => () => { clearInterval(this.ticker) }, 'dsh-manager: stop executor tick')
  }

  /** Queue one ticket's dispatch; the effects queue starts its Executor Session. */
  @Remote
  async dispatchTicket(rawInput: DispatchTicketInput): Promise<DispatchView> {
    const input = dispatchTicketInputSchema.parse(rawInput)
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const ticket = this.ctx.dshManagerBoard.ticketRecord(input.ticketId)
    if (ticket === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const waitingOn = unresolvedDependencies(this.ctx.dshManagerBoard.ticketRecords(), ticket)
    if (waitingOn.length > 0) {
      throw new RemoteError(
        'dshManager/ticket-blocked',
        `ticket ${input.ticketId} is waiting on unresolved dependencies (${waitingOn.map(dep => dep.id).join(', ')})`,
        { id: input.ticketId, waitingOn: waitingOn.map(dep => dep.id) },
      )
    }
    const active = store.listDispatches()
      .find(record => record.ticketId === input.ticketId && record.state !== 'ended')
    if (active !== undefined) {
      throw new RemoteError('dshManager/dispatch-active', `ticket ${input.ticketId} already has dispatch ${active.id}`, { id: active.id })
    }
    const record = await enqueueDispatch(store, input.ticketId, Date.now())
    await settleMatchingPendingAttentions(
      this.attentionStore(),
      att => isEscalationAttention(att) || (att.details?.startsWith('watchdog:stall:') ?? false),
      're-dispatched',
      Date.now(),
      input.ticketId,
    )
    await this.ctx.dshManagerEffects.enqueue(DISPATCH_EFFECT_KIND, { dispatchId: record.id })
    void this.pump()
    return this.viewOf(record)
  }

  /** The dispatch store the executor drives; the board owns the domain. */
  private attentionStore(): AttentionStorePort {
    return this.ctx.dshManagerBoard.attentionStore()
  }

  /** The review store the acceptance answers write; the board owns the domain. */
  private reviewStore(): ReviewStorePort {
    return this.ctx.dshManagerBoard.reviewStore()
  }

  /**
   * Answer one attention through the durable effects queue: the record is
   * marked answered first, then the delivery follows the answer up into the
   * Executor Session as a new user message.
   */
  @Remote
  async answerAttention(rawInput: AttentionAnswerInput): Promise<AttentionView> {
    return await this.answerAttentionWithOrigin(rawInput, 'web')
  }

  /**
   * Answer one attention while preserving caller origin so IM-tool answers do
   * not echo a duplicate confirmation back into IM.
   */
  async answerAttentionWithOrigin(rawInput: AttentionAnswerInput, origin: NotificationOrigin = 'web'): Promise<AttentionView> {
    const input = attentionAnswerInputSchema.parse(rawInput)
    const now = Date.now()
    const answered = await answerAttention(this.attentionStore(), input.attentionId, input.answer, now)
    if (answered === undefined) {
      throw new RemoteError('dshManager/attention-not-found', `attention ${input.attentionId} is not pending`, { id: input.attentionId })
    }
    await this.ctx.dshManagerNotifications.notify({
      id: `progress-att-${answered.id}-${now}`,
      kind: 'progress',
      attentionId: answered.id,
      ticketId: answered.ticketId,
      title: `已处理待办 (${answered.kind}): ${input.answer}`,
      at: now,
      origin,
    })
    // An approval's answer resolves the parked tool call in place: approved
    // lets the body run, a rejection denies with the opinion as the reason.
    const parked = this.parkedApprovals.get(answered.id)
    if (answered.kind === 'approval' && parked !== undefined) {
      parked(input.answer)
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'review') {
      // An acceptance's answer closes the flow chain (when at/past the last stage)
      // or advances an intermediate manually-passed stage; returning re-dispatches
      // (onto the preceding execution stage when reviewing a read-only review stage).
      if (input.answer.startsWith('approved')) {
        const ticket = this.ctx.dshManagerBoard.ticketRecord(answered.ticketId)
        if (ticket?.flow !== undefined) {
          const liveCount = (() => {
            try { return this.ctx.dshManagerPipeline.require(ticket.flow.pipelineId).stages.length } catch { return ticket.flow.stageCount }
          })()
          if (ticket.flow.stageIndex < liveCount - 1) {
            await this.ctx.dshManagerEffects.enqueue('flow-advance', { ticketId: answered.ticketId })
            return this.attentionViewOf(answered)
          }
        }
        await this.ctx.dshManagerBoard.finishTicket(answered.ticketId, Date.now())
      } else {
        const opinion = input.answer.replace(/^rejected:\s*/, '')
        const ticket = this.ctx.dshManagerBoard.ticketRecord(answered.ticketId)
        const targetTicketId = this.reworkTargetTicketIdOf(ticket)
        const targetDispatchId = targetTicketId === answered.ticketId
          ? answered.dispatchId
          : (this.latestDispatchIdOf(targetTicketId) ?? answered.dispatchId)
        await recordReview(this.reviewStore(), {
          ticketId: targetTicketId,
          dispatchId: targetDispatchId,
          verdict: 'rework',
          feedback: opinion,
          origin: 'human',
        }, Date.now())
        await this.ctx.dshManagerBoard.reopenStageTicket(targetTicketId)
        await this.dispatchIfIdleAndUnblocked(targetTicketId)
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'policy') {
      // A policy proposal: only the user's confirmation mints the next
      // version, exactly as proposed; a rejection leaves the Policy
      // untouched. The Steward has no direct-write path at all.
      if (input.answer.startsWith('approved')) {
        const payload = answered.action?.payload as { readonly change: string; readonly statement: string } | undefined
        const change = payload?.change
        if (payload !== undefined && (change === 'add-preference' || change === 'add-rejection' || change === 'relax-approval')) {
          await this.ctx.dshManagerPolicy.applyConfirmedProposal({ change, statement: payload.statement }, Date.now())
        }
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'suggest-end') {
      // A suggested close: the human's confirmation is the ending authority
      // on its own (spec story 66); ignoring just answers the suggestion —
      // the ticket stays open and no session follows up.
      if (classifyConfirmationAnswer(input.answer) === 'confirm') {
        await this.ctx.dshManagerBoard.finishTicket(answered.ticketId, Date.now())
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'question' && answered.dispatchId === 'steward' && answered.question.startsWith('[skip]')) {
      // A steward skip proposal: accept both button `'confirmed'` and natural affirmative replies.
      const decisionKind = classifyConfirmationAnswer(input.answer)
      await this.ctx.dshManagerEffects.enqueue('flow-advance', {
        ticketId: answered.ticketId,
        skipDecision: decisionKind === 'confirm' ? 'approved' : 'rejected',
      })
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'question' && answered.dispatchId === 'steward') {
      const verdict = classifyConfirmationAnswer(input.answer)
      if (verdict === 'reroute') {
        await this.ctx.get('dshManagerSteward')?.routeDirectTicket(answered.ticketId)
        return this.attentionViewOf(answered)
      }
      if (verdict === 'confirm' || verdict === 'custom') {
        await this.dispatchIfIdleAndUnblocked(answered.ticketId)
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'question' && answered.dispatchId === 'watchdog') {
      const verdict = classifyConfirmationAnswer(input.answer)
      if (answered.details?.startsWith('watchdog:stall:') === true) {
        const targetDispatchId = answered.details.slice('watchdog:stall:'.length)
        const dispatchStore = this.ctx.dshManagerBoard.dispatchStore()
        const target = dispatchStore.getDispatch(targetDispatchId)
        if (verdict === 'reject') {
          if (target !== undefined && target.state !== 'ended') {
            await cancelDispatch(dispatchStore, targetDispatchId, now, 'cancelled from stall attention')
          }
          this.activeControllers.get(targetDispatchId)?.abort(new Error('dsh-manager: cancelled by user'))
          this.activeControllers.delete(targetDispatchId)
          this.liveAgents.delete(targetDispatchId)
        } else if (target !== undefined && target.state !== 'ended') {
          await touchDispatch(dispatchStore, targetDispatchId, now)
        }
        return this.attentionViewOf(answered)
      }
      if (verdict === 'confirm') {
        await this.dispatchIfIdleAndUnblocked(answered.ticketId)
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'approval' && answered.action?.category === 'mandate-expansion') {
      // A follow-up's widened mandate was approved: mint the ticket and hand it
      // to Steward routing / Executor so approved follow-ups execute automatically.
      if (input.answer.startsWith('approved')) {
        const payload = answered.action.payload as { readonly parentTicketId: string; readonly title: string; readonly scope: string }
        const minted = await this.ctx.dshManagerBoard.mintFollowUp({
          parentId: payload.parentTicketId,
          title: payload.title,
          scope: payload.scope,
        }, Date.now())
        if (minted === undefined) {
          this.ctx.logger?.warn('the approved follow-up for %s could not mint (no ticket or mandate)', payload.parentTicketId)
        } else {
          const routed = await this.ctx.get('dshManagerSteward')?.routeDirectTicket(minted.id).catch(() => false)
          if (routed !== true) {
            await this.dispatchIfIdleAndUnblocked(minted.id)
          }
        }
      }
      return this.attentionViewOf(answered)
    }
    if (answered.kind === 'approval') {
      // Orphaned approval answered after a host restart (`parked === undefined`):
      // if approved and the ticket has no live runner, resume via dispatch.
      if (input.answer.startsWith('approved')) {
        await this.dispatchIfIdleAndUnblocked(answered.ticketId)
      }
      return this.attentionViewOf(answered)
    }
    if (isEscalationAttention(answered)) {
      if (classifyConfirmationAnswer(input.answer) === 'confirm') {
        await settlePendingEscalationAttentions(this.attentionStore(), answered.ticketId, input.answer, now)
        const ticket = this.ctx.dshManagerBoard.ticketRecord(answered.ticketId)
        if (ticket?.flow !== undefined) {
          const liveCount = (() => {
            try { return this.ctx.dshManagerPipeline.require(ticket.flow.pipelineId).stages.length } catch { return ticket.flow.stageCount }
          })()
          if (ticket.flow.stageIndex < liveCount - 1) {
            await this.ctx.dshManagerEffects.enqueue('flow-advance', { ticketId: answered.ticketId })
            return this.attentionViewOf(answered)
          }
        }
        await this.ctx.dshManagerBoard.finishTicket(answered.ticketId, Date.now())
        return this.attentionViewOf(answered)
      }
      const opinion = input.answer.replace(/^rejected:\s*/, '').trim()
      if (opinion !== '') {
        await settlePendingEscalationAttentions(this.attentionStore(), answered.ticketId, input.answer, now)
        const targetTicketId = this.reworkTargetTicketIdOf(this.ctx.dshManagerBoard.ticketRecord(answered.ticketId))
        await recordReview(this.reviewStore(), {
          ticketId: targetTicketId,
          dispatchId: this.latestDispatchIdOf(targetTicketId) ?? answered.dispatchId,
          verdict: 'rework',
          feedback: opinion,
          origin: 'human',
        }, Date.now())
        await this.ctx.dshManagerBoard.reopenStageTicket(targetTicketId)
        await this.dispatchIfIdleAndUnblocked(targetTicketId)
      }
      return this.attentionViewOf(answered)
    }
    await this.ctx.dshManagerEffects.enqueue(ANSWER_EFFECT_KIND, { attentionId: answered.id })
    return this.attentionViewOf(answered)
  }

  /**
   * Abort every queued/running dispatch and answer/dismiss pending attentions for `ticketId`
   * when manually closing a ticket so no runner or parked approval remains alive.
   */
  async abortTicketWork(ticketId: string, reason?: string): Promise<void> {
    const now = Date.now()
    const dispatchStore = this.ctx.dshManagerBoard.dispatchStore()
    const cancelReason = reason?.trim() ? `closed: ${reason.trim()}` : 'closed by user'
    for (const record of dispatchStore.listDispatches()) {
      if (record.ticketId !== ticketId || record.state === 'ended') continue
      await cancelDispatch(dispatchStore, record.id, now, cancelReason)
      this.activeControllers.get(record.id)?.abort(new Error(`dsh-manager: ${cancelReason}`))
      this.activeControllers.delete(record.id)
      this.liveAgents.delete(record.id)
    }
    const attentionStore = this.attentionStore()
    const closeAnswer = reason?.trim() ? `rejected: ${reason.trim()}` : 'rejected: closed by user'
    for (const att of attentionStore.listAttentions()) {
      if (att.ticketId !== ticketId || att.status !== 'pending') continue
      await answerAttention(attentionStore, att.id, closeAnswer, now)
      const parked = this.parkedApprovals.get(att.id)
      if (parked !== undefined) {
        parked(closeAnswer)
      }
    }
  }

  private latestDispatchIdOf(ticketId: string): string | undefined {
    return this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .filter(record => record.ticketId === ticketId)
      .sort((left, right) => right.createdAt - left.createdAt)[0]?.id
  }

  /** When rejecting a read-only review stage, return to its preceding execution stage if any. */
  private reworkTargetTicketIdOf(ticket: TicketRecord | undefined): string {
    if (ticket?.flow === undefined) return ticket?.id ?? ''
    try {
      const pipeline = this.ctx.dshManagerPipeline.require(ticket.flow.pipelineId)
      const stage = pipeline.stages[ticket.flow.stageIndex]
      if (stage?.mode !== 'review') return ticket.id
      const chain = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)
      if (chain === undefined) return ticket.id
      const pos = chain.stages.findIndex(entry => entry.id === ticket.id)
      const before = pos === -1 ? chain.stages : chain.stages.slice(0, pos)
      const prevExec = [...before].reverse().find(candidate => pipeline.stages[candidate.flow.stageIndex]?.mode !== 'review')
      return prevExec?.id ?? ticket.id
    } catch {
      return ticket.id
    }
  }

  /** Enqueue a dispatch when `ticketId` is open, unblocked, and has no running/queued dispatch. */
  private async dispatchIfIdleAndUnblocked(ticketId: string): Promise<void> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined || ticket.state === 'ended') return
    if (unresolvedDependencies(this.ctx.dshManagerBoard.ticketRecords(), ticket).length > 0) return
    const active = this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .some(record => record.ticketId === ticketId && record.state !== 'ended')
    if (active) return
    await this.dispatchTicket({ ticketId }).catch(error => {
      this.ctx.logger?.warn('failed to dispatch ticket %s: %s', ticketId, String(error))
    })
  }

  /** List attentions, newest first, optionally one ticket's. */
  @Remote
  async attentionList(rawInput: AttentionListInput): Promise<{ readonly attentions: readonly AttentionView[] }> {
    const input = attentionListInputSchema.parse(rawInput ?? {})
    const attentions = this.attentionStore().listAttentions()
      .filter(record => input.ticketId === undefined || record.ticketId === input.ticketId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(record => this.attentionViewOf(record))
    return { attentions }
  }

  /** The pending attention views, for the board's 待人工 projection. */
  pendingAttentionTicketIds(): ReadonlySet<string> {
    return new Set(this.attentionStore().listAttentions()
      .filter(record => record.status === 'pending')
      .map(record => record.ticketId))
  }

  /** Follow one answered attention up inside its Executor Session (or resume via dispatch when ended). */
  private async deliverAnswer(attentionId: string): Promise<void> {
    const attention = this.attentionStore().getAttention(attentionId)
    if (attention === undefined) return
    // An approval's outcome already reaches the model in-turn: the approved
    // action's body result, or the denial reason carrying the opinion.
    if (attention.kind === 'approval') return
    const dispatch = this.ctx.dshManagerBoard.dispatchStore().getDispatch(attention.dispatchId)
    const agent = dispatch?.state === 'running' ? this.liveAgents.get(attention.dispatchId) : undefined
    if (agent !== undefined) {
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `The user answered your question "${attention.question}": ${attention.answer ?? ''}`,
        }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      return
    }
    // Session ended, headless CLI stopped, or host restarted before user replied:
    // wake the ticket with a follow-up dispatch carrying the answered context.
    await this.dispatchIfIdleAndUnblocked(attention.ticketId)
  }

  /** One attention as the wire sees it. */
  private attentionViewOf(record: AttentionRecord): AttentionView {
    return record
  }

  /** List dispatches, newest first, optionally one ticket's history. */
  @Remote
  async dispatchList(rawInput: DispatchListInput): Promise<{ readonly dispatches: readonly DispatchView[] }> {
    const input = dispatchListInputSchema.parse(rawInput ?? {})
    const dispatches = this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .filter(record => input.ticketId === undefined || record.ticketId === input.ticketId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(record => this.viewOf(record))
    return { dispatches }
  }

  /** Cancel a queued or running dispatch and terminate its active runner if any. */
  @Remote
  async dispatchCancel(rawInput: DispatchCancelInput): Promise<{ readonly cancelled: boolean; readonly dispatch: DispatchView }> {
    const input = dispatchCancelInputSchema.parse(rawInput)
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const current = store.getDispatch(input.dispatchId)
    if (current === undefined) {
      throw new RemoteError('dshManager/dispatch-not-found', `dispatch ${input.dispatchId} does not exist`, { id: input.dispatchId })
    }
    if (current.state === 'ended') {
      return { cancelled: false, dispatch: this.viewOf(current) }
    }
    const updated = await cancelDispatch(store, input.dispatchId, Date.now(), 'cancelled by user')
    const controller = this.activeControllers.get(input.dispatchId)
    controller?.abort(new Error('dsh-manager: cancelled by user'))
    return { cancelled: updated !== undefined, dispatch: this.viewOf(updated ?? current) }
  }

  /** One ticket's whole detail: card, dispatch history, and deliverable refs. */
  @Remote
  async ticketDetail(rawInput: TicketDetailInput): Promise<TicketDetailView> {
    const input = ticketDetailInputSchema.parse(rawInput)
    const ticket = this.ctx.dshManagerBoard.ticketView(input.ticketId)
    if (ticket === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const rawDispatches = this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .filter(record => record.ticketId === input.ticketId)
      .sort((left, right) => right.createdAt - left.createdAt)
    const deliverables: DeliverableRef[] = []
    const changes: ChangesRef[] = []
    const dispatches: DispatchView[] = rawDispatches.map(record => {
      const session = record.sessionId !== undefined && (record.agentKind === undefined || record.agentKind === 'builtin')
        ? this.ctx.sessions.get(record.sessionId as SessionId)
        : undefined
      if (session !== undefined && record.sessionId !== undefined) {
        deliverables.push(...this.presentedOf(record.sessionId, session))
        changes.push(...this.changesOf(record.sessionId, session))
      }
      return this.viewOf(record, session)
    })
    return { ticket, dispatches, deliverables, changes, ...this.followUpLinks(input.ticketId) }
  }

  /** The follow-up chain of one ticket, for the detail view. */
  private followUpLinks(ticketId: string): { followUpOf?: TicketLinkView; followUps: readonly TicketLinkView[] } {
    const links = this.ctx.dshManagerBoard.ticketLinks(ticketId)
    return {
      ...(links.parent === undefined ? {} : { followUpOf: links.parent }),
      followUps: links.children,
    }
  }

  /**
   * One ticket's pipeline walk: the stage tickets the walk minted, their
   * states, skip reasons, and per-stage deliverables. A ticket outside any
   * walk reads as no timeline.
   */
  @Remote
  async flowTimeline(rawInput: TicketDetailInput): Promise<FlowTimelineView | undefined> {
    const input = ticketDetailInputSchema.parse(rawInput)
    const chain = flowChain(this.ctx.dshManagerBoard.ticketRecords(), input.ticketId)
    if (chain === undefined) return undefined
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const decorate = (ticket: { readonly id: string }): { readyReport?: string; deliverables?: readonly string[] } => {
      const dispatches = store.listDispatches().filter(record => record.ticketId === ticket.id)
      const ready = [...dispatches]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(record => [...record.reports].reverse().find(report => report.kind === 'ready'))
        .find(report => report !== undefined)
      const deliverables: string[] = []
      for (const record of dispatches) {
        if (record.sessionId === undefined) continue
        const session = this.ctx.sessions.get(record.sessionId as SessionId)
        if (session === undefined) continue
        deliverables.push(...this.presentedOf(record.sessionId, session).map(ref => ref.path))
      }
      return {
        ...(ready === undefined ? {} : { readyReport: ready.message }),
        ...(deliverables.length === 0 ? {} : { deliverables }),
      }
    }
    return flowTimelineOf(chain, decorate, (pipelineId) => {
      try {
        const pipeline = this.ctx.dshManagerPipeline.require(pipelineId)
        const stageMemberNames = pipeline.stages.map(stage => {
          try {
            return this.ctx.dshManagerCrew.require(stage.memberId).name
          } catch {
            return undefined
          }
        })
        return { name: pipeline.name, stageCount: pipeline.stages.length, stageMemberNames }
      } catch {
        return undefined
      }
    })
  }

  /**
   * One changed file's comparison, served straight from the harness diff
   * view by Session id, event seq, and file index — the same comparison the
   * harness UI renders, never a copy.
   */
  @Remote
  async ticketChangeDiff(rawInput: TicketChangeDiffInput): Promise<{ readonly diff?: FileDiffView }> {
    const input = ticketChangeDiffInputSchema.parse(rawInput)
    const diff = await this.ctx.workspaceChanges.diff(input.sessionId as SessionId, input.seq, input.index, new AbortController().signal)
    return { ...(diff === undefined ? {} : { diff: diff as FileDiffView }) }
  }

  /** Inspect the ticket's mapped git worktree (`status`, `--stat`, and unified diff). */
  @Remote
  async ticketWorktree(rawInput: TicketDetailInput): Promise<{ readonly worktree?: WorktreeInspectionView }> {
    const input = ticketDetailInputSchema.parse(rawInput)
    const ticket = this.ctx.dshManagerBoard.ticketRecord(input.ticketId)
    if (ticket === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const projectId = this.projectOfTicket(ticket)
    const workspace = projectId === undefined ? undefined : this.ctx.workspaceRegistry.get(projectId as WorkspaceId)
    const spec = this.resolveWorktreeSpec(ticket, workspace?.path)
    if (spec.repoRoot === undefined) return {}
    const worktree = await inspectTicketWorktree(this.ctx.subprocess, spec.repoRoot, spec.rootTicketId, {
      branch: spec.branch,
      ...(spec.path === undefined ? {} : { path: spec.path }),
    })
    return { worktree }
  }

  /** Remove the ticket's per-ticket git worktree when no dispatch is actively running. */
  @Remote
  async ticketWorktreeRemove(rawInput: TicketDetailInput): Promise<{ readonly removed: boolean }> {
    const input = ticketDetailInputSchema.parse(rawInput)
    const ticket = this.ctx.dshManagerBoard.ticketRecord(input.ticketId)
    if (ticket === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const active = store.listDispatches().find(record => record.ticketId === ticket.id && record.state !== 'ended')
    if (active !== undefined) {
      throw new RemoteError('dshManager/dispatch-active', `ticket ${ticket.id} still has active dispatch ${active.id}`, { id: active.id })
    }
    const projectId = this.projectOfTicket(ticket)
    const workspace = projectId === undefined ? undefined : this.ctx.workspaceRegistry.get(projectId as WorkspaceId)
    const spec = this.resolveWorktreeSpec(ticket, workspace?.path)
    if (spec.repoRoot === undefined) return { removed: false }
    return await removeTicketWorktree(this.ctx.subprocess, spec.repoRoot, spec.rootTicketId, {
      branch: spec.branch,
      ...(spec.path === undefined ? {} : { path: spec.path }),
    })
  }

  /**
   * Start every queued dispatch within the concurrency ceiling, oldest first.
   * The scheduler, the effects delivery, and the tests share this path; each
   * started executor runs detached, so the pump never blocks on a turn.
   */
  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const store = this.ctx.dshManagerBoard.dispatchStore()
      const tickets = this.ctx.dshManagerBoard.ticketRecords()
      const dispatches = store.listDispatches()
      const ticketsWithDispatches = new Set(dispatches.map(record => record.ticketId))
      const pendingAttentions = this.ctx.dshManagerBoard.pendingAttentionTicketIds()
      // Wake routed tickets whose prerequisite dependencies have all ended.
      for (const candidate of tickets) {
        if (candidate.state !== 'todo' || candidate.flow === undefined || candidate.flow.pendingSkip !== undefined) continue
        if (candidate.dependsOn === undefined || candidate.dependsOn.length === 0) continue
        if (ticketsWithDispatches.has(candidate.id) || pendingAttentions.has(candidate.id)) continue
        if (unresolvedDependencies(tickets, candidate).length > 0) continue
        const queuedRecord = await enqueueDispatch(store, candidate.id, Date.now())
        await this.ctx.dshManagerEffects.enqueue(DISPATCH_EFFECT_KIND, { dispatchId: queuedRecord.id })
      }
      const records = store.listDispatches()
      const byTicket = new Map(tickets.map(ticket => [ticket.id, ticket]))
      let slots = (this.config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) - records.filter(record => record.state === 'running').length
      const queued = records.filter(record => record.state === 'queued')
        .sort((left, right) => left.createdAt - right.createdAt)
      for (const next of queued) {
        if (slots <= 0) break
        const targetTicket = byTicket.get(next.ticketId)
        if (targetTicket !== undefined && unresolvedDependencies(tickets, targetTicket).length > 0) continue
        const sessionId = `dsh-manager-exec-${next.id}` as SessionId
        const started = await startDispatch(store, next.id, sessionId, Date.now())
        if (started === undefined) continue
        slots--
        void this.runExecutor(started).catch(error => {
          this.ctx.logger?.error(error)
        })
      }
    } finally {
      this.pumping = false
    }
  }

  /** Drive one executor turn for one started dispatch — either built-in DSH Session or Multica-style local CLI backend. */
  private async runExecutor(record: DispatchRecord): Promise<void> {
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const ticket = this.ctx.dshManagerBoard.ticketRecord(record.ticketId)
    if (ticket === undefined) {
      await recordReport(store, record.id, 'failed', 'the ticket no longer exists', Date.now())
      return
    }
    // A mapped ticket works inside its planned (or fallback) git worktree;
    // Steward can also designate `mode: 'none'` for read-only work or point
    // `repoRoot` to a nested sub-repo inside an aggregate workspace.
    const projectId = this.projectOfTicket(ticket)
    let cwd = this.config.cwd ?? process.cwd()
    let scratchBase = cwd
    let workspacePath: string | undefined
    if (projectId !== undefined) {
      const workspace = this.ctx.workspaceRegistry.get(projectId as WorkspaceId)
      if (workspace === undefined) {
        await recordReport(store, record.id, 'failed', `the mapped project ${projectId} has no workspace`, Date.now())
        return
      }
      workspacePath = workspace.path
      scratchBase = workspace.path
    }
    const worktreeSpec = this.resolveWorktreeSpec(ticket, workspacePath)
    if (projectId !== undefined) {
      if (worktreeSpec.mode === 'worktree' && worktreeSpec.repoRoot !== undefined) {
        try {
          cwd = await ensureTicketWorktree(this.ctx.subprocess, worktreeSpec.repoRoot, worktreeSpec.rootTicketId, {
            branch: worktreeSpec.branch,
            baseBranch: worktreeSpec.baseBranch,
            ...(worktreeSpec.path === undefined ? {} : { path: worktreeSpec.path }),
          })
          if (ticket.worktree?.path !== cwd) {
            await this.ctx.dshManagerBoard.updateWorktreePlan(worktreeSpec.rootTicketId, {
              mode: 'worktree',
              repoRoot: worktreeSpec.repoRoot,
              baseBranch: worktreeSpec.baseBranch,
              branch: worktreeSpec.branch,
              ...(worktreeSpec.mergeTarget === undefined ? {} : { mergeTarget: worktreeSpec.mergeTarget }),
              path: cwd,
            })
          }
        } catch (error) {
          await recordReport(store, record.id, 'failed', `the worktree failed to prepare: ${String(error)}`, Date.now())
          return
        }
      } else {
        cwd = worktreeSpec.repoRoot ?? workspacePath ?? cwd
      }
    }
    const taskScratchDir = projectId === undefined ? undefined : this.taskScratchDirOf(ticket, scratchBase)
    if (taskScratchDir !== undefined) {
      await mkdir(taskScratchDir, { recursive: true }).catch(() => {})
    }
    const stageMeta = this.stageAndMemberOf(ticket)
    const member = stageMeta.member
    const stageMode = stageMeta.stageMode
    const repoRoot = worktreeSpec.repoRoot ?? (projectId === undefined ? cwd : scratchBase)
    const landingFacts = projectId !== undefined && worktreeSpec.mode !== 'none' && this.isLandingStage(ticket, member?.name, stageMode)
      ? await discoverProjectLandingFacts(this.ctx.subprocess, cwd).catch(() => undefined)
      : undefined
    const agentKind: AgentKind = member?.agentKind ?? 'builtin'
    const lastRework = [...this.reviewStore().listReviews()]
      .filter(review => review.ticketId === ticket.id && review.verdict === 'rework')
      .sort((left, right) => right.decidedAt - left.decidedAt)[0]

    if (agentKind !== 'builtin') {
      await this.runExternalCliExecutor(store, record, ticket, agentKind, member, projectId, cwd, lastRework, taskScratchDir, stageMode, landingFacts, worktreeSpec)
      return
    }

    const executorSessionId = (record.sessionId ?? `dsh-manager-exec-${record.id}`) as SessionId
    let agent: Agent
    try {
      agent = await this.createExecutorAgent(record, ticket, executorSessionId, cwd, repoRoot, projectId, taskScratchDir)
    } catch (error) {
      await recordReport(store, record.id, 'failed', `the executor session failed to start: ${String(error)}`, Date.now())
      return
    }
    const controller = new AbortController()
    this.activeControllers.set(record.id, controller)
    const onCancel = (): void => { agent.cancel({ kind: 'hook', reason: 'dsh-manager: cancelled by user' }) }
    controller.signal.addEventListener('abort', onCancel, { once: true })
    const timer = this.config.turnTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          agent.cancel({ kind: 'hook', reason: 'dsh-manager: executor turn timed out' })
        }, this.config.turnTimeoutMs)
    let lastHeartbeatAt = Date.now()
    const offSessionEvent = this.ctx.on('session/event', (session) => {
      if (session.id !== executorSessionId) return
      const now = Date.now()
      if (now - lastHeartbeatAt < 15_000) return
      lastHeartbeatAt = now
      void touchDispatch(store, record.id, now).catch(() => undefined)
    })
    try {
      const skills = await discoverWorkspaceSkills(cwd)
      const base = this.executorPrompt(ticket, projectId, cwd, skills, taskScratchDir, stageMode, landingFacts, worktreeSpec)
      const prompt = lastRework === undefined ? base : [
        base,
        lastRework.origin === 'human'
          ? `The user returned this work with this opinion: "${lastRework.feedback}". Address it before reporting ready.`
          : `The Steward reworked this work with this opinion: "${lastRework.feedback}". Address it before reporting ready.`,
      ].join('\n')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await agent.whenIdle()
    } catch (error) {
      // A crashed turn leaves the dispatch running with its history; the
      // watchdog and the boot sweep account for it.
      this.ctx.logger?.error(error)
    } finally {
      offSessionEvent()
      if (timer !== undefined) clearTimeout(timer)
      controller.signal.removeEventListener('abort', onCancel)
      this.activeControllers.delete(record.id)
    }
  }

  /**
   * Multica-style headless CLI execution (`claude-code`, `codex`, `agy`):
   * streams NDJSON progress into dispatch reports, persists sticky external
   * session ids for rework `--resume`, and settles as `ready` or `failed`.
   */
  private async runExternalCliExecutor(
    store: DispatchStorePort,
    record: DispatchRecord,
    ticket: TicketRecord,
    agentKind: ExternalAgentKind,
    member: CrewMember | undefined,
    projectId: string | undefined,
    cwd: string,
    lastRework: { readonly origin: 'steward' | 'human'; readonly feedback: string } | undefined,
    taskScratchDir?: string,
    stageMode?: 'execute' | 'review',
    landingFacts?: ProjectLandingFacts,
    worktreeSpec?: ReturnType<DshManagerExecutor['resolveWorktreeSpec']>,
  ): Promise<void> {
    const resumeSessionId = latestExternalSession(store, ticket.id, agentKind)
    await recordExternalSession(store, record.id, agentKind, resumeSessionId, Date.now())
    const skills = resumeSessionId !== undefined && lastRework !== undefined ? [] : await discoverWorkspaceSkills(cwd)
    const prompt = this.externalCliPrompt(ticket, projectId, cwd, lastRework, resumeSessionId !== undefined, skills, taskScratchDir, stageMode, landingFacts, worktreeSpec)
    const idleTimeoutMs = this.config.turnTimeoutMs
    const controller = new AbortController()
    this.activeControllers.set(record.id, controller)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = (): void => {
      if (idleTimeoutMs === undefined) return
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        controller.abort(new Error(`dsh-manager: external cli executor timed out after ${Math.round(idleTimeoutMs / 1000)}s of inactivity`))
      }, idleTimeoutMs)
    }
    resetIdleTimer()
    const disposeAbort = this.ctx.effect(() => () => { controller.abort(new Error('dsh-manager: executor disposed')) }, `dsh-manager: abort cli dispatch ${record.id}`)

    let lastProgressAt = 0
    let lastHeartbeatAt = Date.now()
    const noteActivity = async (now = Date.now()): Promise<void> => {
      resetIdleTimer()
      if (now - lastHeartbeatAt < 15_000) return
      lastHeartbeatAt = now
      await touchDispatch(store, record.id, now)
    }
    let progressCount = 0
    let lastTextAt = 0
    let textCount = 0
    let lastLoggedText = ''
    let bufferedDelta = ''
    try {
      const outcome = await runCliBackend(this.ctx.subprocess, {
        kind: agentKind,
        cwd,
        prompt,
        mapped: projectId !== undefined,
        ...(member?.model === undefined ? {} : { model: member.model }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        signal: controller.signal,
        onActivity: () => noteActivity(),
        onEvent: async (event) => {
          const now = Date.now()
          await noteActivity(now)
          let recorded = false
          if (event.type === 'init') {
            await recordExternalSession(store, record.id, agentKind, event.externalSessionId, now)
          } else if (event.type === 'progress' && progressCount < 80) {
            if (now - lastProgressAt >= 1200) {
              lastProgressAt = now
              progressCount += 1
              recorded = true
              await recordReport(store, record.id, 'progress', `[${agentKind}] ${event.message}`, now, event.activity)
            }
          } else if (event.type === 'text_delta' && textCount < 16) {
            bufferedDelta += event.delta
            const trimmed = bufferedDelta.trim()
            if (trimmed !== '' && trimmed !== lastLoggedText && now - lastTextAt >= 1500) {
              lastTextAt = now
              textCount += 1
              lastLoggedText = trimmed
              recorded = true
              await recordReport(store, record.id, 'progress', trimmed.slice(0, 1500), now, { category: 'message', target: 'reply' })
            }
          } else if (event.type === 'text' && textCount < 16) {
            const trimmed = event.text.trim()
            if (trimmed !== '' && trimmed !== lastLoggedText && now - lastTextAt >= 1000) {
              lastTextAt = now
              textCount += 1
              lastLoggedText = trimmed
              recorded = true
              await recordReport(store, record.id, 'progress', trimmed.slice(0, 1500), now, { category: 'message', target: 'reply' })
            }
          }
          if (recorded) {
            lastHeartbeatAt = now
          }
        },
      })
      if (outcome.externalSessionId !== undefined) {
        await recordExternalSession(store, record.id, agentKind, outcome.externalSessionId, Date.now())
      }
      const abortReason = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : undefined
      const terminalOutput = !outcome.ok && abortReason !== undefined
        ? `${abortReason}${outcome.output ? `\n${outcome.output}` : ''}`
        : outcome.output
      const finishedAt = Date.now()
      await recordReport(
        store,
        record.id,
        outcome.ok ? 'ready' : 'failed',
        terminalOutput.slice(0, 16_000),
        finishedAt,
        outcome.ok ? { category: 'message', target: 'completed' } : { category: 'error', target: 'failed' },
      )
      await settleMatchingPendingAttentions(
        this.attentionStore(),
        att => att.details === `watchdog:stall:${record.id}`,
        'dispatch ended',
        finishedAt,
        ticket.id,
      )
      if (outcome.ok) {
        this.ctx.get('dshManagerSteward')?.scheduleReviewSoon()
      }
    } catch (error) {
      if (store.getDispatch(record.id)?.state !== 'ended') {
        const failedAt = Date.now()
        await recordReport(store, record.id, 'failed', `[${agentKind}] failed to run: ${String(error)}`, failedAt, { category: 'error', target: 'exception' })
        await settleMatchingPendingAttentions(
          this.attentionStore(),
          att => att.details === `watchdog:stall:${record.id}`,
          'dispatch ended',
          failedAt,
          ticket.id,
        )
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      disposeAbort()
      this.activeControllers.delete(record.id)
    }
  }

  /** Resolve the crew member and stage mode behind the ticket's current pipeline stage, if any. */
  private stageAndMemberOf(ticket: TicketRecord): { readonly member?: CrewMember; readonly stageMode?: 'execute' | 'review' } {
    if (ticket.flow === undefined) return {}
    try {
      const pipeline = this.ctx.dshManagerPipeline.require(ticket.flow.pipelineId)
      const stage = pipeline.stages[ticket.flow.stageIndex]
      if (stage === undefined) return {}
      return {
        member: this.ctx.dshManagerCrew.require(stage.memberId),
        ...(stage.mode === undefined ? {} : { stageMode: stage.mode }),
      }
    } catch {
      return {}
    }
  }

  /**
   * Resolve the ticket id whose git worktree this dispatch operates in.
   * All stages of one pipeline walk share their root ticket's worktree.
   */
  private worktreeTicketIdOf(ticket: TicketRecord): string {
    if (ticket.flow === undefined) return ticket.id
    return flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)?.root.id ?? ticket.id
  }

  /**
   * Resolve effective git repository root, base branch, feature branch, and
   * merge target from Steward's ticket plan (falling back cleanly to legacy
   * workspace/ticket defaults).
   */
  private resolveWorktreeSpec(ticket: TicketRecord, fallbackRepoRoot?: string): {
    readonly rootTicketId: string
    readonly mode: 'worktree' | 'in-place' | 'none'
    readonly repoRoot?: string
    readonly baseBranch: string
    readonly branch: string
    readonly path?: string
    readonly mergeTarget?: string
  } {
    const root = ticket.flow === undefined
      ? undefined
      : flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)?.root
    const rootTicketId = root?.id ?? ticket.id
    const plan = ticket.worktree ?? root?.worktree
    const mappedRoot = fallbackRepoRoot ?? (() => {
      const pid = this.projectOfTicket(ticket)
      return pid === undefined ? undefined : this.ctx.workspaceRegistry.get(pid as WorkspaceId)?.path
    })()
    const repoRoot = plan?.repoRoot !== undefined && existsSync(plan.repoRoot) ? plan.repoRoot : mappedRoot
    const mode = plan?.mode ?? (repoRoot !== undefined ? 'worktree' : 'none')
    const branch = worktreeBranchFor(rootTicketId, plan?.branch)
    const baseBranch = plan?.baseBranch?.trim() || 'main'
    const path = plan?.path !== undefined && plan.path.trim() !== ''
      ? plan.path.trim()
      : (repoRoot === undefined ? undefined : worktreePathFor(repoRoot, rootTicketId, { branch: plan?.branch }))
    const mergeTarget = plan?.mergeTarget?.trim() || undefined
    return {
      rootTicketId,
      mode,
      ...(repoRoot === undefined ? {} : { repoRoot }),
      baseBranch,
      branch,
      ...(path === undefined ? {} : { path }),
      ...(mergeTarget === undefined ? {} : { mergeTarget }),
    }
  }

  /** Format worktree plan lines so Executor and Delivery stages stay aligned. */
  private worktreePlanPromptLines(spec: ReturnType<DshManagerExecutor['resolveWorktreeSpec']> | undefined): readonly string[] {
    if (spec === undefined) return []
    if (spec.mode === 'none') {
      return ['Worktree plan: mode=none (read-only analysis; do not create a git worktree).']
    }
    const parts = [
      `mode=${spec.mode}`,
      spec.repoRoot === undefined ? undefined : `repoRoot=${spec.repoRoot}`,
      `baseBranch=${spec.baseBranch}`,
      `branch=${spec.branch}`,
      spec.mergeTarget === undefined ? undefined : `mergeTarget=${spec.mergeTarget}`,
    ].filter((part): part is string => part !== undefined)
    return [`Worktree plan: ${parts.join(', ')}.`]
  }

  /** Resolve the shared scratch task directory for a ticket or flow walk. */
  private taskScratchDirOf(ticket: TicketRecord, basePath: string): string {
    const root = ticket.flow === undefined
      ? undefined
      : flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)?.root
    const scratchDir = ticket.scratchDir ?? root?.scratchDir
    const scope = ticket.mandate?.scope ?? root?.mandate?.scope
    const acceptanceCriteria = ticket.acceptanceCriteria ?? root?.acceptanceCriteria
    return resolveTaskScratchDir({
      ...(scratchDir === undefined ? {} : { scratchDir }),
      ...(scope === undefined ? {} : { scope }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      rootTicketId: root?.id ?? ticket.id,
      basePath,
    })
  }

  /** Compact summaries of completed upstream stages in the same pipeline walk. */
  private upstreamStageLines(ticket: TicketRecord): readonly string[] {
    if (ticket.flow === undefined) return []
    const chain = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)
    if (chain === undefined) return []
    const store = this.ctx.dshManagerBoard.dispatchStore()
    const currentIndex = ticket.flow.stageIndex
    const lines: string[] = []
    for (const stageTicket of chain.stages) {
      if (stageTicket.flow.stageIndex >= currentIndex) continue
      const dispatches = store.listDispatches()
        .filter(record => record.ticketId === stageTicket.id)
        .sort((left, right) => right.createdAt - left.createdAt)
      const ready = dispatches
        .map(record => [...record.reports].reverse().find(report => report.kind === 'ready'))
        .find(report => report !== undefined)
      const deliverables: string[] = []
      for (const d of dispatches) {
        if (d.sessionId === undefined) continue
        const session = this.ctx.sessions.get(d.sessionId as SessionId)
        if (session === undefined) continue
        deliverables.push(...this.presentedOf(d.sessionId, session).map(ref => ref.path))
      }
      if (ready === undefined && deliverables.length === 0) continue
      const summary = ready === undefined ? '' : ready.message.slice(0, 260)
      const refs = deliverables.length === 0 ? '' : ` [deliverables: ${deliverables.join(', ')}]`
      lines.push(`- Stage ${stageTicket.flow.stageIndex + 1} (${stageTicket.title}): ${summary}${refs}`)
    }
    return lines.length === 0 ? [] : ['Upstream stage outputs:', ...lines]
  }

  /** Recent human answers & confirmations on `ticketId` so resumed/CLI dispatches continue cleanly. */
  private answeredAttentionLines(ticketId: string): readonly string[] {
    const answered = this.attentionStore().listAttentions()
      .filter(att => att.ticketId === ticketId && att.status === 'answered' && att.answer !== undefined && att.answer.trim() !== '')
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-4)
    if (answered.length === 0) return []
    return [
      'Recent human answers / confirmations for this ticket (act on these directly):',
      ...answered.map(att => `- [${att.kind}] ${att.question} => "${att.answer}"`),
    ]
  }

  /** Structured hand-off metadata and recent alignment excerpt from the originating discussion Session. */
  private handoffContextLines(ticket: TicketRecord): readonly string[] {
    const lines: string[] = []
    if (ticket.acceptanceCriteria !== undefined && ticket.acceptanceCriteria !== '') {
      lines.push(`Acceptance criteria: ${ticket.acceptanceCriteria}`)
    }
    if (ticket.handoffSessionId !== undefined && ticket.handoffSessionId !== '') {
      lines.push(`Origin discussion session: ${ticket.handoffSessionId}`)
      const originSession = this.ctx.sessions.get(ticket.handoffSessionId as SessionId)
      if (originSession !== undefined) {
        const excerpt: string[] = []
        for (const event of originSession.snapshotEvents()) {
          let role: 'user' | 'assistant' | undefined
          let blocks: readonly { readonly type?: string; readonly text?: string }[] | undefined
          if (event.type === 'user/message') {
            role = 'user'
            blocks = (event.data as { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }).content
          } else if (event.type === 'assistant/message') {
            role = 'assistant'
            blocks = (event.data as { readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] } }).message?.content
          }
          if (role === undefined || !Array.isArray(blocks)) continue
          const text = blocks
            .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
            .map(block => block.text!.trim())
            .join(' ')
            .replace(/\s+/g, ' ')
          if (text !== '') excerpt.push(`${role}: ${text.slice(0, 240)}`)
        }
        const recent = excerpt.slice(-4).join('\n')
        if (recent !== '') {
          lines.push('Recent context from requirement discussion:', recent.slice(0, 1000))
        }
      }
    }
    return lines
  }

  /** Prompt passed to a headless external CLI (no DSH-internal tool references). */
  private externalCliPrompt(
    ticket: TicketRecord,
    projectId: string | undefined,
    cwd: string,
    lastRework: { readonly origin: 'steward' | 'human'; readonly feedback: string } | undefined,
    resumed: boolean,
    skills: readonly { readonly name: string; readonly description: string; readonly path: string }[] = [],
    taskScratchDir?: string,
    stageMode?: 'execute' | 'review',
    landingFacts?: ProjectLandingFacts,
    worktreeSpec?: ReturnType<DshManagerExecutor['resolveWorktreeSpec']>,
  ): string {
    const mandate = ticket.mandate
    const flow = ticket.flow
    if (resumed && (lastRework !== undefined || this.answeredAttentionLines(ticket.id).length > 0)) {
      const answeredLines = this.answeredAttentionLines(ticket.id)
      return buildExternalCliPrompt({
        candidates: [lastRework?.feedback, ...answeredLines],
        bodyLines: [
          lastRework === undefined
            ? undefined
            : (lastRework.origin === 'human'
              ? `The user returned ticket ${ticket.id} with this review opinion: "${lastRework.feedback}".`
              : `The Steward returned ticket ${ticket.id} for rework with this opinion: "${lastRework.feedback}".`),
          ...answeredLines,
          projectId === undefined
            ? 'Analyze read-only and respond with the updated findings.'
            : (stageMode === 'review'
              ? `Re-run the incremental review in ${cwd}, verify open findings in ${taskScratchDir ?? cwd}/review-report.md, run all required tests/gates and save output to ${taskScratchDir ?? cwd}/test-report.log, and output a concise review summary stating whether all checks passed and any remaining blockers.`
              : `Apply the requested changes in the worktree at ${cwd}, run relevant tests/checks, save passing verification output to ${taskScratchDir ?? cwd}/test-report.log, and summarize what changed and what passed.`),
        ],
      })
    }
    const stageInfo = flow === undefined ? undefined : this.stagePromptInfo(ticket, flow)
    return buildExternalCliPrompt({
      candidates: [
        stageInfo?.stageInstruction,
        mandate?.scope,
        ticket.title,
      ],
      bodyLines: [
        `Ticket ${ticket.id}: ${ticket.title}.`,
        mandate === undefined ? undefined : `Mandate scope: ${mandate.scope} (strength ${mandate.strength}).`,
        ...this.handoffContextLines(ticket),
        ...(stageInfo?.lines ?? []),
        ...this.upstreamStageLines(ticket),
        ...this.answeredAttentionLines(ticket.id),
        ...formatSkillPromptLines(skills),
        ...this.worktreePlanPromptLines(worktreeSpec),
        ...(landingFacts === undefined ? [] : formatLandingDiscoveryPromptLines(landingFacts)),
        ...this.stageArtifactPromptLines(cwd, projectId !== undefined, taskScratchDir, stageMode),
        projectId === undefined
          ? 'This ticket has no mapped project: analyze read-only; do not modify any files.'
          : (stageMode === 'review'
            ? `Inspect the shared git worktree at ${cwd} (read-only against source/test files), run full tests/verification gates, and finish with a concise review summary covering test results, blocking findings (if any), and review-report.md / test-report.log paths.`
            : `Work directly in the git worktree at ${cwd}. Edit files, run tests/typecheck as needed, and finish with a concise summary of changes and verification results.`),
        'You are running in non-interactive headless CLI mode: do NOT call interactive ask_question or ask_user tools. If any open decisions remain, include them concisely with your recommended defaults in your final Markdown output.',
        lastRework === undefined
          ? undefined
          : (lastRework.origin === 'human'
            ? `Rework feedback from user: "${lastRework.feedback}".`
            : `Rework feedback from Steward: "${lastRework.feedback}".`),
      ],
    })
  }

  /** The project one ticket is mapped to, through its record or its external mapping. */
  private projectOfTicket(ticket: TicketRecord): string | undefined {
    if (ticket.projectId !== undefined) return ticket.projectId
    if (ticket.sourceConnectionId === undefined || ticket.externalKey === undefined) return undefined
    return this.ctx.dshManagerMappings.projectOf(ticket.sourceConnectionId, ticket.externalKey)
  }

  /** Whether the current dispatch should receive dynamic repository landing discovery context. */
  private isLandingStage(
    ticket: TicketRecord,
    memberName: string | undefined,
    stageMode: 'execute' | 'review' | undefined,
  ): boolean {
    if (ticket.flow === undefined) return true
    if (stageMode === 'review') return true
    if (ticket.flow.stageIndex >= Math.max(0, ticket.flow.stageCount - 1)) return true
    return memberName !== undefined && /(?:pr|mr|ship|land|release|交付|合并|发布)/i.test(memberName)
  }

  /** Create one fresh Executor Session under the dedicated preset. */
  private async createExecutorAgent(
    record: DispatchRecord,
    ticket: TicketRecord,
    sessionId: SessionId,
    cwd: string,
    repoRoot: string,
    projectId: string | undefined,
    taskScratchDir?: string,
  ): Promise<Agent> {
    const mapped = projectId !== undefined
    // A routed ticket's member may override the executor's provider/model.
    let memberOverrides: ModelOptionLayer = {}
    if (ticket.flow !== undefined) {
      try {
        const pipeline = this.ctx.dshManagerPipeline.require(ticket.flow.pipelineId)
        const stage = pipeline.stages[ticket.flow.stageIndex]
        if (stage !== undefined) {
          const member = this.ctx.dshManagerCrew.require(stage.memberId)
          memberOverrides = {
            ...(member.provider === undefined ? {} : { provider: member.provider }),
            ...(member.model === undefined ? {} : { model: member.model }),
          }
        }
      } catch {
        // A deleted member keeps the bundle defaults.
      }
    }
    const agentOptions = resolveAgentModelOptions(
      this.ctx,
      {
        ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
      },
      memberOverrides,
    )
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, EXECUTOR_PRESET_ID)
      agentCtx.tools.register(this.reportTool(record))
      agentCtx.tools.register(this.askTool(record))
      agentCtx.tools.register(this.commentTool(record))
      agentCtx.tools.register(this.jiraStatusTool(record))
      agentCtx.tools.register(this.checkBranchRebaseTool(cwd))
      agentCtx.tools.register(this.localMergeBranchTool(ticket, cwd, repoRoot, projectId))
      agentCtx.tools.register(this.pushBranchTool(cwd, projectId))
      agentCtx.tools.register(this.createMrOrPrTool(cwd))
      agentCtx.tools.register(this.registerWorktreeTool(sessionId, ticket))
      this.installApprovalGate(agentCtx, record)
    }
    const workspace = projectId === undefined ? undefined : this.ctx.workspaceRegistry.get(projectId as WorkspaceId)
    const ctxLookup = this.ctx as unknown as {
      get?(name: string): unknown
    }
    const workingDirectory = ctxLookup.get?.('workingDirectory') as
      | { set?(agent: Agent, path: string): Promise<string> }
      | undefined
    const sessionTitle = ctxLookup.get?.('sessionTitle') as
      | { rename?(target: Session, title: string): unknown }
      | undefined
    // Harness `workspace.attachSession` enforces `header.cwd === workspace.path`.
    // Anchor the session to the mapped project root when live `workingDirectory`
    // can immediately move into the isolated worktree so the session groups under
    // the mapped workspace instead of "Ungrouped".
    const sessionMetaCwd = workspace !== undefined && (cwd === workspace.path || workingDirectory?.set !== undefined)
      ? workspace.path
      : cwd
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions,
      meta: { cwd: sessionMetaCwd },
      setup,
    })
    this.liveAgents.set(record.id, handle.agent)
    this.ctx.effect(() => async () => { await handle.dispose() }, `dsh-manager: dispose executor session ${sessionId}`)
    // Sandbox mode and approval policy are durable session state: headless
    // background executors never block on native `ctx.approval` prompts
    // (external writes still gate through `tools/pre-execute` Attention).
    const session = this.ctx.sessions.get(sessionId)
    if (session !== undefined) {
      setApprovalPolicy(session, 'never')
      if (!mapped) {
        setSandboxMode(session, 'read-only')
      } else {
        setSandboxMode(session, 'workspace-write')
        const disposeRoot = this.ctx.sandboxPolicy.registerWritableRoot(session, cwd)
        this.ctx.effect(() => disposeRoot, `dsh-manager: release executor worktree grant ${sessionId}`)
        if (taskScratchDir !== undefined) {
          const disposeScratch = this.ctx.sandboxPolicy.registerWritableRoot(session, taskScratchDir)
          this.ctx.effect(() => disposeScratch, `dsh-manager: release executor scratch grant ${sessionId}`)
        }
        if (repoRoot !== cwd) {
          const disposeRepoRoot = this.ctx.sandboxPolicy.registerWritableRoot(session, repoRoot)
          this.ctx.effect(() => disposeRepoRoot, `dsh-manager: release executor repo root grant ${sessionId}`)
        }
      }
      const title = formatExecutorSessionTitle(ticket)
      try {
        if (sessionTitle?.rename !== undefined) sessionTitle.rename(session, title)
        else {
          (session as unknown as { append(type: string, data: unknown): unknown }).append('session/title', {
            title,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        }
      } catch (error) {
        this.ctx.logger?.warn('dsh-manager: failed to set executor session title %s: %s', sessionId, String(error))
      }
    }
    if (workspace !== undefined && sessionMetaCwd === workspace.path && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(sessionId).catch(error => {
        this.ctx.logger?.warn('dsh-manager: failed to attach executor session %s to workspace %s: %s', sessionId, workspace.id, String(error))
      })
    }
    if (workingDirectory?.set !== undefined && cwd !== sessionMetaCwd) {
      await workingDirectory.set(handle.agent, cwd).catch(error => {
        this.ctx.logger?.warn('dsh-manager: failed to switch executor working directory to %s: %s', cwd, String(error))
      })
    }
    return handle.agent
  }

  /** Artifact directory and review-fact-file rules shared by built-in and external CLI prompts. */
  private stageArtifactPromptLines(
    cwd: string,
    mapped: boolean,
    taskScratchDir: string | undefined,
    stageMode: 'execute' | 'review' | undefined,
  ): readonly string[] {
    if (!mapped || taskScratchDir === undefined) return []
    const lines: string[] = [
      `Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into ${cwd}): ${taskScratchDir}`,
    ]
    if (stageMode === 'review') {
      lines.push(
        `Strictly READ-ONLY Review stage: do NOT edit or commit business source files or test files in ${cwd}.`,
        `Cumulative Review Fact File: ${taskScratchDir}/review-report.md. On Round 1 (file absent), record baseSha (current git HEAD), Spec & Standards findings numbered F-01, F-02, ... with exact file:line, and Proven Failures. On Round 2+ (file present), run an INCREMENTAL review: verify previously open findings against git diff <prevSha>..HEAD and ${taskScratchDir}/test-report.log, and inspect ONLY the incremental diff for new regressions (do NOT re-open already-cleared code or invent new stylistic nitpicks outside the incremental diff).`,
        `Run all required checks and tests, write raw output tail to ${taskScratchDir}/test-report.log, update ${taskScratchDir}/review-report.md, and submit a concise review report summarizing: overall conclusion (passed or needs fixes), actual tests/gates run and their results, any open blocking issues (F-xx with file:line), and paths to review-report.md and test-report.log.`,
      )
    } else {
      lines.push(
        `If ${taskScratchDir}/review-report.md or ${taskScratchDir}/test-report.log exists from an earlier review/failure, read them first and resolve every open finding before reporting ready.`,
        `Save your final test/gate verification output to ${taskScratchDir}/test-report.log (and any design/repro logs to ${taskScratchDir}/).`,
      )
    }
    return lines
  }

  /** The prompt one executor turn opens with. */
  private executorPrompt(
    ticket: TicketRecord,
    projectId: string | undefined,
    cwd: string,
    skills: readonly { readonly name: string; readonly description: string; readonly path: string }[] = [],
    taskScratchDir?: string,
    stageMode?: 'execute' | 'review',
    landingFacts?: ProjectLandingFacts,
    worktreeSpec?: ReturnType<DshManagerExecutor['resolveWorktreeSpec']>,
  ): string {
    const mandate = ticket.mandate
    const flow = ticket.flow
    return [
      `You are the executor dispatched for ticket ${ticket.id}: ${ticket.title}.`,
      mandate === undefined ? undefined : `Your mandate covers ${mandate.scope} (strength ${mandate.strength}).`,
      ...this.handoffContextLines(ticket),
      // A routed ticket dispatches as one pipeline stage: the crew member's
      // duty prompt and the stage instruction open the work.
      ...(flow === undefined ? [] : this.stagePromptLines(ticket, flow)),
      ...this.upstreamStageLines(ticket),
      ...this.answeredAttentionLines(ticket.id),
      ...formatSkillPromptLines(skills),
      ...this.worktreePlanPromptLines(worktreeSpec),
      ...(landingFacts === undefined ? [] : formatLandingDiscoveryPromptLines(landingFacts)),
      ...this.stageArtifactPromptLines(cwd, projectId !== undefined, taskScratchDir, stageMode),
      projectId === undefined
        ? 'This ticket has no mapped project: analyze read-only; do not write or change any files.'
        : (stageMode === 'review'
          ? `This ticket is mapped to project ${projectId}. Review the shared worktree at ${cwd} read-only against source/test files, run verification commands, and write review artifacts only into ${taskScratchDir ?? cwd}.`
          : `This ticket is mapped to project ${projectId}. Work in the worktree at ${cwd}: edit files and run tests there; local edits and test runs are pre-approved, external actions are not.`),
      'Report through the submit_report tool: progress while working, waiting when input is pending, blocked when stuck, failed when the work cannot be done, not-needed when nothing is required, ready when the work is complete.',
      'When the work needs the user\'s input, ask through the ask_user tool with a concrete question and end your turn; the answer arrives as your next message.',
      'External writes & repository landing actions (post_mr_comment, set_jira_status, local_merge_branch, push_branch, create_mr_or_pr) wait for the user\'s approval before executing — use check_branch_rebase first for non-destructive baseline checks, and follow repository AGENTS.md + project-local skills (fallback: keep verified changes ready on branch and ask human if ambiguous).',
      'Declare final deliverable files with the present tool before reporting ready.',
    ].filter(line => line !== undefined).join('\n')
  }

  /** The duty/instruction lines a routed ticket's stage contributes to the prompt. */
  private stagePromptLines(ticket: TicketRecord, flow: NonNullable<TicketRecord['flow']>): readonly string[] {
    return this.stagePromptInfo(ticket, flow).lines
  }

  /** The duty/instruction lines plus raw instruction text for a routed stage. */
  private stagePromptInfo(ticket: TicketRecord, flow: NonNullable<TicketRecord['flow']>): {
    readonly stageInstruction?: string
    readonly lines: readonly string[]
  } {
    let pipeline
    let stage
    let member
    try {
      pipeline = this.ctx.dshManagerPipeline.require(flow.pipelineId)
      stage = pipeline.stages[flow.stageIndex]
      member = stage === undefined ? undefined : this.ctx.dshManagerCrew.require(stage.memberId)
    } catch {
      // A pipeline or member deleted mid-flight degrades to the plain prompt;
      // the ticket still executes its mandate.
      return { lines: [`This ticket walks pipeline stage ${flow.stageIndex + 1}/${flow.stageCount} of "${flow.pipelineName}", whose configuration changed; execute the mandate as given.`] }
    }
    if (stage === undefined || member === undefined) {
      return { lines: [`This ticket walks pipeline stage ${flow.stageIndex + 1}/${flow.stageCount} of "${flow.pipelineName}", whose configuration changed; execute the mandate as given.`] }
    }
    const liveStageCount = Math.max(pipeline.stages.length, flow.stageIndex + 1)
    return {
      ...(stage.instruction === '' ? {} : { stageInstruction: stage.instruction }),
      lines: [
        `You are "${member.name}", one stage of the "${pipeline.name}" pipeline (stage ${flow.stageIndex + 1} of ${liveStageCount}).`,
        `Your duty: ${member.role}`,
        stage.instruction === '' ? undefined : `This stage's instruction: ${stage.instruction}`,
      ].filter(line => line !== undefined),
    }
  }

  /**
   * The interception seam (ADR-0002): external-write tool calls park inside
   * the harness `tools/pre-execute` waterfall until the board's Approval is
   * answered — approved lets the body run, a rejection denies with the user's
   * opinion as the model-facing reason. Prompt text cannot bypass this; the
   * decision lives at the tool-call layer. Read, analyze, edit, test, and
   * draft tools are not categories and flow untouched.
   */
  private installApprovalGate(agentCtx: Context, record: DispatchRecord): void {
    agentCtx.on('tools/pre-execute', async (exec, next) => {
      const category = categorizeTool(exec.name)
      if (category === undefined || !requiresApproval(category)) return next()
      return await this.raiseApproval(record, exec.name, exec.arguments, exec.signal, category)
    })
  }

  /** Raise one approval attention, publish its notification, and hold the call until the board answers. */
  private async raiseApproval(
    record: DispatchRecord,
    toolName: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    category: AttentionAction['category'],
  ) {
    const attention = await askAttention(this.attentionStore(), {
      ticketId: record.ticketId,
      dispatchId: record.id,
      kind: 'approval',
      question: `the executor requested ${category} through ${toolName}`,
      action: { category, tool: toolName, payload: payload ?? {} },
    }, Date.now())
    await this.ctx.dshManagerNotifications.notify({
      id: attention.id,
      kind: 'attention',
      attentionId: attention.id,
      ticketId: attention.ticketId,
      title: attention.question,
      at: attention.createdAt,
      attentionKind: attention.kind,
      ...(attention.details === undefined ? {} : { details: attention.details }),
    })
    const answer = await new Promise<string>((resolve) => {
      this.parkedApprovals.set(attention.id, resolve)
      if (signal !== undefined) {
        const onAbort = (): void => resolve('rejected')
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    this.parkedApprovals.delete(attention.id)
    const opinion = answer.replace(/^rejected:\s*/, '')
    const decision: { kind: 'allow' } | { kind: 'deny'; reason: string } = answer.startsWith('approved')
      ? { kind: 'allow' }
      : { kind: 'deny', reason: opinion === '' ? 'the user rejected this action' : `the user rejected this action: ${opinion}` }
    return decision
  }

  /** The approved MR-comment write, replayed through the Channel. */
  private commentTool(record: DispatchRecord) {
    const self = this
    return defineTool({
      name: 'post_mr_comment',
      description: 'Post a comment on a GitLab merge request; requires the user\'s approval before it is sent.',
      parameters: {
        connectionId: { type: 'string', required: true, description: 'The GitLab connection to post through.' },
        projectId: { type: 'number', required: true, description: 'The GitLab project id.' },
        iid: { type: 'number', required: true, description: 'The merge request\'s iid.' },
        body: { type: 'string', required: true, description: 'The comment text, verbatim.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { posted: { type: 'boolean' }, detail: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `${value.posted ? 'posted' : 'failed'}: ${String(value.detail)}` }],
      },
      async execute(args, _exec) {
        const result = await self.ctx.dshManagerChannel.execute('post_mr_comment', args.connectionId, args)
        if (!result.ok) throw new Error(result.detail)
        return { posted: true, detail: result.detail }
      },
    })
  }

  /** The approved Jira status transition, replayed through the Channel. */
  private jiraStatusTool(record: DispatchRecord) {
    const self = this
    return defineTool({
      name: 'set_jira_status',
      description: 'Transition a Jira issue\'s status; requires the user\'s approval before it is applied.',
      parameters: {
        connectionId: { type: 'string', required: true, description: 'The Jira connection to transition through.' },
        issueKey: { type: 'string', required: true, description: 'The issue key, e.g. PROJ-12.' },
        transitionId: { type: 'string', required: true, description: 'The transition id to apply.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { applied: { type: 'boolean' }, detail: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `${value.applied ? 'applied' : 'failed'}: ${String(value.detail)}` }],
      },
      async execute(args, _exec) {
        const result = await self.ctx.dshManagerChannel.execute('set_jira_status', args.connectionId, args)
        if (!result.ok) throw new Error(result.detail)
        return { applied: true, detail: result.detail }
      },
    })
  }

  /** Non-destructive rebase/conflict probe against a base branch. */
  private checkBranchRebaseTool(cwd: string) {
    const self = this
    return defineTool({
      name: 'check_branch_rebase',
      description: 'Non-destructively inspect ahead/behind counts and dry-run merge/rebase conflict status against targetBranch.',
      parameters: {
        targetBranch: { type: 'string', description: 'Target branch name to compare against (defaults to main).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            currentBranch: { type: 'string' },
            targetBranch: { type: 'string' },
            cleanWorkingTree: { type: 'boolean' },
            behind: { type: 'number' },
            ahead: { type: 'number' },
            rebaseNeeded: { type: 'boolean' },
            rebaseWouldConflict: { type: 'boolean' },
            conflictFiles: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok
            ? `${String(value.currentBranch ?? 'HEAD')} vs ${String(value.targetBranch)}: ahead=${String(value.ahead)}, behind=${String(value.behind)}, conflicts=${String(value.conflictFiles?.length ?? 0)}`
            : `failed: ${String(value.error)}`,
        }],
      },
      async execute(args, _exec) {
        const target = typeof args.targetBranch === 'string' && args.targetBranch.trim() !== ''
          ? args.targetBranch.trim()
          : 'main'
        const res = await checkBranchRebaseStatus(self.ctx.subprocess, cwd, target)
        return { ...res, conflictFiles: [...res.conflictFiles] }
      },
    })
  }

  /** Approved local git landing tool serialized per project. */
  private localMergeBranchTool(
    ticket: TicketRecord,
    cwd: string,
    repoRoot: string,
    projectId: string | undefined,
  ) {
    const self = this
    const spec = this.resolveWorktreeSpec(ticket, repoRoot)
    const rootTicketId = spec.rootTicketId
    const effectiveRepoRoot = spec.repoRoot ?? repoRoot
    const sourceBranch = spec.branch
    const worktreePath = spec.path
    return defineTool({
      name: 'local_merge_branch',
      description: 'Rebase the ticket branch onto targetBranch (if configured) and merge locally under a per-project lock; requires Approval.',
      parameters: {
        targetBranch: { type: 'string', required: true, description: 'Target local branch to merge into (e.g. test or the branch specified in repo git-flow).' },
        strategy: { type: 'string', enum: ['rebase-then-ff', 'ff-only', 'merge-commit'], description: 'Merge strategy (default: rebase-then-ff).' },
        removeWorktreeOnSuccess: { type: 'boolean', description: 'Remove the ticket worktree cleanly after a successful merge.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            merged: { type: 'boolean' },
            aborted: { type: 'boolean' },
            targetBranch: { type: 'string' },
            sourceBranch: { type: 'string' },
            commitSha: { type: 'string' },
            conflictFiles: { type: 'array', items: { type: 'string' } },
            worktreeRemoved: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.merged
            ? `merged ${String(value.sourceBranch)} -> ${String(value.targetBranch)} (${String(value.commitSha ?? '')})`
            : `not merged (aborted=${String(value.aborted)}): ${String(value.error)}`,
        }],
      },
      async execute(args, _exec) {
        const requestedTarget = typeof args.targetBranch === 'string' && args.targetBranch.trim() !== ''
          ? args.targetBranch.trim()
          : spec.mergeTarget ?? 'main'
        const res = await localMergeBranch(self.ctx.subprocess, {
          repoRoot: effectiveRepoRoot,
          sourceBranch,
          targetBranch: requestedTarget,
          worktreeCwd: worktreePath ?? cwd,
          ...(args.strategy === 'rebase-then-ff' || args.strategy === 'ff-only' || args.strategy === 'merge-commit'
            ? { strategy: args.strategy }
            : {}),
          ...(args.removeWorktreeOnSuccess === true ? { removeWorktreeOnSuccess: true, ticketId: rootTicketId, worktreeBranch: sourceBranch, ...(worktreePath === undefined ? {} : { worktreePath }) } : {}),
          lockKey: projectId ?? effectiveRepoRoot,
        })
        return { ...res, conflictFiles: [...res.conflictFiles] }
      },
    })
  }

  /** Approved remote branch push tool serialized per project (never raw `--force`). */
  private pushBranchTool(cwd: string, projectId: string | undefined) {
    const self = this
    return defineTool({
      name: 'push_branch',
      description: 'Push the current or specified branch to remote under a per-project lock; requires Approval.',
      parameters: {
        remote: { type: 'string', description: 'Remote name (default: origin).' },
        branch: { type: 'string', description: 'Branch name to push (default: current checked-out branch).' },
        forceWithLease: { type: 'boolean', description: 'Use --force-with-lease after an approved rebase.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pushed: { type: 'boolean' },
            remote: { type: 'string' },
            branch: { type: 'string' },
            output: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.pushed ? `pushed ${String(value.branch)} -> ${String(value.remote)}` : `push failed: ${String(value.error)}`,
        }],
      },
      async execute(args, _exec) {
        return await pushBranch(self.ctx.subprocess, {
          cwd,
          ...(typeof args.remote === 'string' && args.remote.trim() !== '' ? { remote: args.remote.trim() } : {}),
          ...(typeof args.branch === 'string' && args.branch.trim() !== '' ? { branch: args.branch.trim() } : {}),
          ...(args.forceWithLease === true ? { forceWithLease: true } : {}),
          ...(projectId === undefined ? {} : { lockKey: projectId }),
        })
      },
    })
  }

  /** Approved PR / MR creation tool (`gh pr create` / `glab mr create`). */
  private createMrOrPrTool(cwd: string) {
    const self = this
    return defineTool({
      name: 'create_mr_or_pr',
      description: 'Create a GitHub PR or GitLab MR via gh/glab CLI; requires Approval.',
      parameters: {
        title: { type: 'string', required: true, description: 'Pull/Merge Request title.' },
        body: { type: 'string', required: true, description: 'Pull/Merge Request description and verification summary.' },
        baseBranch: { type: 'string', description: 'Target/base branch (e.g. main or develop).' },
        headBranch: { type: 'string', description: 'Source/head branch (optional; defaults to current branch).' },
        forge: { type: 'string', enum: ['auto', 'github', 'gitlab'], description: 'Forge CLI override (default: auto-detect from origin).' },
        draft: { type: 'boolean', description: 'Open as a draft PR/MR.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            created: { type: 'boolean' },
            forge: { type: 'string' },
            command: { type: 'string' },
            url: { type: 'string' },
            output: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.created ? `created ${String(value.forge)} request: ${String(value.url ?? value.output)}` : `failed: ${String(value.error)}`,
        }],
      },
      async execute(args, _exec) {
        return await createMrOrPr(self.ctx.subprocess, {
          cwd,
          title: String(args.title),
          body: String(args.body),
          ...(typeof args.baseBranch === 'string' && args.baseBranch.trim() !== '' ? { baseBranch: args.baseBranch.trim() } : {}),
          ...(typeof args.headBranch === 'string' && args.headBranch.trim() !== '' ? { headBranch: args.headBranch.trim() } : {}),
          ...(args.forge === 'github' || args.forge === 'gitlab' ? { forge: args.forge } : {}),
          ...(args.draft === true ? { draft: true } : {}),
        })
      },
    })
  }

  /** Register or update an executor-created worktree path/branch on the root ticket and grant sandbox write access. */
  private registerWorktreeTool(sessionId: SessionId, ticket: TicketRecord) {
    const self = this
    const rootTicketId = this.worktreeTicketIdOf(ticket)
    return defineTool({
      name: 'register_worktree',
      description: 'Register the active git worktree (repoRoot, path, branch, baseBranch, mergeTarget) on this ticket so downstream stages and board UI track it.',
      parameters: {
        mode: { type: 'string', enum: ['worktree', 'in-place', 'none'], description: 'Worktree mode (default worktree).' },
        repoRoot: { type: 'string', description: 'Exact git repository root path.' },
        path: { type: 'string', description: 'Filesystem path of the active worktree directory.' },
        branch: { type: 'string', description: 'Feature branch name (e.g. feat-... ).' },
        baseBranch: { type: 'string', description: 'Base branch name (default main).' },
        mergeTarget: { type: 'string', description: 'Integration target branch (e.g. test).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { registered: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `registered: ${String(value.registered)}` }],
      },
      async execute(args, _exec) {
        const mode = args.mode === 'none' || args.mode === 'in-place' ? args.mode : 'worktree'
        const clean = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
        const plan: TicketWorktreePlan = {
          mode,
          ...(clean(args.repoRoot) === undefined ? {} : { repoRoot: clean(args.repoRoot) }),
          ...(clean(args.baseBranch) === undefined ? {} : { baseBranch: clean(args.baseBranch) }),
          ...(clean(args.branch) === undefined ? {} : { branch: clean(args.branch) }),
          ...(clean(args.mergeTarget) === undefined ? {} : { mergeTarget: clean(args.mergeTarget) }),
          ...(clean(args.path) === undefined ? {} : { path: clean(args.path) }),
        }
        const updated = await self.ctx.dshManagerBoard.updateWorktreePlan(rootTicketId, plan)
        const session = self.ctx.sessions.get(sessionId)
        if (session !== undefined && mode !== 'none') {
          if (plan.path !== undefined) {
            const disposePath = self.ctx.sandboxPolicy.registerWritableRoot(session, plan.path)
            self.ctx.effect(() => disposePath, `dsh-manager: release registered worktree grant ${sessionId}`)
          }
          if (plan.repoRoot !== undefined) {
            const disposeRoot = self.ctx.sandboxPolicy.registerWritableRoot(session, plan.repoRoot)
            self.ctx.effect(() => disposeRoot, `dsh-manager: release registered repo grant ${sessionId}`)
          }
        }
        return { registered: updated !== undefined }
      },
    })
  }

  /** The one tool the executor Session mounts: reports into the dispatch core. */
  private reportTool(record: DispatchRecord) {
    const self = this
    return defineTool({
      name: 'submit_report',
      description: 'Report progress to the Steward for the dispatched ticket.',
      parameters: {
        kind: {
          type: 'string', required: true,
          enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'not-needed'],
          description: 'The report verb: what state the work is in.',
        },
        message: { type: 'string', required: true, description: 'What happened or what is needed, in one or two sentences.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `reported: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        const store = self.ctx.dshManagerBoard.dispatchStore()
        const updated = await recordReport(store, record.id, args.kind, args.message, Date.now())
        if (updated === undefined) throw new Error('the dispatch already ended')
        if (args.kind === 'ready') {
          self.ctx.get('dshManagerSteward')?.scheduleReviewSoon()
        }
        return { recorded: true }
      },
    })
  }

  /**
   * The structured ask tool: the only way into the user's attention — the
   * system never infers "waiting on a human" from free text (story 77).
   * Asking publishes an attention notification to every outlet.
   */
  private askTool(record: DispatchRecord) {
    const self = this
    return defineTool({
      name: 'ask_user',
      description: 'Ask the user a question when the work needs their input; the answer arrives as your next message.',
      parameters: {
        question: { type: 'string', required: true, description: 'The question, in one or two sentences.' },
        details: { type: 'string', required: true, description: 'Optional background that helps the user answer; an empty string when there is none.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { attentionId: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `asked: ${String(value.attentionId)}` }],
      },
      async execute(args, _exec) {
        const attention = await askAttention(self.attentionStore(), {
          ticketId: record.ticketId,
          dispatchId: record.id,
          question: args.question,
          ...(args.details === '' ? {} : { details: args.details }),
        }, Date.now())
        await self.ctx.dshManagerNotifications.notify({
          id: attention.id,
          kind: 'attention',
          attentionId: attention.id,
          ticketId: attention.ticketId,
          title: attention.question,
          at: attention.createdAt,
          attentionKind: attention.kind,
          ...(attention.details === undefined ? {} : { details: attention.details }),
        })
        return { attentionId: attention.id }
      },
    })
  }

  /** The deliverable refs one executor Session log holds. */
  private presentedOf(sessionId: string, session: Session): readonly DeliverableRef[] {
    const refs: DeliverableRef[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'deliverables/presented') continue
      const data = event.data as { readonly turn: number; readonly files: readonly { readonly path: string; readonly description?: string }[] }
      data.files.forEach((file, index) => {
        refs.push({
          sessionId,
          turn: data.turn,
          index,
          path: file.path,
          ...(file.description === undefined ? {} : { description: file.description }),
        })
      })
    }
    return refs
  }

  /** The workspace-change refs one executor Session log holds, live edits only. */
  private changesOf(sessionId: string, session: Session): readonly ChangesRef[] {
    const refs: ChangesRef[] = []
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'workspace/changes') continue
      const data = event.data as { readonly turn: number }
      // The diff summary lives in the host's live view; turns without actual
      // edits (total 0) are not deliverables.
      const summary = this.ctx.workspaceChanges.summary(sessionId as SessionId, event.seq)
      if (summary === undefined || summary.total === 0) continue
      refs.push({ sessionId, seq: event.seq, turn: data.turn, files: summary.total })
    }
    return refs
  }

  /** Extract readable assistant replies and tool calls from a built-in DSH Executor Session log. */
  private sessionMessagesOf(session: Session): readonly DispatchMessageView[] {
    const items: DispatchMessageView[] = []
    for (const event of session.snapshotEvents()) {
      const at = typeof event.time === 'number' ? event.time : Date.now()
      if (event.type === 'assistant/message') {
        const data = event.data as { readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] } }
        const blocks = data.message?.content
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
            .map(block => block.text!.trim())
            .join('\n\n')
          if (text !== '') {
            items.push({ id: `session-msg-${event.seq}`, role: 'assistant', text: text.slice(0, 4000), at })
          }
        }
      } else if (event.type === 'tool/call') {
        const data = event.data as { readonly name?: string; readonly arguments?: string }
        const name = typeof data.name === 'string' ? data.name : 'tool'
        if (name === 'submit_report') continue
        let target = ''
        if (typeof data.arguments === 'string' && data.arguments !== '') {
          try {
            const parsed = JSON.parse(data.arguments) as Record<string, unknown>
            const candidate = parsed.file_path ?? parsed.path ?? parsed.command ?? parsed.pattern ?? parsed.question
            if (typeof candidate === 'string') target = candidate.trim().slice(0, 80)
          } catch {
            // Partial or unparsed arguments degrade to tool name alone.
          }
        }
        const lower = name.toLowerCase()
        const category = lower.includes('bash') || lower.includes('pwsh') || lower.includes('exec')
          ? 'command'
          : (lower.includes('fs') || lower.includes('read') || lower.includes('edit') || lower.includes('write') || lower.includes('present'))
            ? 'file'
            : 'tool'
        items.push({
          id: `session-tool-${event.seq}`,
          role: 'tool',
          toolName: name,
          category,
          text: target !== '' ? `${name}: ${target}` : name,
          at,
        })
      }
    }
    return items
  }

  /** Merge Session messages/tool calls and dispatch reports into one readable timeline. */
  private messagesOf(record: DispatchRecord, session?: Session): readonly DispatchMessageView[] {
    const items: DispatchMessageView[] = session === undefined ? [] : [...this.sessionMessagesOf(session)]
    for (const report of record.reports) {
      const cat = report.activity?.category
      const role: DispatchMessageView['role'] = cat === 'message'
        ? 'assistant'
        : (cat === 'tool' || cat === 'command' || cat === 'file')
          ? 'tool'
          : 'report'
      // Collapse superseded streaming prefix snapshots so a partial delta never
      // lingers right above the full reply it grew into.
      if (role === 'assistant' || report.kind === 'ready' || report.kind === 'failed') {
        const lastAssistantIdx = items.findLastIndex(item => item.role === 'assistant')
        if (lastAssistantIdx !== -1) {
          const prev = items[lastAssistantIdx]!
          const prefix = prev.text.trim().slice(0, 28)
          if (prefix !== '' && report.message.trim().startsWith(prefix)) {
            items.splice(lastAssistantIdx, 1)
          }
        }
      }
      items.push({
        id: report.id,
        role,
        text: report.message,
        ...(report.activity?.toolName === undefined ? {} : { toolName: report.activity.toolName }),
        ...(cat === undefined ? {} : { category: cat }),
        at: report.at,
      })
    }
    return items.sort((left, right) => left.at - right.at).slice(-40)
  }

  private resolveSessionTitle(record: DispatchRecord, session?: Session): string | undefined {
    if (session !== undefined) {
      const titleSvc = (this.ctx as unknown as {
        get?: (name: string) => unknown
      }).get?.('sessionTitle') as { get?: (s: Session) => { title?: string } | undefined } | undefined
      const title = titleSvc?.get?.(session)?.title?.trim()
      if (title !== undefined && title !== '') return title
    }
    const ticket = this.ctx.dshManagerBoard.ticketRecord(record.ticketId)
    if (ticket?.flow !== undefined) {
      const member = this.stageAndMemberOf(ticket).member
      if (member !== undefined) return member.name
    }
    return ticket?.title
  }

  private viewOf(record: DispatchRecord, session?: Session): DispatchView {
    const reports: readonly ReportView[] = record.reports.map(report => ({
      id: report.id,
      kind: report.kind,
      message: report.message,
      ...(report.activity === undefined ? {} : { activity: report.activity }),
      at: report.at,
    }))
    const messages = this.messagesOf(record, session)
    const sessionTitle = this.resolveSessionTitle(record, session)
    return {
      id: record.id,
      ticketId: record.ticketId,
      state: record.state,
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      ...(record.agentKind === undefined ? {} : { agentKind: record.agentKind }),
      ...(record.externalSessionId === undefined ? {} : { externalSessionId: record.externalSessionId }),
      reports,
      ...(messages.length === 0 ? {} : { messages }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
}

export type { DispatchStorePort }
export default DshManagerExecutor
