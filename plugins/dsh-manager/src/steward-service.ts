/**
 * The Steward: coordinates batched Thread Evals, pipeline routing, skip
 * decisions, Dispatch Reviews, and end suggestions through
 * short-lived isolated DSH Sessions (without `meta.cwd` so background turns do
 * not clutter the Web workspace session tree). Every decision is recorded
 * durably in storage-domain.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveAgentModelOptions } from './agent-model-options.ts'
import type { EvalRecord, TicketRecord } from './board-domain.ts'
import { POLICY_VERSION, abandonEval, finishEval, pendingBacklog, requeueEval, startEval, type AcceptMode, type EvalDecision, type TicketOrigin } from './evals/eval-core.ts'
import {
  acceptCandidateInputSchema,
  evalListInputSchema,
  type CandidateView, type DecisionAction, type DecisionView, type EvalListInput, type EvalRecordView, type EvalTriggerView,
  type StewardStatusView,
} from './evals/wire-types.ts'
import { decisionsDomain, type DecisionRecord } from './decisions/decisions-domain.ts'
import { askAttention, settlePendingEscalationAttentions, type AttentionRecord } from './attention/attention-core.ts'
import type { PolicyProposalChange } from './policy/policy-core.ts'
import { inheritMandate } from './mandate/mandate-core.ts'
import { MAX_AUTO_REWORKS, autoReworkCount, recordReview, reviewPath, type ReviewVerdict } from './review/review-core.ts'
import { externalObjectEnded } from './triggers/trigger-core.ts'
import type { TriggerRecord } from './triggers/triggers-domain.ts'
import type { PipelineStage } from './pipeline/pipeline-core.ts'
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
  /** Host services the Steward reads; notifications publish attentions, the executor re-dispatches rework, the policy feeds eval input. */
  static inject = ['storageDomain', 'agents', 'dshManagerBoard', 'dshManagerSources', 'dshManagerNotifications', 'dshManagerExecutor', 'dshManagerPolicy', 'dshManagerConnections', 'dshManagerEffects', 'dshManagerRoute', 'dshManagerPipeline', 'dshManagerCrew']

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
  private note(kind: StewardStatusView['activity'][number]['kind'], text: string): void {
    this.activity = [...this.activity.slice(-49), { at: Date.now(), kind, text }]
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
    rules: readonly { readonly id: string; readonly condition: string; readonly pipelineId: string }[],
    inlineRoute?: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] },
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
    this.note('eval-decision', `${decision.action}${noteSuffix}`)
    const outcomeTicket = store.getEval(evalId)?.ticketId
    if (decision.action !== 'accept' || outcomeTicket === undefined) return
    if (inlineRoute !== undefined && (inlineRoute.none === true || inlineRoute.ruleId !== undefined)) {
      await this.applyRoutePick(outcomeTicket, rules, inlineRoute)
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
    let decision: EvalDecision | undefined
    try {
      this.note('eval-start', `${triggers[0]?.externalKey ?? threadId} (+${triggers.length})`)
      decision = await this.driveTurn(evalId, threadId, triggers)
    } catch (error) {
      await abandonEval(store, evalId, 'failed')
      throw error
    }
    if (decision === undefined) {
      await this.abandonInconclusive(threadId, evalId)
      return
    }
    const rules = this.ctx.dshManagerRoute.list().filter(rule => rule.enabled)
    await this.settleEvalOutcome(threadId, evalId, triggers, acceptMode, decision, rules)
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
    const rules = this.ctx.dshManagerRoute.list().filter(rule => rule.enabled)
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
    const ruleLines = rules.map(rule => {
      const pipeline = this.ctx.dshManagerPipeline.require(rule.pipelineId)
      return `- rule ${rule.id} → pipeline "${pipeline.name}" (${pipeline.stages.length} stages): ${rule.condition}`
    })
    const batchProjectIds = new Set(
      prepared.flatMap(item => item.triggers.map(t => (t.payload as { readonly projectId?: unknown } | undefined)?.projectId))
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    )
    const portfolioLines = this.portfolioLinesFor(batchProjectIds.size === 1 ? [...batchProjectIds][0] : undefined)
    const prompt = [
      `Batch-triage ${prepared.length} pending threads (Evaluate and route each item in one pass).`,
      'Items:',
      ...threadBlocks,
      'Decision records (binding):',
      ...(recordLines.length > 0 ? recordLines : ['- none recorded']),
      ...portfolioLines,
      'Dedup / Subsumption rule: If an incoming thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, pass action="ignore" with supersededBy="<ticketId>" and explain why in rationale.',
      'Parallel vs Sequencing rule: When accepting and routing inline onto a pipeline, pass dependsOn=["<ticketId>"] ONLY if it touches the same module/files or must land after an active ticket; otherwise omit dependsOn so independent work runs in parallel.',
      ...(ruleLines.length > 0 ? ['Configured route rules:', ...ruleLines] : ['Configured route rules: none']),
      'Submit every decision through record_triage_batch (passing each evalId, action, strength, title, scope, rationale, optional supersededBy when ignoring, and when accepting with rules configured also ruleId or none: true plus optional dependsOn). You may alternatively call record_decision for individual evalIds.',
    ].join('\n')

    const recorded = new Map<string, {
      readonly decision: EvalDecision
      readonly route?: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] }
    }>()
    try {
      this.note('eval-start', `batch (${prepared.length} threads)`)
      await this.runStewardTurn(
        'batch-eval',
        agentCtx => {
          agentCtx.tools.register(this.triageBatchTool(prepared, recorded))
          agentCtx.tools.register(this.batchFallbackDecisionTool(prepared, recorded))
        },
        prompt,
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
        rules,
        outcome.route,
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
   * Route one accepted ticket and start its first stage. No enabled rules
   * keeps the pre-pipeline behavior (the ticket waits for the human's own
   * dispatch path). A pick dispatches stage 1; `none` asks the human with a
   * suggestion to add a rule — the ticket waits on the board.
   */
  private async routeAndDispatch(ticketId: string): Promise<void> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined || ticket.flow !== undefined) return
    const rules = this.ctx.dshManagerRoute.list().filter(rule => rule.enabled)
    if (rules.length === 0) return
    const pick = await this.driveRouteTurn(ticket, rules)
    await this.applyRoutePick(ticketId, rules, pick)
  }

  /** Apply a routing decision (inline from batch triage or dedicated route turn). */
  private async applyRoutePick(
    ticketId: string,
    rules: readonly { readonly id: string; readonly condition: string; readonly pipelineId: string }[],
    pick: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] } | undefined,
  ): Promise<void> {
    if (pick === undefined || (pick.none !== true && pick.ruleId === undefined)) {
      // An inconclusive routing turn leaves the ticket on the board; the
      // next tick does not re-route (the ticket is no longer in the backlog).
      this.note('eval-failed', `route inconclusive · ${ticketId}`)
      return
    }
    if (pick.none === true) {
      const attention = await askAttention(this.attentionStore(), {
        ticketId,
        dispatchId: 'steward',
        question: `no configured route fits ticket ${ticketId} ("${this.ctx.dshManagerBoard.ticketRecord(ticketId)?.title ?? ticketId}"); confirm single dispatch, or add a route rule and re-route`,
        ...(pick.rationale === undefined ? {} : { details: pick.rationale }),
      }, Date.now())
      await this.publish(attention)
      this.note('eval-decision', `route → human · ${ticketId}`)
      return
    }
    const rule = rules.find(entry => entry.id === pick.ruleId)
    if (rule === undefined) {
      this.note('eval-failed', `route rule ${pick.ruleId} vanished · ${ticketId}`)
      return
    }
    const pipeline = this.ctx.dshManagerPipeline.require(rule.pipelineId)
    if (pipeline.stages.length === 0) {
      this.note('eval-failed', `pipeline ${pipeline.name} is empty · ${ticketId}`)
      return
    }
    const ticket = this.ctx.dshManagerBoard.ticketRecord(ticketId)
    if (ticket === undefined) return
    const alreadyAligned = ticket.acceptanceCriteria !== undefined && ticket.acceptanceCriteria.trim() !== ''
    const skipped: { readonly stageIndex: number; readonly reason: string }[] = []
    let startIndex = 0
    while (startIndex < pipeline.stages.length) {
      const stage = pipeline.stages[startIndex]!
      if (!stage.skippable) break
      const skipPick = await this.driveSkipTurn(ticket, stage, startIndex)
      if (skipPick?.skip !== true) break
      if (alreadyAligned) {
        skipped.push({ stageIndex: startIndex, reason: skipPick.rationale })
        startIndex += 1
        continue
      }
      await this.ctx.dshManagerBoard.annotateFlow(ticketId, {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        stageIndex: startIndex,
        stageCount: pipeline.stages.length,
        ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
        pendingSkip: { stageIndex: startIndex, reason: skipPick.rationale },
      })
      const attention = await askAttention(this.attentionStore(), {
        ticketId,
        dispatchId: 'steward',
        question: `[skip] skip stage ${startIndex + 1}/${pipeline.stages.length} of "${pipeline.name}" for ticket ${ticketId}?`,
        ...(skipPick.rationale === '' ? {} : { details: skipPick.rationale }),
      }, Date.now())
      await this.publish(attention)
      this.note('eval-decision', `skip proposed · stage ${startIndex + 1} · ${ticketId}`)
      return
    }
    if (startIndex >= pipeline.stages.length) {
      await this.ctx.dshManagerBoard.annotateFlow(ticketId, {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        stageIndex: pipeline.stages.length - 1,
        stageCount: pipeline.stages.length,
        ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
      })
      const annotated = this.ctx.dshManagerBoard.ticketRecord(ticketId) as (TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> }) | undefined
      if (annotated !== undefined) await this.mintFlowAcceptance(annotated, pipeline.name)
      return
    }
    await this.ctx.dshManagerBoard.annotateFlow(ticketId, {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      stageIndex: startIndex,
      stageCount: pipeline.stages.length,
      ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
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
      this.note('eval-decision', `waiting (${waitingOn.length} dep) · ${pipeline.name} · ${ticketId}`)
      return
    }
    this.note('eval-decision', `route → ${pipeline.name} ${startIndex + 1}/${pipeline.stages.length} · ${ticketId}`)
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

  /** Send one routing turn in an isolated session and wait for the recorded pick. */
  private async driveRouteTurn(
    ticket: TicketRecord,
    rules: readonly { readonly id: string; readonly condition: string; readonly pipelineId: string }[],
  ): Promise<{ readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] } | undefined> {
    let recordedPick: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] } | undefined
    const lines = rules.map(rule => {
      const pipeline = this.ctx.dshManagerPipeline.require(rule.pipelineId)
      return `- rule ${rule.id} → pipeline "${pipeline.name}" (${pipeline.stages.length} stages): ${rule.condition}`
    })
    const portfolioLines = this.portfolioLinesFor(ticket.projectId, [ticket.id])
    const prompt = [
      `Route the accepted ticket ${ticket.id}: "${ticket.title}".`,
      ticket.mandate === undefined ? undefined : `Its mandate covers ${ticket.mandate.scope}.`,
      ...portfolioLines,
      'Sequencing rule: If this ticket modifies the same module/files or clearly depends on an active ticket above, pass its ticket id(s) in dependsOn on record_route; otherwise leave dependsOn empty so independent work runs in parallel.',
      'The configured route rules are:',
      ...lines,
      'Pick the rule whose pipeline best carries this ticket through the record_route tool (pass its ruleId), or declare none fits (pass none: true) — an unmatched ticket waits for a human judgment.',
    ].filter(line => line !== undefined).join('\n')
    await this.runStewardTurn(
      'route',
      agentCtx => {
        agentCtx.tools.register(this.routeTool(pick => { recordedPick = pick }))
      },
      prompt,
    )
    return recordedPick
  }

  /** Queue a flow walk for one ticket through the durable effects queue. */
  private async enqueueFlowAdvance(payload: { readonly ticketId: string; readonly resumeIndex?: number; readonly skipped?: readonly { readonly stageIndex: number; readonly reason: string }[]; readonly skipDecision?: 'approved' | 'rejected' }): Promise<void> {
    await this.ctx.dshManagerEffects.enqueue(FLOW_ADVANCE_EFFECT_KIND, payload)
  }

  /**
   * Walk one ticket's pipeline from its stage index onward: mint and dispatch
   * the next stage to run, ask the human about each skip the steward wants,
   * and mint the acceptance once no stage is left. The scheduler, the
   * answered skip attention, and the effects delivery share this path.
   */
  async advanceFlow(payload: { readonly ticketId: string; readonly resumeIndex?: number; readonly skipped?: readonly { readonly stageIndex: number; readonly reason: string }[]; readonly skipDecision?: 'approved' | 'rejected' }): Promise<void> {
    const ticket = this.ctx.dshManagerBoard.ticketRecord(payload.ticketId)
    if (ticket === undefined || ticket.flow === undefined || ticket.state === 'ended') return
    const flow = ticket.flow
    const flowTicket = ticket as TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> }
    let pipeline
    try {
      pipeline = this.ctx.dshManagerPipeline.require(flow.pipelineId)
    } catch {
      // The pipeline template vanished mid-flight: the walk degrades to the
      // plain acceptance of the ticket the work landed on.
      await this.mintFlowAcceptance(flowTicket)
      return
    }
    const livePipeline = this.resolveLivePipeline(flow.pipelineId)
    const pipelineName = livePipeline?.name ?? flow.pipelineName
    const stageCount = livePipeline?.stages.length ?? flow.stageCount
    // The resume state from an answered skip decision, or the walk start.
    const skipped = [...(payload.skipped ?? flow.skipped ?? [])]
    let index = payload.resumeIndex ?? flow.stageIndex + 1
    // A rejected skip runs the stage it was proposed for; an approved one
    // resumes after it. Either way the pendingSkip marker clears.
    if (payload.skipDecision !== undefined && flow.pendingSkip !== undefined) {
      if (payload.skipDecision === 'approved') {
        skipped.push({ stageIndex: flow.pendingSkip.stageIndex, reason: flow.pendingSkip.reason })
        index = flow.pendingSkip.stageIndex + 1
      } else {
        index = flow.pendingSkip.stageIndex
      }
      await this.ctx.dshManagerBoard.replaceFlow(ticket.id, {
        pipelineId: flow.pipelineId,
        pipelineName,
        stageIndex: flow.stageIndex,
        stageCount: Math.max(stageCount, flow.stageIndex + 1),
        ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
      })
    }
    // A rejected skip is the human's "run this stage": the walk proceeds
    // without re-proposing the skip the human just declined.
    if (payload.skipDecision !== 'rejected') {
      while (index < pipeline.stages.length) {
        const stage = pipeline.stages[index]!
        if (stage.skippable) {
          const pick = await this.driveSkipTurn(ticket, stage, index)
          if (pick?.skip === true) {
            // The skip waits for the human: the pending state lands on the
            // ticket, the attention asks with the rationale, and the walk
            // resumes through the effects queue once answered.
            await this.ctx.dshManagerBoard.replaceFlow(ticket.id, {
              pipelineId: flow.pipelineId,
              pipelineName,
              stageIndex: flow.stageIndex,
              stageCount: Math.max(stageCount, flow.stageIndex + 1),
              ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
              pendingSkip: { stageIndex: index, reason: pick.rationale },
            })
            const attention = await askAttention(this.attentionStore(), {
              ticketId: ticket.id,
              dispatchId: 'steward',
              question: `[skip] skip stage ${index + 1}/${pipeline.stages.length} of "${pipelineName}" for ticket ${ticket.id}?`,
              ...(pick.rationale === '' ? {} : { details: pick.rationale }),
            }, Date.now())
            await this.publish(attention)
            this.note('eval-decision', `skip proposed · stage ${index + 1} · ${ticket.id}`)
            return
          }
        }
        break
      }
    }
    // No (more) skippable stage ahead: run the stage at `index`, or accept
    // when the walk has passed the last one.
    if (index >= pipeline.stages.length) {
      await this.completePrecedingStages(ticket.id, flow.stageIndex)
      await this.mintFlowAcceptance(flowTicket, pipelineName)
      return
    }
    const existingStage = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)?.stages
      .find(stageTicket => stageTicket.flow.stageIndex === index)
    if (existingStage !== undefined) {
      await this.ctx.dshManagerBoard.reopenStageTicket(existingStage.id)
      await this.completePrecedingStages(existingStage.id, index)
      this.note('eval-start', `stage ${index + 1}/${pipeline.stages.length} (resume) · ${existingStage.id}`)
      await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: existingStage.id })
      return
    }
    const mintedId = await this.mintNextStage(flowTicket, index, [...skipped], pipelineName, pipeline.stages.length)
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

  /** Resolve live pipeline template without throwing when removed mid-flight. */
  private resolveLivePipeline(pipelineId: string) {
    try {
      return this.ctx.dshManagerPipeline.require(pipelineId)
    } catch {
      return undefined
    }
  }

  /** The walk has no stage left: the ticket that did the work asks for acceptance. */
  private async mintFlowAcceptance(
    ticket: TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> },
    livePipelineName?: string,
  ): Promise<void> {
    const pipelineName = livePipelineName ?? this.resolveLivePipeline(ticket.flow.pipelineId)?.name ?? ticket.flow.pipelineName
    const attention = await askAttention(this.attentionStore(), {
      ticketId: ticket.id,
      dispatchId: 'steward',
      kind: 'review',
      question: `acceptance requested for ticket ${ticket.id}: every stage of "${pipelineName}" is done`,
      ...(ticket.flow.skipped === undefined || ticket.flow.skipped.length === 0 ? {} : {
        details: `skipped stages: ${ticket.flow.skipped.map(entry => `${entry.stageIndex + 1} (${entry.reason})`).join('; ')}`,
      }),
    }, Date.now())
    await this.publish(attention)
    this.note('eval-decision', `flow done · ${ticket.id}`)
  }

  /** Mint and dispatch one stage ticket under the walked ticket's mandate. */
  private async mintNextStage(
    parent: TicketRecord & { readonly flow: NonNullable<TicketRecord['flow']> },
    index: number,
    skipped: readonly { readonly stageIndex: number; readonly reason: string }[],
    pipelineName = parent.flow.pipelineName,
    stageCount = parent.flow.stageCount,
  ): Promise<string | undefined> {
    const minted = await this.ctx.dshManagerBoard.mintFollowUp({
      parentId: parent.id,
      title: `${parent.title} · ${pipelineName} ${index + 1}/${stageCount}`,
      scope: parent.mandate?.scope ?? '',
    }, Date.now())
    if (minted === undefined) {
      this.note('eval-failed', `stage mint failed · ${parent.id}`)
      return undefined
    }
    await this.ctx.dshManagerBoard.annotateFlow(minted.id, {
      pipelineId: parent.flow.pipelineId,
      pipelineName,
      stageIndex: index,
      stageCount,
      ...(skipped.length > 0 ? { skipped: [...skipped] } : {}),
    })
    this.note('eval-start', `stage ${index + 1}/${stageCount} · ${minted.id}`)
    await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: minted.id })
    return minted.id
  }

  /** Send one skip-decision turn in an isolated session and wait for the recorded pick. */
  private async driveSkipTurn(
    ticket: TicketRecord,
    stage: PipelineStage,
    index: number,
  ): Promise<{ readonly skip: boolean; readonly rationale: string } | undefined> {
    let recordedPick: { readonly skip: boolean; readonly rationale: string } | undefined
    const member = (() => {
      try {
        return this.ctx.dshManagerCrew.require(stage.memberId)
      } catch {
        return undefined
      }
    })()
    const prompt = [
      `Decide whether pipeline stage ${index + 1} can be skipped for ticket ${ticket.id}: "${ticket.title}".`,
      ticket.mandate === undefined ? undefined : `Mandate scope: ${ticket.mandate.scope}`,
      ticket.acceptanceCriteria === undefined || ticket.acceptanceCriteria === ''
        ? undefined
        : `Agreed acceptance criteria (already aligned with the user): ${ticket.acceptanceCriteria}`,
      ticket.handoffSessionId === undefined ? undefined : `Originates from aligned discussion session: ${ticket.handoffSessionId}`,
      member === undefined ? undefined : `The stage's member: ${member.name} (${member.role}).`,
      stage.skipLogic === undefined || stage.skipLogic === ''
        ? 'The stage is marked skippable but carries no skip logic; skip it only when the mandate clearly does not need it.'
        : `The stage's skip logic: ${stage.skipLogic}`,
      'Decide through the decide_skip tool.',
    ].filter(line => line !== undefined).join('\n')
    await this.runStewardTurn(
      'skip',
      agentCtx => {
        agentCtx.tools.register(this.skipTool(pick => { recordedPick = pick }))
      },
      prompt,
    )
    return recordedPick
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
  ): Promise<EvalDecision | undefined> {
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
    const prompt = [
      `Evaluate the pending changes of thread ${threadId} (eval ${evalId}).`,
      'Triggers:',
      ...lines,
      'Decision records (binding):',
      ...(recordLines.length > 0 ? recordLines : ['- none recorded']),
      ...portfolioLines,
      'Dedup / Subsumption rule: If this thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, call record_decision with action="ignore" and supersededBy="<ticketId>".',
      'Decide through the record_decision tool: accept the work explicitly supported by the triggers, or ignore or stop it.',
    ].join('\n')
    await this.runStewardTurn(
      'eval',
      agentCtx => {
        agentCtx.tools.register(this.decisionTool(evalId, threadId, decision => {
          recordedDecision = decision
        }))
      },
      prompt,
    )
    return recordedDecision
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
      readonly route?: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] }
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
              ruleId: { type: 'string', description: 'Matched route ruleId when accepting and routing inline.' },
              none: { type: 'boolean', description: 'True when accepting with configured rules and no rule fits.' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'Prerequisite ticket IDs when accepting and routing inline (omit to run in parallel).',
              },
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
            readonly ruleId?: unknown
            readonly none?: unknown
            readonly dependsOn?: unknown
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
          const route = (typeof entry.ruleId === 'string' || entry.none === true)
            ? {
                ...(typeof entry.ruleId === 'string' ? { ruleId: entry.ruleId } : {}),
                ...(entry.none === true ? { none: true } : {}),
                ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}),
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
      readonly route?: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] }
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

  /** The tool a routing turn mounts: picking the pipeline a ticket walks. */
  private routeTool(
    onRecorded: (pick: { readonly ruleId?: string; readonly none?: boolean; readonly rationale?: string; readonly dependsOn?: readonly string[] }) => void,
  ) {
    return defineTool({
      name: 'record_route',
      description: 'Pick the route rule whose pipeline should carry this ticket, or declare none fits.',
      parameters: {
        ruleId: { type: 'string', description: 'The matched route rule\'s id; omit when none fits.' },
        none: { type: 'boolean', description: 'True when no configured rule fits the ticket.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional prerequisite ticket IDs that must finish before this ticket dispatches (omit to run in parallel).',
        },
        rationale: { type: 'string', required: true, description: 'Why this rule matches, or what is missing from the rules.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        const dependsOn = Array.isArray(args.dependsOn)
          ? args.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
          : undefined
        onRecorded({
          ...(typeof args.ruleId === 'string' ? { ruleId: args.ruleId } : {}),
          ...(args.none === true ? { none: true } : {}),
          ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}),
          ...(typeof args.rationale === 'string' ? { rationale: args.rationale } : {}),
        })
        return { recorded: true }
      },
    })
  }

  /** The tool a skip turn mounts: whether a skippable stage may pass. */
  private skipTool(
    onRecorded: (pick: { readonly skip: boolean; readonly rationale: string }) => void,
  ) {
    return defineTool({
      name: 'decide_skip',
      description: 'Decide whether a skippable pipeline stage can be skipped for this ticket.',
      parameters: {
        skip: { type: 'boolean', required: true, description: 'True when the stage can be skipped.' },
        rationale: { type: 'string', required: true, description: 'Why the stage is skipped or needed.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: `recorded: ${String(value.recorded)}` }],
      },
      async execute(args, _exec) {
        onRecorded({ skip: args.skip === true, rationale: typeof args.rationale === 'string' ? args.rationale : '' })
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

  /** Whether `ticket` sits on a pipeline stage configured with `mode: 'review'`. */
  private isReviewStageTicket(ticket: TicketRecord | undefined): boolean {
    if (ticket?.flow === undefined) return false
    const stage = this.resolveLivePipeline(ticket.flow.pipelineId)?.stages[ticket.flow.stageIndex]
    return stage?.mode === 'review'
  }

  /** Find the closest preceding non-review stage ticket in `ticket`'s flow walk. */
  private previousExecutionStage(ticket: TicketRecord | undefined): TicketRecord | undefined {
    if (ticket?.flow === undefined) return undefined
    const chain = flowChain(this.ctx.dshManagerBoard.ticketRecords(), ticket.id)
    if (chain === undefined) return undefined
    const pipeline = this.resolveLivePipeline(ticket.flow.pipelineId)
    const currentPos = chain.stages.findIndex(entry => entry.id === ticket.id)
    const before = currentPos === -1 ? chain.stages : chain.stages.slice(0, currentPos)
    return [...before]
      .reverse()
      .find(candidate => pipeline?.stages[candidate.flow.stageIndex]?.mode !== 'review')
  }

  /** Drive one review turn for one finished dispatch in an isolated session, then act on the verdict. */
  private async reviewDispatch(entry: { readonly ticketId: string; readonly dispatchId: string }): Promise<void> {
    const dispatch = this.ctx.dshManagerBoard.dispatchStore().getDispatch(entry.dispatchId)
    if (dispatch === undefined) return
    const ticket = this.ctx.dshManagerBoard.ticketRecord(entry.ticketId)
    const isReviewStage = this.isReviewStageTicket(ticket)
    const liveStageCount = ticket?.flow === undefined
      ? 1
      : (this.resolveLivePipeline(ticket.flow.pipelineId)?.stages.length ?? ticket.flow.stageCount)
    const reviews = this.ctx.dshManagerBoard.reviewStore().listReviews()
    const priorReworks = autoReworkCount(reviews, entry.ticketId)
    const readyReport = [...dispatch.reports].reverse().find(report => report.kind === 'ready')

    // Intermediate execution stages (`mode !== 'review'`) hand off directly to
    // the next pipeline stage once ready, leaving quality gating to actual
    // tests + the dedicated Review stage rather than subjective Steward scoring.
    if (ticket?.flow !== undefined && !isReviewStage && ticket.flow.stageIndex < liveStageCount - 1) {
      await this.applyReview(entry, {
        verdict: 'pass',
        feedback: readyReport?.message ?? 'stage completed',
      }, priorReworks)
      return
    }

    const lastRework = [...reviews]
      .filter(review => review.ticketId === entry.ticketId && review.verdict === 'rework')
      .sort((left, right) => right.decidedAt - left.decidedAt)[0]
    const prompt = [
      `Review the finished work on ticket ${entry.ticketId} (dispatch ${entry.dispatchId}).`,
      readyReport === undefined ? undefined : `The executor's summary report:\n${readyReport.message}`,
      lastRework === undefined ? undefined : `The earlier rework opinion: ${lastRework.feedback}`,
      isReviewStage
        ? 'This dispatch ran the dedicated read-only Review stage. Read its concise review report and verify from the facts reported whether review & verification actually passed (all required tests, typechecks, and gates ran and passed with zero open blocking findings). Record verdict "pass" when review is complete and all checks passed; record "rework" when any tests failed, checks were skipped, or blocking issues remain (carrying the open finding IDs, failing command outputs, and review-report.md / test-report.log paths in feedback so the implementation stage fixes them).'
        : 'Decide through the record_review tool: pass when the work is verified and complete (ready for human acceptance), otherwise rework with concrete missing checks or issues.',
      'You may propose the next step on this thread through the record_followup tool (parent ticket id, title, proposed mandate scope, rationale); its scope may only narrow the parent mandate — a wider scope waits for the user\'s approval.',
    ].filter(line => line !== undefined).join('\n')
    let verdict: { readonly verdict: ReviewVerdict; readonly feedback: string } | undefined
    let followup: { readonly parentTicketId: string; readonly title: string; readonly scope: string; readonly rationale: string } | undefined
    await this.runStewardTurn(
      'review',
      agentCtx => {
        agentCtx.tools.register(this.reviewTool(recorded => { verdict = recorded }))
        agentCtx.tools.register(this.followUpTool(recorded => { followup = recorded }))
      },
      prompt,
    )
    if (verdict !== undefined) await this.applyReview(entry, verdict, priorReworks)
    if (followup !== undefined) await this.applyFollowup(followup, entry.dispatchId)
  }

  /** Record the verdict and take its path: acceptance, re-dispatch, or the human's call. */
  private async applyReview(
    entry: { readonly ticketId: string; readonly dispatchId: string },
    verdict: { readonly verdict: ReviewVerdict; readonly feedback: string },
    priorReworks: number,
  ): Promise<void> {
    const now = Date.now()
    await recordReview(this.ctx.dshManagerBoard.reviewStore(), {
      ticketId: entry.ticketId,
      dispatchId: entry.dispatchId,
      verdict: verdict.verdict,
      feedback: verdict.feedback,
    }, now)
    this.note('review', `${verdict.verdict} · ${entry.ticketId}`)
    const path = reviewPath(verdict.verdict, priorReworks)
    if (path === 'acceptance') {
      // A flow ticket that is not its pipeline's last stage walks onward; the
      // acceptance only mints once the walk has no stage left to run.
      const ticket = this.ctx.dshManagerBoard.ticketRecord(entry.ticketId)
      if (ticket?.flow !== undefined) {
        const live = this.resolveLivePipeline(ticket.flow.pipelineId)
        const liveStageCount = live?.stages.length ?? ticket.flow.stageCount
        if (ticket.flow.stageIndex < liveStageCount - 1) {
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
      if (this.isReviewStageTicket(reviewedTicket)) {
        const targetImplStage = this.previousExecutionStage(reviewedTicket)
        if (targetImplStage !== undefined) {
          const lastImplDispatch = [...this.ctx.dshManagerBoard.dispatchStore().listDispatches()]
            .filter(record => record.ticketId === targetImplStage.id)
            .sort((left, right) => right.createdAt - left.createdAt)[0]
          await recordReview(this.ctx.dshManagerBoard.reviewStore(), {
            ticketId: targetImplStage.id,
            dispatchId: lastImplDispatch?.id ?? entry.dispatchId,
            verdict: 'rework',
            feedback: verdict.feedback,
          }, now)
          this.note('review', `return → ${targetImplStage.id}`)
          await this.ctx.dshManagerBoard.reopenStageTicket(targetImplStage.id)
          await this.ctx.dshManagerExecutor.dispatchTicket({ ticketId: targetImplStage.id })
          return
        }
      }
      // The opinion rides on the ticket's reviews; the re-dispatched
      // executor's prompt opens with it.
      await this.ctx.dshManagerBoard.reopenStageTicket(entry.ticketId)
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
    const prompt = [
      `The external object behind ticket ${candidate.ticketId} (thread ${candidate.threadId}) has ended.`,
      `Trigger: [${candidate.trigger.externalKey}] ${describePayload(candidate.trigger.payload) ?? candidate.trigger.externalKey} — ${candidate.trigger.url}`,
      'Decide through the suggest_end tool whether the user should be asked to close this ticket, or keep it open through the keep_open tool.',
    ].join('\n')
    await this.runStewardTurn(
      'end-suggestion',
      agentCtx => {
        agentCtx.tools.register(this.suggestEndTool(candidate.ticketId))
        agentCtx.tools.register(this.keepOpenTool())
      },
      prompt,
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
