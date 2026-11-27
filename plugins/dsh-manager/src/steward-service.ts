/**
 * The Steward: coordinates batched Thread Evals, pipeline routing, skip
 * decisions, Dispatch Reviews, and end suggestions through
 * short-lived isolated DSH Sessions (without `meta.cwd` so background turns do
 * not clutter the Web workspace session tree). Every decision is recorded
 * durably in storage-domain.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveAgentModelOptions } from './agent-model-options.ts'
import type { EvalRecord, TicketRecord, TicketWorktreePlan } from './board-domain.ts'
import { POLICY_VERSION, abandonEval, finishEval, pendingBacklog, requeueEval, startEval, type AcceptMode, type EvalDecision, type TicketOrigin } from './evals/eval-core.ts'
import {
  acceptCandidateInputSchema,
  evalListInputSchema,
  stewardPromptInputSchema,
  type CandidateView, type DecisionAction, type DecisionView, type EvalListInput, type EvalRecordView, type EvalTriggerView,
  type StewardPromptInput, type StewardPromptView, type StewardStatusView,
} from './evals/wire-types.ts'
import type { FlowDef, FlowStepDef } from './flow/flow-ir.ts'
import {
  MAX_RENDERED_PROMPT_BYTES,
  buildStewardBatchEvalPrompt,
  buildStewardEndSuggestionPrompt,
  buildStewardEvalPrompt,
  buildStewardGatePrompt,
  buildStewardRoutePrompt,
  truncateUtf8Bytes,
} from './prompt/prompt-builder.ts'
import { decisionsDomain, type DecisionRecord } from './decisions/decisions-domain.ts'
import { askAttention, settlePendingEscalationAttentions, type AttentionRecord } from './attention/attention-core.ts'
import type { PolicyProposalChange } from './policy/policy-core.ts'
import { inheritMandate } from './mandate/mandate-core.ts'
import { MAX_AUTO_REWORKS, autoReworkCount, recordReview, reviewPath, type ReviewVerdict } from './review/review-core.ts'
import { externalObjectEnded } from './triggers/trigger-core.ts'
import type { TriggerRecord } from './triggers/triggers-domain.ts'
import { flowChain } from './flow/flow-core.ts'
import { unresolvedDependencies } from './board/dependency-core.ts'
import { buildPortfolioSnapshot, formatPortfolioPromptLines } from './steward/portfolio-context.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Steward's main Session API served to the Dsh Manager client. */
    dshManagerSteward: DshManagerSteward
  }
}

/** Steward facet configuration. */
export interface StewardConfig {
  /** The LLM provider route the main Session uses. */
  provider?: string
  /** The model the main Session uses. */
  model?: string
  /** The operating mode: `auto` accepts explicit evidence, `confirm` asks. */
  mode?: 'auto' | 'confirm'
  /** The idle scheduler tick in milliseconds; defaults to 5s. */
  tickMs?: number
  /** The eval turn budget in milliseconds; defaults to 2 minutes. */
  evalTimeoutMs?: number
  /** Maximum backlog threads triaged together in one batch turn; defaults to 10. */
  evalBatchSize?: number
}

export const StewardConfig: z<StewardConfig> = z.object({
  provider: z.string(),
  model: z.string(),
  mode: z.union([z.const('auto'), z.const('confirm')]),
  tickMs: z.natural(),
  evalTimeoutMs: z.natural(),
  evalBatchSize: z.natural(),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed eval does not exist. */
    'dshManager/eval-not-found': { readonly id: string }
    /** The addressed eval is not a candidate (or has no acceptance to confirm). */
    'dshManager/eval-not-candidate': { readonly id: string }
    /** The addressed eval is not in a re-queueable state. */
    'dshManager/eval-not-requeueable': { readonly id: string }
  }
}

/** Default maximum backlog threads evaluated+routed together in one Steward turn. */
export const DEFAULT_EVAL_BATCH_SIZE = 10

/** Minimum/maximum clamped batch triage size. */
const MAX_EVAL_BATCH_SIZE = 50

/** The scheduler tick while idle. */
const DEFAULT_TICK_MS = 5_000

/** The effect kind an answered skip decision (or an accepted stage) enqueues to walk the pipeline. */
const FLOW_ADVANCE_EFFECT_KIND = 'flow-advance'

/** The eval turn budget. */
const DEFAULT_EVAL_TIMEOUT_MS = 120_000

interface StewardRoutePick {
  readonly flowId?: string
  readonly none?: boolean
  readonly rationale?: string
  readonly dependsOn?: readonly string[]
  readonly worktree?: TicketWorktreePlan
}

function normalizeWorktreePlan(raw: unknown): TicketWorktreePlan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const mode = obj.mode === 'none' || obj.mode === 'in-place' || obj.mode === 'worktree' ? obj.mode : undefined
  const clean = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const repoRoot = clean(obj.repoRoot)
  const baseBranch = clean(obj.baseBranch)
  const branch = clean(obj.branch)
  const mergeTarget = clean(obj.mergeTarget)
  const path = clean(obj.path)
  if (mode === undefined && repoRoot === undefined && branch === undefined && mergeTarget === undefined && baseBranch === undefined && path === undefined) {
    return undefined
  }
  return {
    mode: mode ?? 'worktree',
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(branch === undefined ? {} : { branch }),
    ...(mergeTarget === undefined ? {} : { mergeTarget }),
    ...(path === undefined ? {} : { path }),
  }
}

const WORKTREE_PLAN_PARAM = {
  type: 'object' as const,
  additionalProperties: false,
  description: 'Optional AI-analyzed worktree & target repo plan written onto the ticket.',
  properties: {
    mode: { type: 'string' as const, enum: ['worktree', 'in-place', 'none'], description: 'worktree for isolated code edits (default), none for read-only analysis, in-place for non-git paths.' },
    repoRoot: { type: 'string' as const, description: 'Exact git repository root path to modify (e.g. a sub-repo under repos/<name> rather than an aggregate root).' },
    baseBranch: { type: 'string' as const, description: 'Base branch to cut the new worktree from (default main).' },
    branch: { type: 'string' as const, description: 'Semantic feature branch starting with feat- (kebab-case, e.g. feat-dsh-manager-xxx).' },
    mergeTarget: { type: 'string' as const, description: 'Local integration target branch declared by that repo rules (e.g. test for dsh-plugins, or omit if PR-only).' },
  },
}

/**
 * One human-readable descriptor of a trigger's payload, so the main Session
 * can weigh the evidence (for example: a pipeline failure on the user's own
 * MR is explicit; a stranger's comment is only a hint).
 */
function describePayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind : undefined
  if (kind === 'comment') {
    const author = typeof record.author === 'string' ? record.author : 'someone'
    const body = typeof record.body === 'string' ? record.body.slice(0, 120) : ''
    return `new comment by ${author}: ${body}`
  }
  if (kind === 'pipeline') {
    const project = typeof record.project === 'string' ? record.project : ''
    const ref = typeof record.ref === 'string' ? ` on ${record.ref}` : ''
    const own = record.mine === true ? ', on the user’s own MR' : ''
    return `pipeline of ${project}${ref} failed${own}`
  }
  if (kind === 'mr') {
    return typeof record.state === 'string' ? `merge request (${record.state})` : 'merge request'
  }
  if (kind === 'manual') {
    return typeof record.description === 'string'
      ? `the user's own manual request: ${record.description.slice(0, 200)}`
      : 'the user\'s own manual request'
  }
  if (kind === 'jira') {
    const key = typeof record.key === 'string' ? record.key : ''
    const status = typeof record.status === 'string' ? record.status : typeof record.resolution === 'string' ? record.resolution : 'updated'
    return `jira issue ${key} (${status})`
  }
  return undefined
}

export class DshManagerSteward extends TypertRemoteService {
  /** Host services the Steward reads; notifications publish attentions, the executor dispatches & handles rework, and Flow IR supplies active workflows. */
  static inject = ['storageDomain', 'agents', 'dshManagerBoard', 'dshManagerSources', 'dshManagerNotifications', 'dshManagerExecutor', 'dshManagerPolicy', 'dshManagerConnections', 'dshManagerEffects', 'dshManagerFlow']

  static Config: z<StewardConfig> = StewardConfig

  private config: StewardConfig
  private domain?: Domain<typeof decisionsDomain>
  private ticking = false
  private ticker?: ReturnType<typeof setInterval> | undefined
  private reviewPokeTimer?: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** End-state triggers already put to a review turn, per ticket — never re-asked this process. */
  private handledEndTriggers = new Set<string>()
  private reviewing = false
  private suggesting = false
  /** The recent-activity ring the status RPC serves; capped, newest appended. */
  private activity: StewardStatusView['activity'] = []
  /** Ring buffer of the last 20 rendered Steward turn prompts for MonitorPage inspection. */
  private recentPrompts = new Map<string, StewardPromptView>()

  constructor(ctx: Context, config: StewardConfig) {
    super(ctx, 'dshManagerSteward', { namespace: 'dshManager' })
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(decisionsDomain)
    this.domain = domain
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close decisions domain')
    const store = this.ctx.dshManagerBoard.evalStore()
    // A crash mid-eval left `running` records behind; this process owns the
    // eval loop and starts with none, so every leftover re-queues.
    for (const record of store.listEvals()) {
      if (record.status === 'running') await abandonEval(store, record.id, 'failed')
    }
    // The Steward drives backlog evals, completed dispatch reviews, and end suggestions on each tick.
    const tickMs = this.config.tickMs ?? DEFAULT_TICK_MS
    this.ticker = setInterval(() => {
      void this.runTick().catch(() => {
        // Ignore teardown races when host services dispose mid-tick.
      })
    }, tickMs)
    this.ctx.effect(() => () => {
      this.disposed = true
      clearInterval(this.ticker)
      if (this.reviewPokeTimer !== undefined) {
        clearTimeout(this.reviewPokeTimer)
        this.reviewPokeTimer = undefined
      }
    }, 'dsh-manager: stop steward tick')
    // A flow advance (an answered skip decision, or an accepted stage) rides
    // the durable queue back into the steward: it owns the pipeline walk.
    this.ctx.dshManagerEffects.register(FLOW_ADVANCE_EFFECT_KIND, async delivery => {
      const payload = delivery.payload as { ticketId?: string; skipDecision?: 'approved' | 'rejected' }
      if (typeof payload.ticketId === 'string') {
        await this.advanceFlow({
          ticketId: payload.ticketId,
          ...(payload.skipDecision === undefined ? {} : { skipDecision: payload.skipDecision }),
        })
      }
    })
  }

  /** List the decisions recorded so far, newest first. */
  async listDecisions(): Promise<readonly DecisionRecord[]> {
    return [...this.domain!.table('decisions').entries()]
      .map(([, record]) => record)
      .sort((left, right) => right.decidedAt - left.decidedAt)
  }

  /** Record one activity entry for the status feed; the ring holds the last 50. */
  private note(kind: StewardStatusView['activity'][number]['kind'], text: string, promptId?: string): void {
    this.activity = [
      ...this.activity.slice(-49),
      { at: Date.now(), kind, text, ...(promptId === undefined ? {} : { promptId }) },
    ]
  }

  private teamConfigRevision(): number {
    const svc = (this.ctx as unknown as {
      get?: (key: string) => { status?: () => { readonly revision: number } } | undefined
    }).get?.('dshManagerTeamConfig')
    return svc?.status?.().revision ?? 1
  }

  private recordStewardPrompt(
    turnId: string,
    rawText: string,
  ): { readonly text: string; readonly promptId: string } {
    const capped = truncateUtf8Bytes(rawText, MAX_RENDERED_PROMPT_BYTES)
    const promptId = `steward-prompt-${crypto.randomUUID()}`
    const view: StewardPromptView = {
      promptId,
      turnId,
      text: capped.text,
      truncated: capped.truncated,
      sections: [{ id: 'body', text: capped.text, source: 'builtin', locked: false }],
      templateRevision: this.teamConfigRevision(),
      renderedAt: Date.now(),
    }
    this.recentPrompts.set(promptId, view)
    while (this.recentPrompts.size > 20) {
      const oldest = this.recentPrompts.keys().next().value
      if (oldest === undefined) break
      this.recentPrompts.delete(oldest)
    }
    return { text: capped.text, promptId }
  }

  /** Fetch the full rendered prompt for a recent Steward activity entry. */
  @Remote
  async stewardPrompt(rawInput: StewardPromptInput): Promise<{ readonly prompt?: StewardPromptView }> {
    const input = stewardPromptInputSchema.parse(rawInput)
    const prompt = this.recentPrompts.get(input.promptId)
    return { ...(prompt === undefined ? {} : { prompt }) }
  }

  /** The steward's live status: what it is doing, what waits, what it just did. */
  @Remote
  async stewardStatus(): Promise<StewardStatusView> {
    const busy = this.ticking || this.reviewing || this.suggesting
    return {
      busy,
      backlog: this.currentBacklog().length,
      mode: this.config.mode ?? 'auto',
      activity: [...this.activity].reverse(),
    }
  }

  /** List the acceptance candidates waiting for a human, newest first. */
  @Remote
  async candidateList(): Promise<{ readonly candidates: readonly CandidateView[] }> {
    const store = this.ctx.dshManagerBoard.evalStore()
    const decisionsByEval = new Map<string, DecisionRecord>()
    for (const [, record] of this.domain!.table('decisions').entries()) {
      const existing = decisionsByEval.get(record.evalId)
      if (existing === undefined || record.decidedAt > existing.decidedAt) decisionsByEval.set(record.evalId, record)
    }
    const candidates: CandidateView[] = []
    for (const evalRecord of store.listEvals()) {
      if (evalRecord.status !== 'candidate') continue
      const decisionRecord = decisionsByEval.get(evalRecord.id)
      const firstTriggerId = evalRecord.triggerIds[0]
      const firstTrigger = firstTriggerId === undefined
        ? undefined
        : this.ctx.dshManagerSources.threadTriggers(evalRecord.threadId)
          .find(trigger => evalRecord.triggerIds.includes(trigger.id))
      candidates.push({
        evalId: evalRecord.id,
        threadId: evalRecord.threadId,
        ...(decisionRecord?.title === undefined ? {} : { title: decisionRecord.title }),
        ...(firstTrigger === undefined ? {} : { externalKey: firstTrigger.externalKey, url: firstTrigger.url }),
        ...(decisionRecord === undefined ? {} : { rationale: decisionRecord.rationale }),
        ...(decisionRecord === undefined ? {} : { strength: decisionRecord.strength }),
      })
    }
    candidates.sort((left, right) => {
      const leftAt = store.getEval(left.evalId)?.startedAt ?? 0
      const rightAt = store.getEval(right.evalId)?.startedAt ?? 0
      return rightAt - leftAt
    })
    return { candidates }
  }

  /**
   * List every eval joined with its decision, batch, and source, newest
   * first — the records behind the eval records page.
   */
  @Remote
  async evalList(rawInput: EvalListInput): Promise<{ readonly evals: readonly EvalRecordView[] }> {
    const input = evalListInputSchema.parse(rawInput ?? {})
    const store = this.ctx.dshManagerBoard.evalStore()
    // One decision per eval: the latest write wins.
    const decisionsByEval = new Map<string, DecisionRecord>()
    for (const [, record] of this.domain!.table('decisions').entries()) {
      const existing = decisionsByEval.get(record.evalId)
      if (existing === undefined || record.decidedAt > existing.decidedAt) decisionsByEval.set(record.evalId, record)
    }
    const threadConnections = new Map(
      this.ctx.dshManagerSources.listThreadFacts().map(fact => [fact.id, fact.connectionId]))
    const views: EvalRecordView[] = []
    for (const evalRecord of store.listEvals()) {
      const connectionId = threadConnections.get(evalRecord.threadId)
      if (input.connectionId !== undefined && connectionId !== input.connectionId) continue
      if (input.status !== undefined && evalRecord.status !== input.status) continue
      const decisionRecord = decisionsByEval.get(evalRecord.id)
      if (input.action !== undefined && decisionRecord?.action !== input.action) continue
      const triggers: readonly EvalTriggerView[] = this.ctx.dshManagerSources.threadTriggers(evalRecord.threadId)
        .filter(trigger => evalRecord.triggerIds.includes(trigger.id))
        .map(trigger => ({ id: trigger.id, externalKey: trigger.externalKey, url: trigger.url }))
      const decision: DecisionView | undefined = decisionRecord === undefined ? undefined : {
        action: decisionRecord.action,
        strength: decisionRecord.strength,
        ...(decisionRecord.scope === undefined ? {} : { scope: decisionRecord.scope }),
        ...(decisionRecord.supersededBy === undefined ? {} : { supersededBy: decisionRecord.supersededBy }),
        policyVersion: decisionRecord.policyVersion,
        rationale: decisionRecord.rationale,
        decidedAt: decisionRecord.decidedAt,
      }
      // The flow view lets the run records present a walk's progress: the
      // stage facts come verbatim off the accepted ticket's annotation.
      const ticketFlow = evalRecord.ticketId === undefined
        ? undefined
        : this.ctx.dshManagerBoard.ticketRecord(evalRecord.ticketId)?.flow
      views.push({
        id: evalRecord.id,
        threadId: evalRecord.threadId,
        status: evalRecord.status,
        startedAt: evalRecord.startedAt,
        ...(evalRecord.finishedAt === undefined ? {} : { finishedAt: evalRecord.finishedAt }),
        policyVersion: evalRecord.policyVersion,
        ...(decision === undefined ? {} : { decision }),
        ...(connectionId === undefined ? {} : { sourceConnectionId: connectionId }),
        ...(ticketFlow === undefined ? {} : { flow: { pipelineName: ticketFlow.pipelineName, stageIndex: ticketFlow.stageIndex, stageCount: ticketFlow.stageCount } }),
        triggers,
      })
    }
    views.sort((left, right) => right.startedAt - left.startedAt)
    return { evals: views }
  }

  /** Resolve the effective batch size from UI settings, config, or default (10). */
  private resolveEvalBatchSize(): number {
    const raw = this.ctx.get('dshManagerSettings')?.configuredEvalBatchSize()
      ?? this.config.evalBatchSize
      ?? DEFAULT_EVAL_BATCH_SIZE
    if (!Number.isFinite(raw)) return DEFAULT_EVAL_BATCH_SIZE
    return Math.max(1, Math.min(MAX_EVAL_BATCH_SIZE, Math.floor(raw)))
  }

  /** Scheduled tick: evaluate trigger backlogs, review completed dispatches, and check end suggestions. */
  async runTick(): Promise<void> {
    if (this.disposed) return
    await this.runPending()
    if (this.disposed) return
    await this.reviewPending()
    if (this.disposed) return
    await this.runEndSuggestions()
  }

  /**
   * Nudge review scheduling promptly after an executor finishes with `ready`.
   * Skipped when the Steward tick is parked at >= 60s (e.g. deterministic boot tests).
   */
  scheduleReviewSoon(): void {
    const tickMs = this.config.tickMs ?? DEFAULT_TICK_MS
    if (tickMs >= 60_000 || this.reviewPokeTimer !== undefined) return
    this.reviewPokeTimer = setTimeout(() => {
      this.reviewPokeTimer = undefined
      void this.reviewPending().catch(error => { this.ctx.logger?.error(error) })
    }, 100)
  }

  /**
   * Evaluate every thread backlog pending at the start of the pass in
   * configurable batches (default 10), combining Eval + Route into one short
   * Steward turn whenever multiple threads await triage.
   */
  async runPending(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const backlog = this.currentBacklog()
      const batchSize = this.resolveEvalBatchSize()
      for (let offset = 0; offset < backlog.length; offset += batchSize) {
        const chunk = backlog.slice(offset, offset + batchSize)
        try {
          if (chunk.length === 1) {
            const next = chunk[0]!
            await this.evaluateThread(next.threadId, next.triggerIds, next.acceptMode)
          } else {
            await this.evaluateBatch(chunk)
          }
        } catch (error) {
          // A failed eval (model unavailable, crashed turn) stays on the
          // backlog; the next boot's sweep re-queues it.
          this.ctx.logger?.error(error)
          this.note('eval-failed', String(error).slice(0, 160))
          break
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** The threads whose triggers no eval has covered and no live ticket subscribes, with their accept modes. */
  private currentBacklog(): readonly { threadId: string; triggerIds: readonly string[]; acceptMode: AcceptMode }[] {
    const store = this.ctx.dshManagerBoard.evalStore()
    const facts = this.ctx.dshManagerSources.listTriggerFacts()
    const evals: readonly EvalRecord[] = store.listEvals()
    const tickets = store.listTickets()
    return pendingBacklog(facts, evals, tickets).map(entry => ({
      threadId: entry.threadId,
      triggerIds: entry.triggerIds,
      // The mode rides the thread's first trigger's Source instance.
      acceptMode: facts.find(fact => fact.threadId === entry.threadId)?.acceptMode as AcceptMode ?? this.config.mode ?? 'auto',
    }))
  }

  /** Abandon an inconclusive eval or retire it after repeated failures. */
  private async abandonInconclusive(threadId: string, evalId: string): Promise<void> {
    const store = this.ctx.dshManagerBoard.evalStore()
    const previousFailures = store.listThreadEvals(threadId)
      .filter(record => record.status === 'failed').length
    if (previousFailures >= 1) {
      const abandoned = await abandonEval(store, evalId, 'incomplete')
      this.note('eval-incomplete', threadId)
      await this.recordIncomplete(abandoned.threadId, evalId, previousFailures + 1)
      return
    }
    await abandonEval(store, evalId, 'failed')
    this.note('eval-failed', threadId)
  }

  /** Persist decision audit row, finalize the eval, and route/dispatch any accepted ticket. */
  private async settleEvalOutcome(
    threadId: string,
    evalId: string,
    triggers: readonly TriggerRecord[],
    acceptMode: AcceptMode,
    decision: EvalDecision,
    flows: readonly FlowDef[],
    inlineRoute?: StewardRoutePick,
    evalPromptId?: string,
  ): Promise<void> {
    const store = this.ctx.dshManagerBoard.evalStore()
    await this.recordEvalDecision(evalId, threadId, decision)
    const first = triggers[0]
    const connectionId = this.ctx.dshManagerSources.listThreadFacts()
      .find(fact => fact.id === threadId)?.connectionId
    const payload = first?.payload as { readonly projectId?: unknown } | undefined
    const origin: TicketOrigin = {
      ...(first === undefined ? {} : { externalKey: first.externalKey, url: first.url }),
      ...(connectionId === undefined ? {} : { sourceConnectionId: connectionId }),
      ...(typeof payload?.projectId === 'string' ? { projectId: payload.projectId } : {}),
    }
    await finishEval(store, evalId, decision, undefined, acceptMode, Date.now(), origin)
    const noteSuffix = decision.action === 'ignore' && decision.supersededBy !== undefined
      ? ` · supersededBy ${decision.supersededBy}`
      : decision.title === undefined ? '' : ` · ${decision.title}`
    this.note('eval-decision', `${decision.action}${noteSuffix}`, evalPromptId)
    const outcomeTicket = store.getEval(evalId)?.ticketId
    if (decision.action !== 'accept' || outcomeTicket === undefined) return
    if (inlineRoute !== undefined && (inlineRoute.none === true || inlineRoute.flowId !== undefined)) {
      await this.applyRoutePick(outcomeTicket, flows, inlineRoute, evalPromptId)
      return
    }
    await this.routeAndDispatch(outcomeTicket)
  }

  /** Drive one eval turn for an already-started eval record and settle or abandon it. */
  private async runSingleEval(
    evalId: string,
    threadId: string,
    triggers: readonly TriggerRecord[],
    acceptMode: AcceptMode,
  ): Promise<void> {
    const store = this.ctx.dshManagerBoard.evalStore()
    let evalOutcome: { readonly decision: EvalDecision | undefined; readonly promptId: string } | undefined
    try {
      this.note('eval-start', `${triggers[0]?.externalKey ?? threadId} (+${triggers.length})`)
      evalOutcome = await this.driveTurn(evalId, threadId, triggers)
    } catch (error) {
      await abandonEval(store, evalId, 'failed')
      throw error
    }
    if (evalOutcome.decision === undefined) {
      await this.abandonInconclusive(threadId, evalId)
      return
    }
    const flows = this.ctx.dshManagerFlow.list().filter(flow => flow.enabled)
    await this.settleEvalOutcome(threadId, evalId, triggers, acceptMode, evalOutcome.decision, flows, undefined, evalOutcome.promptId)
  }

  /** Drive one eval turn for one thread's triggers in an isolated short Session. */
  private async evaluateThread(threadId: string, triggerIds: readonly string[], acceptMode: AcceptMode): Promise<void> {
    const store = this.ctx.dshManagerBoard.evalStore()
    const evalId = `eval-${crypto.randomUUID()}`
    await startEval(store, threadId, triggerIds, evalId, Date.now())
    const triggers = this.ctx.dshManagerSources.threadTriggers(threadId)
      .filter(trigger => triggerIds.includes(trigger.id))
    await this.runSingleEval(evalId, threadId, triggers, acceptMode)
  }

  /** Drive one combined Eval + Route triage turn over a batch of pending threads. */
  private async evaluateBatch(
    chunk: readonly { readonly threadId: string; readonly triggerIds: readonly string[]; readonly acceptMode: AcceptMode }[],
  ): Promise<void> {
    const store = this.ctx.dshManagerBoard.evalStore()
    const now = Date.now()
    const prepared = chunk.map(entry => ({
      ...entry,
      evalId: `eval-${crypto.randomUUID()}`,
      triggers: this.ctx.dshManagerSources.threadTriggers(entry.threadId)
        .filter(trigger => entry.triggerIds.includes(trigger.id)),
    }))
    for (const item of prepared) {
      await startEval(store, item.threadId, item.triggerIds, item.evalId, now)
    }
    const flows = this.ctx.dshManagerFlow.list().filter(flow => flow.enabled)
    const decisions = this.ctx.dshManagerPolicy.currentPolicy().decisions
    const recordLines = decisions.map(entry => `- [${entry.kind}] ${entry.statement}`)
    const threadBlocks = prepared.map((item, idx) => {
      const triggerLines = item.triggers.map(trigger => {
        const detail = describePayload(trigger.payload)
        return `  - [${trigger.externalKey}] ${trigger.url} (collected ${new Date(trigger.collectedAt).toISOString()}${detail === undefined ? '' : `; ${detail}`})`
      })
      return [
        `${idx + 1}. thread ${item.threadId} (eval ${item.evalId})`,
        ...triggerLines,
      ].join('\n')
    })
    const flowLines = flows.map(flow =>
      `- flow ${flow.id} "${flow.name}" (${flow.steps.length} steps, workspace=${flow.workspaceMode}): ${flow.when}`,
    )
    const batchProjectIds = new Set(
      prepared.flatMap(item => item.triggers.map(t => (t.payload as { readonly projectId?: unknown } | undefined)?.projectId))
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    )
    const batchProjectId = batchProjectIds.size === 1 ? [...batchProjectIds][0] : undefined
    const portfolioLines = this.portfolioLinesFor(batchProjectId)
    const repoContextLines = this.workspaceRepoContextLines(batchProjectId)
    const promptBody = buildStewardBatchEvalPrompt({
      items: ['Items:', ...threadBlocks],
      decisions: ['Decision records (binding):', ...(recordLines.length > 0 ? recordLines : ['- none recorded'])],
      portfolio: portfolioLines,
      repoContext: repoContextLines,
      flows: flowLines.length > 0 ? ['Available flows:', ...flowLines] : ['Available flows: none (accepted tasks run single-step fallback)'],
    })
    const { text: promptText, promptId } = this.recordStewardPrompt('steward.batch-eval', promptBody)

    const recorded = new Map<string, {
      readonly decision: EvalDecision
      readonly route?: StewardRoutePick
    }>()
    try {
      this.note('eval-start', `batch (${prepared.length} threads)`, promptId)
      await this.runStewardTurn(
        'steward.batch-eval',
        agentCtx => {
          agentCtx.tools.register(this.triageBatchTool(prepared, recorded))
          agentCtx.tools.register(this.batchFallbackDecisionTool(prepared, recorded))
        },
        promptText,
      )
    } catch (error) {
      for (const item of prepared) {
        await abandonEval(store, item.evalId, 'failed')
      }
      throw error
    }

    if (recorded.size === 0) {
      for (const item of prepared) {
        await this.abandonInconclusive(item.threadId, item.evalId)
      }
      return
    }

    const missed: typeof prepared[number][] = []
    for (const item of prepared) {
      const outcome = recorded.get(item.evalId)
      if (outcome === undefined) {
        missed.push(item)
        continue
      }
      await this.settleEvalOutcome(
        item.threadId,
        item.evalId,
        item.triggers,
        item.acceptMode,
        outcome.decision,
        flows,
        outcome.route,
        promptId,
      )
    }
    for (const item of missed) {
      await this.runSingleEval(item.evalId, item.threadId, item.triggers, item.acceptMode)
    }
  }

  /**
   * Accept one candidate: the user confirms the eval's recorded acceptance,
   * so the ticket mints with a human-confirmed mandate. The confirmation is
   * itself recorded on the audit trail.
   */
  @Remote
  async acceptCandidate(rawInput: { readonly evalId: string }): Promise<void> {
    const input = acceptCandidateInputSchema.parse(rawInput)
    const store = this.ctx.dshManagerBoard.evalStore()
    const evalRecord = store.getEval(input.evalId)
    if (evalRecord === undefined) {
      throw new RemoteError('dshManager/eval-not-found', `eval ${input.evalId} does not exist`, { id: input.evalId })
    }
    if (evalRecord.status !== 'candidate') {
      throw new RemoteError('dshManager/eval-not-candidate', `eval ${input.evalId} is not a candidate (status ${evalRecord.status})`, { id: input.evalId })
    }
    // One decision per eval: the latest write wins.
    const decisions = [...this.domain!.table('decisions').entries()]
      .map(([, record]) => record)
      .filter(record => record.evalId === input.evalId)
      .sort((left, right) => right.decidedAt - left.decidedAt)
    const decision = decisions[0]
    if (decision === undefined || decision.action !== 'accept') {
      throw new RemoteError('dshManager/eval-not-candidate', `eval ${input.evalId} has no recorded acceptance to confirm`, { id: input.evalId })
    }
    // The user's confirmation upgrades the evidence to explicit and mints.
    const confirmed: EvalDecision = {
      action: 'accept',
      strength: 'explicit',
      ...(decision.title === undefined ? {} : { title: decision.title }),
      ...(decision.scope === undefined ? {} : { scope: decision.scope }),
      rationale: `${decision.rationale} (accepted by the user)`,
    }
    const record: DecisionRecord = {
      id: crypto.randomUUID(),
      evalId: input.evalId,
      threadId: decision.threadId,
      action: 'accept',
      strength: 'explicit',
      ...(decision.scope === undefined ? {} : { scope: decision.scope }),
      policyVersion: decision.policyVersion,
      rationale: confirmed.rationale,
      decidedAt: Date.now(),
    }
    await this.domain!.table('decisions').put(record.id as never, record)
    const threadConnection = this.ctx.dshManagerSources.listThreadFacts()
      .find(fact => fact.id === evalRecord.threadId)?.connectionId
    const firstTriggerId = evalRecord.triggerIds[0]
    const firstTrigger = firstTriggerId === undefined
      ? undefined
      : this.ctx.dshManagerSources.threadTriggers(evalRecord.threadId).find(trigger => trigger.id === firstTriggerId)
    const origin: TicketOrigin = {
      ...(firstTrigger === undefined ? {} : { externalKey: firstTrigger.externalKey, url: firstTrigger.url }),
      ...(threadConnection === undefined ? {} : { sourceConnectionId: threadConnection }),
    }
    await finishEval(store, input.evalId, confirmed, () => 'accept', 'auto', Date.now(), origin)
    const confirmedTicket = store.getEval(input.evalId)?.ticketId
    if (confirmedTicket !== undefined) await this.routeAndDispatch(confirmedTicket)
  }

  /** Route and dispatch a directly handed-off ticket, returning whether a pipeline flow was attached. */
  async routeDirectTicket(ticketId: string): Promise<boolean> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined) return false
    this.note('eval-decision', `direct · ${ticket.title}`)
    await this.routeAndDispatch(ticketId)
    return this.ctx.dshManagerBoard.ticketRecord(ticketId)?.flow !== undefined
  }

  /**
   * Route one accepted ticket onto a matching Flow IR chain, or immediately
   * fall back to generic single-step execution when no flow matches or none are enabled.
   */
  private async routeAndDispatch(ticketId: string): Promise<void> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined || ticket.flow !== undefined) return
    const flows = this.ctx.dshManagerFlow.list().filter(flow => flow.enabled)
    if (flows.length === 0) {
      this.note('eval-decision', `single-step fallback · ${ticketId}`)
      await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId })
      return
    }
    const { pick, promptId } = await this.driveRouteTurn(ticket, flows)
    await this.applyRoutePick(ticketId, flows, pick, promptId)
  }

  /** Apply a routing decision (inline from batch triage or dedicated route turn). */
  private async applyRoutePick(
    ticketId: string,
    flows: readonly FlowDef[],
    pick: StewardRoutePick | undefined,
    routePromptId?: string,
  ): Promise<void> {
    if (pick?.worktree !== undefined) {
      await this.ctx.dshManagerBoard.updateWorktreePlan(ticketId, pick.worktree)
    }
    if (pick === undefined || pick.none === true || pick.flowId === undefined) {
      // Single-step generic fallback when no configured flow matches.
      const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
      const waitingOn = ticket === undefined
        ? []
        : unresolvedDependencies(this.ctx.dshManagerBoard.ticketRecords(), ticket)
      if (waitingOn.length > 0) {
        this.note('eval-decision', `waiting (${waitingOn.length} dep) · single-step fallback · ${ticketId}`, routePromptId)
        return
      }
      this.note('eval-decision', `route → single-step fallback · ${ticketId}`, routePromptId)
      await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId })
      return
    }
    const flow = flows.find(entry => entry.id === pick.flowId)
    if (flow === undefined) {
      this.note('eval-failed', `flow ${pick.flowId} vanished · ${ticketId}`, routePromptId)
      return
    }
    if (flow.steps.length === 0) {
      this.note('eval-failed', `flow ${flow.name} is empty · ${ticketId}`, routePromptId)
      return
    }
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined) return
    if (flow.workspaceMode === 'in-place') {
      await this.ctx.dshManagerBoard.updateWorktreePlan(ticketId, { mode: 'in-place' })
    }
    await this.ctx.dshManagerBoard.annotateFlow(ticketId, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 0,
      stageCount: flow.steps.length,
    })
    if (pick.dependsOn !== undefined && pick.dependsOn.length > 0) {
      const existingIds = new Set(this.ctx.dshManagerBoard.ticketRecords().map(record => record.id))
      const validAdditions = pick.dependsOn.filter(id => id !== ticketId && existingIds.has(id))
      if (validAdditions.length > 0) {
        const mergedDeps = [...new Set([...(ticket.dependsOn ?? []), ...validAdditions])]
        try {
          await this.ctx.dshManagerBoard.setTicketDependencies({ ticketId, dependsOn: mergedDeps })
        } catch (error) {
          this.ctx.logger?.warn('steward route ignored invalid dependsOn for %s: %s', ticketId, String(error))
        }
      }
    }
    const annotatedTicket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    const waitingOn = annotatedTicket === undefined
      ? []
      : unresolvedDependencies(this.ctx.dshManagerBoard.ticketRecords(), annotatedTicket)
    if (waitingOn.length > 0) {
      this.note('eval-decision', `waiting (${waitingOn.length} dep) · ${flow.name} · ${ticketId}`, routePromptId)
      return
    }
    this.note('eval-decision', `route → ${flow.name} 1/${flow.steps.length} · ${ticketId}`, routePromptId)
    await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId })
  }

  /** Build compact same-project portfolio lines for Steward Eval / Route prompts. */
  private portfolioLinesFor(projectId?: string, excludeTicketIds?: readonly string[]): string[] {
    const snapshot = buildPortfolioSnapshot(this.ctx.dshManagerBoard.ticketRecords(), {
      ...(projectId === undefined ? {} : { projectId }),
      ...(excludeTicketIds === undefined ? {} : { excludeTicketIds }),
    })
    return formatPortfolioPromptLines(snapshot)
  }

  /** Build compact workspace & sub-repo git-flow hints so Steward plans target repoRoot & branches accurately. */
  private workspaceRepoContextLines(projectId?: string): string[] {
    const registry = (this.ctx as unknown as {
      get?: (name: string) => {
        get?: (id: WorkspaceId) => { readonly id: string; readonly title?: string; readonly path?: string } | undefined
        list?: () => readonly { readonly id: string; readonly title?: string; readonly path?: string }[]
      } | undefined
    }).get?.('workspaceRegistry')
    const workspaces = projectId !== undefined
      ? [registry?.get?.(projectId as WorkspaceId)].filter((w): w is { readonly id: string; readonly title?: string; readonly path?: string } => w !== undefined)
      : (registry?.list?.() ?? []).slice(0, 4)
    if (workspaces.length === 0) return []
    const lines: string[] = ['Mapped workspace & repository context (for worktree planning):']
    for (const ws of workspaces) {
      if (typeof ws.path !== 'string' || ws.path === '') continue
      lines.push(`- Workspace ${ws.title ?? ws.id} (${ws.path})`)
      const reposDir = join(ws.path, 'repos')
      if (!existsSync(reposDir)) continue
      try {
        const subdirs = readdirSync(reposDir, { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 8)
        for (const sub of subdirs) {
          const subPath = join(reposDir, sub.name)
          if (!existsSync(join(subPath, '.git'))) continue
          const flowPath = existsSync(join(subPath, 'docs', 'git-flow.md'))
            ? join(subPath, 'docs', 'git-flow.md')
            : existsSync(join(subPath, 'AGENTS.md')) ? join(subPath, 'AGENTS.md') : undefined
          let hint = ''
          if (flowPath !== undefined) {
            try {
              const snippet = readFileSync(flowPath, 'utf8').slice(0, 900).replace(/\s+/g, ' ')
              const targetsTest = /\btest\b/i.test(snippet) && /main/.test(snippet)
              if (targetsTest) hint = ' [doc hints: base=main, mergeTarget=test]'
            } catch {
              // Non-fatal; skip unreadable doc.
            }
          }
          lines.push(`  - sub-repo: ${subPath}${hint}`)
        }
      } catch {
        // Ignore unreadable repos directory.
      }
    }
    return lines.length === 1 ? [] : lines
  }

  /** Send one routing turn in an isolated session and wait for the recorded pick. */
  private async driveRouteTurn(
    ticket: TicketRecord,
    flows: readonly FlowDef[],
  ): Promise<{ readonly pick: StewardRoutePick | undefined; readonly promptId: string }> {
    let recordedPick: StewardRoutePick | undefined
    const flowLines = flows.map(flow =>
      `- flow ${flow.id} "${flow.name}" (${flow.steps.length} steps, workspace=${flow.workspaceMode}): ${flow.when}`,
    )
    const portfolioLines = this.portfolioLinesFor(ticket.projectId, [ticket.id])
    const repoContextLines = this.workspaceRepoContextLines(ticket.projectId)
    const promptBody = buildStewardRoutePrompt({
      ticket,
      portfolio: portfolioLines,
      repoContext: repoContextLines,
      flows: flowLines,
    })
    const { text: promptText, promptId } = this.recordStewardPrompt('steward.route', promptBody)
    await this.runStewardTurn(
      'steward.route',
      agentCtx => {
        agentCtx.tools.register(this.routeTool(pick => { recordedPick = pick }))
      },
      promptText,
    )
    return { pick: recordedPick, promptId }
  }

  /** Queue a flow walk for one ticket through the durable effects queue. */
  private async enqueueFlowAdvance(payload: { readonly ticketId: string; readonly resumeIndex?: number }): Promise<void> {
    await this.ctx.dshManagerEffects.enqueue(FLOW_ADVANCE_EFFECT_KIND, payload)
  }

  /**
   * Walk one ticket's Flow IR chain from its current step index to the next step,
   * or mint final acceptance once the last step completes.
   */
  async advanceFlow(payload: { readonly ticketId: string; readonly resumeIndex?: number }): Promise<void> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(payload.ticketId)
    if (ticket === undefined || ticket.flow === undefined || ticket.state === 'ended') return
    const flow = ticket.flow
    const flowTicket = ticket as TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> }
    const liveFlow = this.resolveLiveFlow(flow.pipelineId)
    if (liveFlow === undefined) {
      await this.mintFlowAcceptance(flowTicket)
      return
    }
    const flowName = liveFlow.name
    const index = payload.resumeIndex ?? flow.stageIndex + 1
    if (index >= liveFlow.steps.length) {
      await this.completePrecedingStages(ticket.id, flow.stageIndex)
      await this.mintFlowAcceptance(flowTicket, flowName)
      return
    }
    const existingStage = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)?.stages
      .find(stageTicket => stageTicket.flow.stageIndex === index)
    if (existingStage !== undefined) {
      await this.ctx.dshManagerBoard.reopenStageTicket(existingStage.id)
      await this.completePrecedingStages(existingStage.id, index)
      this.note('eval-start', `step ${index + 1}/${liveFlow.steps.length} (resume) · ${existingStage.id}`)
      await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: existingStage.id })
      return
    }
    const mintedId = await this.mintNextStage(flowTicket, index, [], flowName, liveFlow.steps.length)
    if (mintedId !== undefined) {
      await this.completePrecedingStages(mintedId, index)
    }
  }

  /**
   * Quietly mark earlier flow stages (stageIndex < `currentIndex`) as `ended`
   * once execution moves forward so handed-off stages no longer stay in `todo`.
   */
  private async completePrecedingStages(anchorTicketId: string, currentIndex: number): Promise<void> {
    const records = this.ctx.dshManagerBoard.ticketRecords()
    const chain = flowChain(records, anchorTicketId)
    if (chain === undefined) return
    const pendingAttentions = this.ctx.dshManagerBoard.pendingAttentionTicketIds()
    const runningTickets = this.ctx.dshManagerBoard.runningDispatchTicketIds()
    const now = Date.now()
    for (const stage of chain.stages) {
      if (stage.flow.stageIndex >= currentIndex) continue
      if (stage.state === 'ended') continue
      if (pendingAttentions.has(stage.id) || runningTickets.has(stage.id)) continue
      await this.ctx.dshManagerBoard.completeSupersededStage(stage.id, now)
    }
  }

  /** Resolve live Flow IR definition without throwing when removed mid-flight. */
  private resolveLiveFlow(flowId: string): FlowDef | undefined {
    try {
      return this.ctx.dshManagerFlow.require(flowId)
    } catch {
      return undefined
    }
  }

  /** The walk has no step left: the ticket that did the work asks for acceptance. */
  private async mintFlowAcceptance(
    ticket: TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> },
    liveFlowName?: string,
  ): Promise<void> {
    const flowName = liveFlowName ?? this.resolveLiveFlow(ticket.flow.pipelineId)?.name ?? ticket.flow.pipelineName
    const attention = await askAttention(this.attentionStore(), {
      ticketId: ticket.id,
      dispatchId: 'steward',
      kind: 'review',
      question: `acceptance requested for ticket ${ticket.id}: every step of "${flowName}" is done`,
    }, Date.now())
    await this.publish(attention)
    this.note('eval-decision', `flow done · ${ticket.id}`)
  }

  /** Mint and dispatch one step ticket under the walked ticket's mandate. */
  private async mintNextStage(
    parent: TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> },
    index: number,
    skipped: readonly { readonly stageIndex: number; readonly reason: string }[],
    flowName = parent.flow.pipelineName,
    stepCount = parent.flow.stageCount,
  ): Promise<string | undefined> {
    const minted = await this.ctx.dshManagerBoard.mintFollowUp({
      parentId: parent.id,
      title: `${parent.title} · ${flowName} ${index + 1}/${stepCount}`,
      scope: parent.mandate?.scope ?? '',
    }, Date.now())
    if (minted === undefined) {
      this.note('eval-failed', `step mint failed · ${parent.id}`)
      return undefined
    }
    await this.ctx.dshManagerBoard.annotateFlow(minted.id, {
      pipelineId: parent.flow.pipelineId,
      pipelineName: flowName,
      stageIndex: index,
      stageCount: stepCount,
      ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
    })
    this.note('eval-start', `step ${index + 1}/${stepCount} · ${minted.id}`)
    await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: minted.id })
    return minted.id
  }

  /**
   * Re-queue a retired eval: the user asks the steward to try its trigger
   * batch again. The batch re-enters the backlog and the next tick evaluates
   * it fresh; one more inconclusive run retires it again.
   */
  @Remote
  async evalRequeue(rawInput: { readonly evalId: string }): Promise<void> {
    const input = acceptCandidateInputSchema.parse(rawInput)
    const store = this.ctx.dshManagerBoard.evalStore()
    const evalRecord = store.getEval(input.evalId)
    if (evalRecord === undefined) {
      throw new RemoteError('dshManager/eval-not-found', `eval ${input.evalId} does not exist`, { id: input.evalId })
    }
    if (evalRecord.status !== 'failed' && evalRecord.status !== 'incomplete') {
      throw new RemoteError('dshManager/eval-not-requeueable', `eval ${input.evalId} is not re-queueable (status ${evalRecord.status})`, { id: input.evalId })
    }
    await requeueEval(store, input.evalId)
    this.note('eval-start', `requeued ${evalRecord.threadId}`)
  }

  /** Send one turn describing the batch in an isolated session and wait for the recorded decision. */
  private async driveTurn(
    evalId: string,
    threadId: string,
    triggers: readonly TriggerRecord[],
  ): Promise<{ readonly decision: EvalDecision | undefined; readonly promptId: string }> {
    let recordedDecision: EvalDecision | undefined
    const lines = triggers.map(trigger => {
      const detail = describePayload(trigger.payload)
      return `- [${trigger.externalKey}] ${trigger.url} (collected ${new Date(trigger.collectedAt).toISOString()}${detail === undefined ? '' : `; ${detail}`})`
    })
    // The decision records are binding eval input: an explicit rejection on
    // file decides the same kind of trigger without a fresh judgment call.
    const decisions = this.ctx.dshManagerPolicy.currentPolicy().decisions
    const recordLines = decisions.map(entry => `- [${entry.kind}] ${entry.statement}`)
    const payloadProject = (triggers[0]?.payload as { readonly projectId?: unknown } | undefined)?.projectId
    const portfolioLines = this.portfolioLinesFor(typeof payloadProject === 'string' && payloadProject !== '' ? payloadProject : undefined)
    const promptBody = buildStewardEvalPrompt({
      threadId,
      evalId,
      triggers: ['Triggers:', ...lines],
      decisions: ['Decision records (binding):', ...(recordLines.length > 0 ? recordLines : ['- none recorded'])],
      portfolio: portfolioLines,
    })
    const { text: promptText, promptId } = this.recordStewardPrompt('steward.eval', promptBody)
    await this.runStewardTurn(
      'steward.eval',
      agentCtx => {
        agentCtx.tools.register(this.decisionTool(evalId, threadId, decision => {
          recordedDecision = decision
        }))
      },
      promptText,
    )
    return { decision: recordedDecision, promptId }
  }

  /** Record the system's `incomplete` decision for a retired batch. */
  private async recordIncomplete(threadId: string, evalId: string, attempts: number): Promise<void> {
    const record: DecisionRecord = {
      id: crypto.randomUUID(),
      evalId,
      threadId,
      action: 'incomplete',
      strength: 'inferred',
      policyVersion: POLICY_VERSION,
      rationale: `the eval was abandoned after ${attempts} inconclusive runs`,
      decidedAt: Date.now(),
    }
    await this.domain!.table('decisions').put(record.id as never, record)
  }

  /**
   * Run one Steward turn in an isolated ephemeral session without `meta.cwd`
   * (so background automation does not clutter the workspace session tree),
   * disposing its handle unconditionally when the turn settles or times out.
   */
  private async runStewardTurn(
    kind: string,
    setup: (agentCtx: Context) => void,
    prompt: string,
  ): Promise<void> {
    const agentOptions = resolveAgentModelOptions(this.ctx, {
      ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
      ...(this.config.model === undefined ? {} : { model: this.config.model }),
    })
    const sessionId = `dsh-manager-steward-${kind}-${crypto.randomUUID().slice(0, 8)}` as SessionId
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions,
      setup: agentCtx => {
        agentCtx.tools.register(this.proposePolicyTool())
        setup(agentCtx)
      },
    })
    // The turn runs under a budget; an overrunning turn is cancelled and the
    // handle is disposed in `finally`.
    const timeoutMs = this.config.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS
    const timer = setTimeout(() => {
      handle.agent.cancel({ kind: 'hook', reason: `dsh-manager: ${kind} turn timed out` })
    }, timeoutMs)
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    } finally {
      clearTimeout(timer)
      await handle.dispose().catch(error => {
        this.ctx.logger?.warn('failed to dispose ephemeral steward session %s: %s', sessionId, String(error))
      })
    }
  }

  /** Normalize tool arguments into an `EvalDecision`. */
  private toEvalDecision(args: {
    readonly action: 'accept' | 'stop' | 'ignore'
    readonly strength: 'explicit' | 'inferred'
    readonly title?: string
    readonly scope?: string
    readonly supersededBy?: string
    readonly rationale: string
  }): EvalDecision {
    return {
      action: args.action,
      strength: args.strength,
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.scope === undefined ? {} : { scope: args.scope }),
      ...(args.supersededBy === undefined ? {} : { supersededBy: args.supersededBy }),
      rationale: args.rationale,
    }
  }

  /** Persist one Steward decision into the audit table. */
  private async recordEvalDecision(
    evalId: string,
    threadId: string,
    decision: EvalDecision,
  ): Promise<void> {
    const record: DecisionRecord = {
      id: crypto.randomUUID(),
      evalId,
      threadId,
      action: decision.action,
      strength: decision.strength,
      ...(decision.scope === undefined ? {} : { scope: decision.scope }),
      ...(decision.title === undefined ? {} : { title: decision.title }),
      ...(decision.supersededBy === undefined ? {} : { supersededBy: decision.supersededBy }),
      policyVersion: POLICY_VERSION,
      rationale: decision.rationale,
      decidedAt: Date.now(),
    }
    await this.domain!.table('decisions').put(record.id as never, record)
  }

  /** Combined Eval + Route batch tool mounted on multi-thread Steward triage turns. */
  private triageBatchTool(
    prepared: readonly { readonly evalId: string; readonly threadId: string }[],
    recorded: Map<string, {
      readonly decision: EvalDecision
      readonly route?: StewardRoutePick
    }>,
  ) {
    const self = this
    const byEvalId = new Map(prepared.map(item => [item.evalId, item]))
    return defineTool({
      name: 'record_triage_batch',
      description: 'Record Eval and optional inline Route decisions for multiple evaluated thread batches in one pass.',
      parameters: {
        items: {
          type: 'array',
          required: true,
          description: 'List of triage decisions keyed by evalId.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              evalId: { type: 'string', required: true, description: 'The evalId assigned to this thread item.' },
              action: { type: 'string', required: true, enum: ['accept', 'stop', 'ignore'], description: 'The decision verb.' },
              strength: { type: 'string', required: true, enum: ['explicit', 'inferred'], description: 'How explicitly the triggers support the action.' },
              title: { type: 'string', description: 'The ticket title when accepting.' },
              scope: { type: 'string', description: 'What the mandate covers when accepting.' },
              supersededBy: { type: 'string', description: 'Existing ticket ID that already covers/resolves this thread when ignoring.' },
              rationale: { type: 'string', required: true, description: 'The rationale kept verbatim in the audit trail.' },
              flowId: { type: 'string', description: 'Matched Flow ID when accepting and routing inline.' },
              ruleId: { type: 'string', description: 'Legacy alias for flowId.' },
              none: { type: 'boolean', description: 'True when accepting and no configured flow fits (runs single-step generic fallback).' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'Prerequisite ticket IDs when accepting and routing inline (omit to run in parallel).',
              },
              worktree: WORKTREE_PLAN_PARAM,
            },
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'number' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        let count = 0
        for (const rawEntry of args.items) {
          const entry = rawEntry as {
            readonly evalId?: unknown
            readonly action?: unknown
            readonly strength?: unknown
            readonly title?: unknown
            readonly scope?: unknown
            readonly supersededBy?: unknown
            readonly rationale?: unknown
            readonly flowId?: unknown
            readonly ruleId?: unknown
            readonly none?: unknown
            readonly dependsOn?: unknown
            readonly worktree?: unknown
          }
          if (typeof entry.evalId !== 'string') continue
          const target = byEvalId.get(entry.evalId)
          if (target === undefined) continue
          if (entry.action !== 'accept' && entry.action !== 'stop' && entry.action !== 'ignore') continue
          const strength = entry.strength === 'explicit' ? 'explicit' : 'inferred'
          const rationale = typeof entry.rationale === 'string' ? entry.rationale : ''
          const supersededBy = typeof entry.supersededBy === 'string' && entry.supersededBy.trim() !== ''
            ? entry.supersededBy.trim()
            : undefined
          const decision = self.toEvalDecision({
            action: entry.action,
            strength,
            ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
            ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
            ...(supersededBy === undefined ? {} : { supersededBy }),
            rationale,
          })
          const dependsOn = Array.isArray(entry.dependsOn)
            ? entry.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
            : undefined
          const worktree = normalizeWorktreePlan(entry.worktree)
          const pickedFlowId = typeof entry.flowId === 'string'
            ? entry.flowId
            : (typeof entry.ruleId === 'string' ? entry.ruleId : undefined)
          const route = (pickedFlowId !== undefined || entry.none === true || worktree !== undefined)
            ? {
                ...(pickedFlowId === undefined ? {} : { flowId: pickedFlowId }),
                ...(entry.none === true ? { none: true } : {}),
                ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}),
                ...(worktree === undefined ? {} : { worktree }),
                rationale,
              }
            : undefined
          recorded.set(target.evalId, route === undefined ? { decision } : { decision, route })
          count += 1
        }
        return { recorded: count }
      },
    })
  }

  /** Per-item fallback tool mounted alongside `record_triage_batch` for single-item tool calls. */
  private batchFallbackDecisionTool(
    prepared: readonly { readonly evalId: string; readonly threadId: string }[],
    recorded: Map<string, {
      readonly decision: EvalDecision
      readonly route?: StewardRoutePick
    }>,
  ) {
    const self = this
    const byEvalId = new Map(prepared.map(item => [item.evalId, item]))
    return defineTool({
      name: 'record_decision',
      description: 'Record the Steward decision for one evaluated evalId from the batch.',
      parameters: {
        action: { type: 'string', required: true, enum: ['accept', 'stop', 'ignore'], description: 'The decision verb.' },
        strength: { type: 'string', required: true, enum: ['explicit', 'inferred'], description: 'How explicitly the triggers support the action.' },
        title: { type: 'string', description: 'The ticket title when accepting.' },
        scope: { type: 'string', description: 'What the mandate covers when accepting.' },
        supersededBy: { type: 'string', description: 'Existing ticket ID that already covers/resolves this thread when ignoring.' },
        rationale: { type: 'string', required: true, description: 'The rationale, kept verbatim in the audit trail.' },
        evalId: { type: 'string', required: true, description: 'The eval id from the batch.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        const target = byEvalId.get(args.evalId)
        if (target === undefined) return { recorded: false }
        recorded.set(target.evalId, { decision: self.toEvalDecision(args) })
        return { recorded: true }
      },
    })
  }

  /** The one tool a single-thread eval turn mounts: recording decisions in memory for settlement. */
  private decisionTool(
    _evalId: string,
    _threadId: string,
    onRecorded: (decision: EvalDecision) => void,
  ) {
    const self = this
    return defineTool({
      name: 'record_decision',
      description: 'Record the Steward decision for the evaluated thread batch.',
      parameters: {
        action: { type: 'string', required: true, enum: ['accept', 'stop', 'ignore'], description: 'The decision verb.' },
        strength: { type: 'string', required: true, enum: ['explicit', 'inferred'], description: 'How explicitly the triggers support the action.' },
        title: { type: 'string', description: 'The ticket title when accepting.' },
        scope: { type: 'string', description: 'What the mandate covers when accepting.' },
        supersededBy: { type: 'string', description: 'Existing ticket ID that already covers/resolves this thread when ignoring.' },
        rationale: { type: 'string', required: true, description: 'The rationale, kept verbatim in the audit trail.' },
        evalId: { type: 'string', required: true, description: 'The eval id the turn was asked to decide.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        onRecorded(self.toEvalDecision(args))
        return { recorded: true }
      },
    })
  }

  /** The tool a routing turn mounts: picking the Flow IR workflow a ticket walks. */
  private routeTool(
    onRecorded: (pick: StewardRoutePick) => void,
  ) {
    return defineTool({
      name: 'record_route',
      description: 'Pick the Flow that best carries this ticket (and optionally record its worktree plan), or declare none fits.',
      parameters: {
        flowId: { type: 'string', description: 'The matched flow id; omit when none fits.' },
        ruleId: { type: 'string', description: 'Legacy alias for flowId.' },
        none: { type: 'boolean', description: 'True when no configured flow fits the ticket (runs single-step fallback).' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional prerequisite ticket IDs that must finish before this ticket dispatches (omit to run in parallel).',
        },
        worktree: WORKTREE_PLAN_PARAM,
        rationale: { type: 'string', required: true, description: 'Why this flow matches, or why fallback applies.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        const dependsOn = Array.isArray(args.dependsOn)
          ? args.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
          : undefined
        const worktree = normalizeWorktreePlan(args.worktree)
        const flowId = typeof args.flowId === 'string'
          ? args.flowId
          : (typeof args.ruleId === 'string' ? args.ruleId : undefined)
        onRecorded({
          ...(flowId === undefined ? {} : { flowId }),
          ...(args.none === true ? { none: true } : {}),
          ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}),
          ...(worktree === undefined ? {} : { worktree }),
          ...(typeof args.rationale === 'string' ? { rationale: args.rationale } : {}),
        })
        return { recorded: true }
      },
    })
  }

  /**
   * Review every finished dispatch whose result no review covers yet,
   * serially. A rework re-dispatches with the opinion as the executor's
   * input until the automatic budget (two per ticket) runs out, then the
   * decision goes to a human; a pass mints an acceptance Attention — only
   * the human's answer ends the ticket. The scheduler and the tests share
   * this path.
   */
  async reviewPending(): Promise<void> {
    if (this.reviewing) return
    this.reviewing = true
    try {
      for (const next of this.reviewBacklog()) {
        try {
          await this.reviewDispatch(next)
        } catch (error) {
          // A failed review turn (model unavailable, crashed turn) stays on
          // the backlog; the next pass retries it.
          this.ctx.logger?.error(error)
          break
        }
      }
    } finally {
      this.reviewing = false
    }
  }

  /** The ended `ready` dispatches no review covers and no pending acceptance holds. */
  private reviewBacklog(): readonly { readonly ticketId: string; readonly dispatchId: string }[] {
    const reviewed = new Set(this.ctx.dshManagerBoard.reviewStore().listReviews().map(review => review.dispatchId))
    const pendingAcceptances = new Set(this.attentionStore().listAttentions()
      .filter(record => record.status === 'pending' && record.kind === 'review')
      .map(record => record.ticketId))
    return this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .filter(record => record.state === 'ended' && record.outcome === 'ready')
      .filter(record => !reviewed.has(record.id))
      .filter(record => !pendingAcceptances.has(record.ticketId))
      .filter(record => {
        const ticket = this.ctx.dshManagerBoard.ticketRecord(record.ticketId)
        return ticket !== undefined && ticket.state !== 'ended'
      })
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(record => ({ ticketId: record.ticketId, dispatchId: record.id }))
  }

  /** Resolve the FlowStepDef behind `ticket`'s current flow position, if any. */
  private currentFlowStep(ticket: TicketRecord | undefined): { readonly flow: FlowDef; readonly step: FlowStepDef } | undefined {
    if (ticket?.flow === undefined) return undefined
    const flow = this.resolveLiveFlow(ticket.flow.pipelineId)
    const step = flow?.steps[ticket.flow.stageIndex]
    return flow !== undefined && step !== undefined ? { flow, step } : undefined
  }

  /** Resolve the ticket matching `step.onFail` inside `ticket`'s flow walk, if any. */
  private onFailTargetTicket(ticket: TicketRecord | undefined, step: FlowStepDef | undefined): TicketRecord | undefined {
    if (ticket?.flow === undefined || step?.onFail === undefined || step.onFail === 'self') return undefined
    const flow = this.resolveLiveFlow(ticket.flow.pipelineId)
    if (flow === undefined) return undefined
    const targetIndex = flow.steps.findIndex(entry => entry.id === step.onFail)
    if (targetIndex === -1) return undefined
    const chain = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)
    return chain?.stages.find(candidate => candidate.flow.stageIndex === targetIndex)
  }

  /**
   * Drive one review/gate turn for a finished dispatch (when the ticket has no flow
   * or the current step declares `onFail`), or deterministically advance steps without `onFail`.
   */
  private async reviewDispatch(entry: { readonly ticketId: string; readonly dispatchId: string }): Promise<void> {
    const dispatch = this.ctx.dshManagerBoard.dispatchStore().getDispatch(entry.dispatchId)
    if (dispatch === undefined) return
    const ticket = this.ctx.dshManagerBoard.ticketRecord(entry.ticketId)
    const flowCtx = this.currentFlowStep(ticket)
    const reviews = this.ctx.dshManagerBoard.reviewStore().listReviews()
    const priorReworks = autoReworkCount(reviews, entry.ticketId)
    const readyReport = [...dispatch.reports].reverse().find(report => report.kind === 'ready')

    // Steps without `onFail` advance deterministically without spending a Steward LLM turn.
    if (ticket?.flow !== undefined && flowCtx?.step.onFail === undefined) {
      await this.applyReview(entry, {
        verdict: 'pass',
        feedback: readyReport?.message ?? 'step completed',
      }, priorReworks)
      return
    }

    const lastRework = [...reviews]
      .filter(review => review.ticketId === entry.ticketId && review.verdict === 'rework')
      .sort((left, right) => right.decidedAt - left.decidedAt)[0]
    const reportLines = [
      readyReport === undefined ? undefined : `The executor's summary report:\n${readyReport.message}`,
      lastRework === undefined ? undefined : `The earlier rework opinion: ${lastRework.feedback}`,
    ].filter((line): line is string => line !== undefined)
    const promptBody = buildStewardGatePrompt({
      ...(ticket === undefined ? { ticket: { id: entry.ticketId, title: entry.ticketId, threadId: '', state: 'todo', createdAt: 0, updatedAt: 0 } } : { ticket }),
      dispatchId: entry.dispatchId,
      ...(flowCtx === undefined ? {} : { step: flowCtx.step }),
      reportLines,
    })
    const { text: promptText, promptId } = this.recordStewardPrompt('steward.review', promptBody)
    let verdict: { readonly verdict: ReviewVerdict; readonly feedback: string } | undefined
    let followup: { readonly parentTicketId: string; readonly title: string; readonly scope: string; readonly rationale: string } | undefined
    await this.runStewardTurn(
      'steward.review',
      agentCtx => {
        agentCtx.tools.register(this.reviewTool(recorded => { verdict = recorded }))
        agentCtx.tools.register(this.followUpTool(recorded => { followup = recorded }))
      },
      promptText,
    )
    if (verdict !== undefined) await this.applyReview(entry, verdict, priorReworks, promptId)
    if (followup !== undefined) await this.applyFollowup(followup, entry.dispatchId)
  }

  /** Record the verdict and take its path: confirm gate, advance step, targeted rework, or escalation. */
  private async applyReview(
    entry: { readonly ticketId: string; readonly dispatchId: string },
    verdict: { readonly verdict: ReviewVerdict; readonly feedback: string },
    priorReworks: number,
    reviewPromptId?: string,
  ): Promise<void> {
    const now = Date.now()
    await recordReview(this.ctx.dshManagerBoard.reviewStore(), {
      ticketId: entry.ticketId,
      dispatchId: entry.dispatchId,
      verdict: verdict.verdict,
      feedback: verdict.feedback,
    }, now)
    this.note('review', `${verdict.verdict} · ${entry.ticketId}`, reviewPromptId)
    const path = reviewPath(verdict.verdict, priorReworks)
    if (path === 'acceptance') {
      const ticket = this.ctx.dshManagerBoard.ticketRecord(entry.ticketId)
      const flowCtx = this.currentFlowStep(ticket)
      if (ticket?.flow !== undefined) {
        const liveStepCount = flowCtx?.flow.steps.length ?? ticket.flow.stageCount
        const hasMoreSteps = ticket.flow.stageIndex < liveStepCount - 1
        if (flowCtx?.step.humanConfirm === true && hasMoreSteps) {
          const attention = await askAttention(this.attentionStore(), {
            ticketId: entry.ticketId,
            dispatchId: entry.dispatchId,
            kind: 'review',
            question: `confirm step ${ticket.flow.stageIndex + 1}/${liveStepCount} ("${flowCtx.step.name}") of "${flowCtx.flow.name}" to proceed`,
            ...(verdict.feedback === '' ? {} : { details: verdict.feedback }),
          }, now)
          await this.publish(attention)
          return
        }
        if (hasMoreSteps) {
          await this.enqueueFlowAdvance({ ticketId: entry.ticketId })
          return
        }
      }
      const attention = await askAttention(this.attentionStore(), {
        ticketId: entry.ticketId,
        dispatchId: entry.dispatchId,
        kind: 'review',
        question: `acceptance requested for ticket ${entry.ticketId}: the Steward passed the result`,
        ...(verdict.feedback === '' ? {} : { details: verdict.feedback }),
      }, now)
      await this.publish(attention)
      return
    }
    if (path === 'auto-rework') {
      const reviewedTicket = this.ctx.dshManagerBoard.ticketRecord(entry.ticketId)
      const flowCtx = this.currentFlowStep(reviewedTicket)
      const targetStage = this.onFailTargetTicket(reviewedTicket, flowCtx?.step)
      if (targetStage !== undefined) {
        const lastTargetDispatch = [...this.ctx.dshManagerBoard.dispatchStore().listDispatches()]
          .filter(record => record.ticketId === targetStage.id)
          .sort((left, right) => right.createdAt - left.createdAt)[0]
        await recordReview(this.ctx.dshManagerBoard.reviewStore(), {
          ticketId: targetStage.id,
          dispatchId: lastTargetDispatch?.id ?? entry.dispatchId,
          verdict: 'rework',
          feedback: verdict.feedback,
        }, now)
        this.note('review', `return → ${targetStage.id}`)
        await this.ctx.dshManagerBoard.reopenStageTicket(targetStage.id, { reason: verdict.feedback, author: 'steward' })
        await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: targetStage.id })
        return
      }
      await this.ctx.dshManagerBoard.reopenStageTicket(entry.ticketId, { reason: verdict.feedback, author: 'steward' })
      await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: entry.ticketId })
      return
    }
    await settlePendingEscalationAttentions(this.attentionStore(), entry.ticketId, 'superseded by latest escalation', now)
    const attention = await askAttention(this.attentionStore(), {
      ticketId: entry.ticketId,
      dispatchId: entry.dispatchId,
      question: `the Steward reworked ticket ${entry.ticketId} ${MAX_AUTO_REWORKS} times and it still falls short; decide whether to accept it or rework it yourself`,
      ...(verdict.feedback === '' ? {} : { details: verdict.feedback }),
    }, now)
    await this.publish(attention)
  }

  /** Push one attention out through every notification outlet. */
  private async publish(attention: AttentionRecord): Promise<void> {
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
  }

  private attentionStore() {
    return this.ctx.dshManagerBoard.attentionStore()
  }

  /**
   * Land one proposed follow-up: an equal-or-narrower scope mints directly
   * under the inherited mandate; a widened scope mints a mandate-expansion
   * Approval carrying the proposal verbatim — approving it mints exactly
   * what was proposed.
   */
  private async applyFollowup(
    intent: { readonly parentTicketId: string; readonly title: string; readonly scope: string; readonly rationale: string },
    dispatchId: string,
  ): Promise<void> {
    const parent = this.ctx.dshManagerBoard.ticketRecord(intent.parentTicketId)
    if (parent === undefined || parent.mandate === undefined) {
      this.ctx.logger?.warn('the follow-up for %s was skipped: no ticket or mandate', intent.parentTicketId)
      return
    }
    const decision = inheritMandate(parent.mandate, intent.scope)
    if (decision.path === 'direct') {
      const minted = await this.ctx.dshManagerBoard.mintFollowUp({
        parentId: parent.id, title: intent.title, scope: intent.scope,
      }, Date.now())
      if (minted === undefined) this.ctx.logger?.warn('the follow-up for %s could not mint', parent.id)
      return
    }
    const now = Date.now()
    const attention = await askAttention(this.attentionStore(), {
      ticketId: parent.id,
      dispatchId,
      kind: 'approval',
      question: `the follow-up "${intent.title}" widens ticket ${parent.id}'s mandate (proposed: ${intent.scope}; current: ${parent.mandate.scope})`,
      details: intent.rationale,
      action: {
        category: 'mandate-expansion',
        tool: 'record_followup',
        payload: {
          parentTicketId: intent.parentTicketId,
          title: intent.title,
          scope: intent.scope,
          rationale: intent.rationale,
        },
      },
    }, now)
    await this.publish(attention)
  }

  /**
   * Suggest ending the live tickets whose Thread collected an ended external
   * object (a merged or closed MR, a resolved Jira issue). The mark is only
   * a suggestion: the session decides through the suggest_end tool, and only
   * the user's confirmation ends the ticket — ignoring keeps it open. A
   * ticket already holding a suggest-end attention is never re-asked, and a
   * handled trigger is not re-asked this process. The scheduler and the
   * tests share this path.
   */
  async runEndSuggestions(): Promise<void> {
    if (this.suggesting) return
    this.suggesting = true
    try {
      for (const candidate of this.endSuggestionCandidates()) {
        try {
          await this.driveEndSuggestion(candidate)
        } catch (error) {
          // A failed suggestion turn (model unavailable, crashed turn) stays
          // unhandled; the next pass retries it.
          this.ctx.logger?.error(error)
          break
        }
      }
    } finally {
      this.suggesting = false
    }
  }

  /** The live tickets whose Thread carries an end-state trigger not yet put to the session. */
  private endSuggestionCandidates(): readonly { readonly ticketId: string; readonly threadId: string; readonly trigger: TriggerRecord }[] {
    const suggested = new Set(this.attentionStore().listAttentions()
      .filter(record => record.kind === 'suggest-end')
      .map(record => record.ticketId))
    const candidates: { readonly ticketId: string; readonly threadId: string; readonly trigger: TriggerRecord }[] = []
    for (const ticket of this.ctx.dshManagerBoard.evalStore().listTickets()) {
      if (ticket.state === 'ended' || ticket.threadId === '' || suggested.has(ticket.id)) continue
      const trigger = this.ctx.dshManagerSources.threadTriggers(ticket.threadId)
        .find(record => externalObjectEnded(record.payload) && !this.handledEndTriggers.has(`${ticket.id}:${record.id}`))
      if (trigger !== undefined) candidates.push({ ticketId: ticket.id, threadId: ticket.threadId, trigger })
    }
    return candidates
  }

  /** Drive one end-suggestion turn for one candidate ticket in an isolated session. */
  private async driveEndSuggestion(candidate: { readonly ticketId: string; readonly threadId: string; readonly trigger: TriggerRecord }): Promise<void> {
    const promptBody = buildStewardEndSuggestionPrompt({
      ticketId: candidate.ticketId,
      triggerDetails: [
        `Trigger: [${candidate.trigger.externalKey}] ${describePayload(candidate.trigger.payload) ?? candidate.trigger.externalKey} — ${candidate.trigger.url}`,
      ],
    })
    const { text: promptText, promptId } = this.recordStewardPrompt('steward.end-suggestion', promptBody)
    this.note('eval-decision', `suggest-end · ${candidate.ticketId}`, promptId)
    await this.runStewardTurn(
      'steward.end-suggestion',
      agentCtx => {
        agentCtx.tools.register(this.suggestEndTool(candidate.ticketId))
        agentCtx.tools.register(this.keepOpenTool())
      },
      promptText,
    )
    this.handledEndTriggers.add(`${candidate.ticketId}:${candidate.trigger.id}`)
  }

  /** The tool an end-suggestion turn mounts for suggesting a ticket's close. */
  private suggestEndTool(authoritativeTicketId: string) {
    const self = this
    return defineTool({
      name: 'suggest_end',
      description: 'Suggest closing a live ticket because the external object behind it has ended; only the user\'s confirmation ends the ticket.',
      parameters: {
        ticketId: { type: 'string', required: true, description: 'The ticket to suggest closing.' },
        reason: { type: 'string', required: true, description: 'The external evidence that says the ticket is done.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { suggested: { type: 'boolean' }, attentionId: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `suggested: ${String(value.suggested)}` }],
      },
      async execute(args, _exec) {
        const ticketId = authoritativeTicketId !== '' ? authoritativeTicketId : args.ticketId
        const attention = await askAttention(self.attentionStore(), {
          ticketId,
          dispatchId: 'steward',
          kind: 'suggest-end',
          question: `the external object behind ticket ${ticketId} has ended; suggest closing it`,
          details: args.reason,
        }, Date.now())
        await self.publish(attention)
        return { suggested: true, attentionId: attention.id }
      },
    })
  }

  /** The tool an end-suggestion turn mounts for keeping a suggested ticket open. */
  private keepOpenTool() {
    return defineTool({
      name: 'keep_open',
      description: 'Keep a ticket open despite the external object behind it having ended; the user\'s attention is not needed.',
      parameters: {
        ticketId: { type: 'string', required: true, description: 'The ticket to keep open.' },
        reason: { type: 'string', required: true, description: 'Why the ticket still needs work.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { kept: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `kept open: ${String(value.kept)}` }],
      },
      async execute(_args, _exec) {
        return { kept: true }
      },
    })
  }

  /** The tool Steward turns mount for proposing a Policy change; the Steward cannot write Policy directly. */
  private proposePolicyTool() {
    const self = this
    return defineTool({
      name: 'propose_policy',
      description: 'Propose a Policy change for the user\'s confirmation: record a long-term preference or an explicit rejection, or relax an approval category. You cannot write the Policy directly — only this proposal path.',
      parameters: {
        change: { type: 'string', required: true, enum: ['add-preference', 'add-rejection', 'relax-approval'], description: 'The proposed change.' },
        statement: { type: 'string', required: true, description: 'The decision record\'s statement, or the approval category to relax.' },
        rationale: { type: 'string', required: true, description: 'Which exchange revealed this, so the user can judge the proposal.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { proposed: { type: 'boolean' }, attentionId: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `proposed: ${String(value.proposed)}` }],
      },
      async execute(args, _exec) {
        const attention = await askAttention(self.attentionStore(), {
          ticketId: '',
          dispatchId: 'steward',
          kind: 'policy',
          question: `policy change proposed: ${args.change} — ${args.statement}`,
          details: args.rationale,
          action: {
            category: 'policy-change',
            tool: 'propose_policy',
            payload: { change: args.change as PolicyProposalChange, statement: args.statement, rationale: args.rationale },
          },
        }, Date.now())
        await self.publish(attention)
        return { proposed: true, attentionId: attention.id }
      },
    })
  }

  /** The tool a review turn mounts for proposing follow-up tickets. */
  private followUpTool(
    onRecorded: (intent: { readonly parentTicketId: string; readonly title: string; readonly scope: string; readonly rationale: string }) => void,
  ) {
    return defineTool({
      name: 'record_followup',
      description: 'Propose a follow-up ticket on the reviewed thread; its mandate scope may only narrow the parent mandate.',
      parameters: {
        parentTicketId: { type: 'string', required: true, description: 'The ticket this follow-up follows up.' },
        title: { type: 'string', required: true, description: 'The follow-up ticket\'s title.' },
        scope: { type: 'string', required: true, description: 'The proposed mandate scope; it must stay inside the parent mandate\'s scope, or the user must approve the widening first.' },
        rationale: { type: 'string', required: true, description: 'Why this next step belongs on this thread.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        onRecorded({
          parentTicketId: args.parentTicketId,
          title: args.title,
          scope: args.scope,
          rationale: args.rationale,
        })
        return { recorded: true }
      },
    })
  }

  /** The tool a review turn mounts for recording verdicts on finished dispatches. */
  private reviewTool(
    onRecorded: (verdict: { readonly verdict: ReviewVerdict; readonly feedback: string }) => void,
  ) {
    return defineTool({
      name: 'record_review',
      description: 'Record the Steward review verdict for one finished dispatch.',
      parameters: {
        verdict: { type: 'string', required: true, enum: ['pass', 'rework'], description: 'The review verdict.' },
        feedback: { type: 'string', required: true, description: 'The rework opinion when reworking; a short acceptance summary when passing.' },
        dispatchId: { type: 'string', required: true, description: 'The dispatch id the turn was asked to review.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        onRecorded({ verdict: args.verdict as ReviewVerdict, feedback: args.feedback })
        return { recorded: true }
      },
    })
  }
}
