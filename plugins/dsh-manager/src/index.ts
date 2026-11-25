/**
 * The dsh-manager bundle entry: one composition root that mounts every
 * bundle-level facility in dependency order (ADR-0003; spec implementation
 * decision 4). Sibling services read each other through inject — composing
 * them from a consumer's own init would deadlock on its own inject list.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { boardDomain, boardSummaryOf, type BoardColumnId, type BoardSummary, type EvalRecord, type TicketFlow, type TicketRecord, type TicketView, type TicketWorktreePlan } from './board-domain.ts'
import { boardFilterSchema, closeTicketInputSchema, ticketDependenciesInputSchema, type BoardFilter, type CloseTicketInput, type TicketDependenciesInput } from './board/wire-types.ts'
import { unresolvedDependencies, validateDependencies } from './board/dependency-core.ts'
import type { AttentionStorePort } from './attention/attention-core.ts'
import { createDomainAttentionStore } from './attention/storage-store.ts'
import type { ReviewStorePort } from './review/review-core.ts'
import { createDomainReviewStore } from './review/storage-store.ts'
import { DshManagerConnections } from './connections-service.ts'
import { DshManagerChannel } from './channel-service.ts'
import { DshManagerTeamConfig } from './team-config-service.ts'
import { DshManagerCrew } from './crew-service.ts'
import { DshManagerPipeline } from './pipeline-service.ts'
import { DshManagerRoute } from './route-service.ts'
import { DshManagerEffects } from './effects-service.ts'
import { pendingBacklog, POLICY_VERSION } from './evals/eval-core.ts'
import { fanInViewOf } from './evals/subscription.ts'
import { createDomainEvalStore, type DomainEvalStore } from './evals/storage-store.ts'
import { DshManagerExecutor, ExecutorConfig as ExecutorConfigSchema, type ExecutorConfig } from './executor-service.ts'
import { DshManagerIm } from './im-bridge-service.ts'
import { DshManagerMappings } from './mappings-service.ts'
import { DshManagerNotifications } from './notifications-service.ts'
import { DshManagerPolicy } from './policy-service.ts'
import { DshManagerSettings } from './settings-service.ts'
import { DshManagerSources } from './sources-service.ts'
import { DshManagerSteward, StewardConfig as StewardConfigSchema, type StewardConfig } from './steward-service.ts'
import { DshManagerWatchdog, WatchdogConfig as WatchdogConfigSchema, type WatchdogConfig } from './watchdog-service.ts'
import { createDomainDispatchStore } from './dispatch/storage-store.ts'
import type { DispatchStorePort } from './dispatch/dispatch-core.ts'
import type { TicketLinkView } from './dispatch/wire-types.ts'
import { flowChain, flowTimelineOf, renderFlowMarkdown } from './flow/flow-core.ts'

export type { BoardColumn, BoardSummary } from './board-domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Board API served to the Dsh Manager client page. */
    dshManagerBoard: DshManagerBoard
  }
}

/** Board facet configuration; the markdown mirror lands under the flow mirror directory. */
export interface BoardConfig {
  /** The project directory the flow mirrors write under; defaults to the process cwd. */
  flowsCwd?: string
}

export const BoardConfig: z<BoardConfig> = z.object({
  flowsCwd: z.string(),
})

/**
 * Bundle configuration: the composition root's facet settings. `steward`
 * configures the resident main Session; `executor` configures dispatched
 * Executor Sessions.
 */
export interface BundleConfig {
  /** The Steward facet's provider, model, accept mode, and tick cadence. */
  steward?: StewardConfig
  /** The Executor facet's provider, model, concurrency ceiling, and cwd. */
  executor?: ExecutorConfig
  /** The Watchdog facet's sweep cadence and anomaly thresholds. */
  watchdog?: WatchdogConfig
  /** Optional path override for the hot-reloading `team-config.yaml` SSOT. */
  teamConfigPath?: string
}

export const BundleConfig: z<BundleConfig> = z.object({
  steward: StewardConfigSchema,
  executor: ExecutorConfigSchema,
  watchdog: WatchdogConfigSchema,
  teamConfigPath: z.string(),
})

/** Host service behind the board page: reads the durable ticket pool and projects the board. */
export class DshManagerBoard extends TypertRemoteService {
  /** Host services the board reads; sources is a bundle sibling. */
  static inject = ['storageDomain', 'dshManagerSources']

  static Config: z<BoardConfig> = BoardConfig

  private domain?: Domain<typeof boardDomain>

  private flowsCwd: string

  constructor(ctx: Context, config: BoardConfig) {
    super(ctx, 'dshManagerBoard', { namespace: 'dshManager' })
    this.flowsCwd = config.flowsCwd ?? process.cwd()
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(boardDomain)
    this.domain = domain
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close board domain')
  }

  /** The eval store the Steward drives; the board owns the domain. */
  evalStore(): DomainEvalStore {
    return createDomainEvalStore(this.domain!)
  }

  /** The dispatch store the executor drives; the board owns the domain. */
  dispatchStore(): DispatchStorePort {
    return createDomainDispatchStore(this.domain!)
  }

  /** The attention store the executor drives; the board owns the domain. */
  attentionStore(): AttentionStorePort {
    return createDomainAttentionStore(this.domain!)
  }

  /** The review store the Steward drives; the board owns the domain. */
  reviewStore(): ReviewStorePort {
    return createDomainReviewStore(this.domain!)
  }

  /**
   * Annotate one ticket with its flow stage after the Steward routed it.
   * The annotation is the only flow concept a ticket record carries; the
   * board and the Watchdog stay flow-agnostic.
   */
  async annotateFlow(id: string, flow: TicketFlow): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined || record.state === 'ended') return undefined
    const updated: TicketRecord = { ...record, flow, updatedAt: Date.now() }
    await this.domain!.table('tickets').put(id as never, updated)
    await this.touchFlowMirror(id)
    return updated
  }

  /** Persist or merge the structured worktree & repository target plan on a ticket. */
  async updateWorktreePlan(id: string, patch: TicketWorktreePlan): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined) return undefined
    const merged: TicketWorktreePlan = {
      mode: patch.mode,
      ...((patch.repoRoot ?? record.worktree?.repoRoot) === undefined ? {} : { repoRoot: patch.repoRoot ?? record.worktree?.repoRoot }),
      ...((patch.baseBranch ?? record.worktree?.baseBranch) === undefined ? {} : { baseBranch: patch.baseBranch ?? record.worktree?.baseBranch }),
      ...((patch.branch ?? record.worktree?.branch) === undefined ? {} : { branch: patch.branch ?? record.worktree?.branch }),
      ...((patch.mergeTarget ?? record.worktree?.mergeTarget) === undefined ? {} : { mergeTarget: patch.mergeTarget ?? record.worktree?.mergeTarget }),
      ...((patch.path ?? record.worktree?.path) === undefined ? {} : { path: patch.path ?? record.worktree?.path }),
    }
    const updated: TicketRecord = { ...record, worktree: merged, updatedAt: Date.now() }
    await this.domain!.table('tickets').put(id as never, updated)
    return updated
  }

  /**
   * Rewrite the flow mirror of the walk one ticket belongs to, if any. The
   * board is the single writer: every flow mutation and ending passes here,
   * and the mirror renders the chain's current state into the project
   * directory so members and the steward read progress from the filesystem.
   */
  private async touchFlowMirror(id: string): Promise<void> {
    try {
      const records: TicketRecord[] = [...this.domain!.table('tickets').entries()].map(([, record]) => record)
      const chain = flowChain(records, id)
      if (chain === undefined) return
      const readyReports = new Map<string, string>()
      for (const dispatch of this.domain!.table('dispatches').entries()) {
        const [, record] = dispatch
        const ready = [...record.reports].reverse().find(report => report.kind === 'ready')
        if (ready !== undefined) readyReports.set(record.ticketId, ready.message)
      }
      const view = flowTimelineOf(
        chain,
        ticket => {
          const readyReport = readyReports.get(ticket.id)
          return {
            ...(readyReport === undefined ? {} : { readyReport }),
          }
        },
        pipelineId => this.resolveLivePipeline(pipelineId),
      )
      const dir = join(this.flowsCwd, '.dsh-manager', 'flows')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${view.rootTicketId}.md`), renderFlowMarkdown(view), 'utf8')
    } catch (error) {
      // A failed mirror write never breaks the flow mutation it follows.
      this.ctx.logger?.warn('the flow mirror write failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /** Replace one ticket's flow annotation wholesale (stage walks and skip states). */
  async replaceFlow(id: string, flow: TicketFlow | undefined): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined) return undefined
    const updated: TicketRecord = {
      ...record,
      ...(flow === undefined ? {} : { flow }),
      updatedAt: Date.now(),
    }
    await this.domain!.table('tickets').put(id as never, updated)
    await this.touchFlowMirror(id)
    return updated
  }

  /**
   * Quietly mark an upstream pipeline stage as `ended` once it hands off to a
   * successor stage so completed stages leave the `todo` column immediately.
   * Does not emit a ticket-completed notification or wake downstream dependents.
   */
  async completeSupersededStage(id: string, now: number): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined || record.state === 'ended') return record
    const updated: TicketRecord = { ...record, state: 'ended', updatedAt: now }
    await this.domain!.table('tickets').put(id as never, updated)
    await this.touchFlowMirror(id)
    return updated
  }

  /**
   * Re-open a prior execution stage ticket from `ended` back to `todo` when a
   * later review stage returns the flow walk for rework.
   */
  async reopenStageTicket(id: string): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined || record.state !== 'ended') return record
    const updated: TicketRecord = { ...record, state: 'todo', updatedAt: Date.now() }
    await this.domain!.table('tickets').put(id as never, updated)
    await this.touchFlowMirror(id)
    return updated
  }

  /**
   * End one ticket (and every open stage ticket sharing its pipeline flow chain
   * so completed/abandoned flow stages never stay stranded in the `todo` column).
   */
  async finishTicket(id: string, now: number, options?: { readonly reason?: string }): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined) return undefined
    const all = this.ticketRecords()
    const chain = record.flow === undefined ? undefined : flowChain(all, id)
    const targetRecords = chain === undefined
      ? [record]
      : chain.stages.length > 0 ? [...chain.stages] : [record]
    if (!targetRecords.some(entry => entry.id === id)) targetRecords.push(record)

    let mutatedTarget: TicketRecord | undefined
    let anyEnded = false
    for (const entry of targetRecords) {
      if (entry.state === 'ended') {
        if (entry.id === id) mutatedTarget = entry
        continue
      }
      const updated: TicketRecord = { ...entry, state: 'ended', updatedAt: now }
      await this.domain!.table('tickets').put(entry.id as never, updated)
      anyEnded = true
      if (entry.id === id) mutatedTarget = updated
    }
    if (!anyEnded) return undefined
    await this.touchFlowMirror(id)
    const reason = options?.reason?.trim()
    await this.ctx.get('dshManagerNotifications')?.notify({
      id: `progress-ended-${id}-${now}`,
      kind: 'progress',
      attentionId: '',
      ticketId: id,
      title: reason && reason !== ''
        ? `工单已关闭: ${(mutatedTarget ?? record).title} (${reason})`
        : `工单已结束: ${(mutatedTarget ?? record).title}`,
      at: now,
    })
    void this.ctx.get('dshManagerExecutor')?.pump()
    return mutatedTarget ?? record
  }

  /**
   * Manually close/abandon a ticket from the board UI or API: aborts active
   * dispatches and pending attentions across the ticket (and its open flow
   * chain), moves all related stages to `ended`, and wakes waiting dependents.
   */
  @Remote
  async closeTicket(rawInput: CloseTicketInput): Promise<{ readonly ticket: TicketView }> {
    const input = closeTicketInputSchema.parse(rawInput)
    const record = this.domain!.table('tickets').get(input.ticketId as never)
    if (record === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const now = Date.now()
    if (record.state !== 'ended') {
      const chain = record.flow === undefined ? undefined : flowChain(this.ticketRecords(), record.id)
      const stageIds = chain === undefined
        ? [record.id]
        : [...new Set([record.id, ...chain.stages.map(stage => stage.id)])]
      const executor = this.ctx.get('dshManagerExecutor')
      if (executor !== undefined) {
        for (const stageId of stageIds) {
          await executor.abortTicketWork(stageId, input.reason)
        }
      }
      await this.finishTicket(record.id, now, input.reason === undefined ? undefined : { reason: input.reason })
    }
    return { ticket: this.ticketView(record.id)! }
  }

  /**
   * Update a ticket's prerequisite dependencies (`dependsOn`), rejecting
   * missing targets and cycles, then immediately nudging the executor pump
   * in case the ticket is now unblocked.
   */
  @Remote
  async setTicketDependencies(rawInput: TicketDependenciesInput): Promise<{ readonly ticket: TicketView }> {
    const input = ticketDependenciesInputSchema.parse(rawInput)
    const record = this.domain!.table('tickets').get(input.ticketId as never)
    if (record === undefined) {
      throw new RemoteError('dshManager/ticket-not-found', `ticket ${input.ticketId} does not exist`, { id: input.ticketId })
    }
    const all = this.ticketRecords()
    let validated: string[]
    try {
      validated = validateDependencies(all, record.id, input.dependsOn)
    } catch (error) {
      throw new RemoteError(
        'dshManager/ticket-blocked',
        error instanceof Error ? error.message : String(error),
        { id: record.id },
      )
    }
    const next: TicketRecord = { ...record, updatedAt: Date.now() }
    if (validated.length > 0) next.dependsOn = validated
    else delete next.dependsOn
    await this.domain!.table('tickets').put(record.id as never, next)
    const executor = this.ctx.get('dshManagerExecutor')
    if (executor !== undefined) {
      if (
        validated.length === 0
        && (record.dependsOn?.length ?? 0) > 0
        && next.state === 'todo'
        && next.flow !== undefined
        && next.flow.pendingSkip === undefined
      ) {
        void executor.dispatchTicket({ ticketId: record.id }).catch(() => {})
      } else {
        void executor.pump()
      }
    }
    return { ticket: this.ticketView(record.id)! }
  }

  /** Record that `ticketId` was absorbed/resolved by `supersededBy`. */
  async markSuperseded(ticketId: string, supersededBy: string): Promise<TicketRecord | undefined> {
    const record = this.domain!.table('tickets').get(ticketId as never)
    if (record === undefined) return undefined
    const updated: TicketRecord = { ...record, supersededBy, updatedAt: Date.now() }
    await this.domain!.table('tickets').put(ticketId as never, updated)
    return updated
  }

  /**
   * Mint one follow-up ticket off a parent: it inherits the parent's
   * Mandate with the proposed scope (the inheritance gate is the caller's —
   * a widened scope waits for the human's approval first), carries the
   * parent's Thread and source, and records what it follows up.
   */
  async mintFollowUp(input: { readonly parentId: string; readonly title: string; readonly scope: string }, now: number): Promise<TicketRecord | undefined> {
    const parent = this.domain!.table('tickets').get(input.parentId as never)
    if (parent === undefined || parent.mandate === undefined) return undefined
    const record: TicketRecord = {
      id: `ticket-follow-${crypto.randomUUID()}`,
      title: input.title,
      threadId: parent.threadId,
      ...(parent.projectId === undefined ? {} : { projectId: parent.projectId }),
      state: 'todo',
      mandate: { strength: parent.mandate.strength, scope: input.scope, policyVersion: parent.mandate.policyVersion },
      followUpOf: parent.id,
      ...(parent.sourceConnectionId === undefined ? {} : { sourceConnectionId: parent.sourceConnectionId }),
      ...(parent.handoffSessionId === undefined ? {} : { handoffSessionId: parent.handoffSessionId }),
      ...(parent.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: parent.acceptanceCriteria }),
      ...(parent.scratchDir === undefined ? {} : { scratchDir: parent.scratchDir }),
      ...(parent.worktree === undefined ? {} : { worktree: parent.worktree }),
      createdAt: now,
      updatedAt: now,
    }
    await this.domain!.table('tickets').put(record.id as never, record)
    return record
  }

  /**
   * Mint an explicit `todo` ticket directly from a confirmed interactive chat
   * hand-off, skipping Steward inbox re-evaluation while keeping board/flow invariants.
   */
  async mintDirectTicket(
    input: {
      readonly title: string
      readonly scope: string
      readonly acceptanceCriteria?: string
      readonly projectId?: string
      readonly handoffSessionId?: string
      readonly scratchDir?: string
      readonly dependsOn?: readonly string[]
    },
    now: number,
  ): Promise<TicketRecord> {
    const id = `ticket-direct-${crypto.randomUUID()}`
    const validatedDeps = input.dependsOn !== undefined && input.dependsOn.length > 0
      ? validateDependencies(this.ticketRecords(), id, input.dependsOn)
      : []
    const record: TicketRecord = {
      id,
      title: input.title,
      threadId: '',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      state: 'todo',
      mandate: { strength: 'explicit', scope: input.scope, policyVersion: POLICY_VERSION },
      ...(input.handoffSessionId === undefined ? {} : { handoffSessionId: input.handoffSessionId }),
      ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
      ...(input.scratchDir === undefined ? {} : { scratchDir: input.scratchDir }),
      ...(validatedDeps.length === 0 ? {} : { dependsOn: validatedDeps }),
      createdAt: now,
      updatedAt: now,
    }
    await this.domain!.table('tickets').put(record.id as never, record)
    return record
  }

  /** One ticket's follow-up chain: the ticket it follows up and the follow-ups it minted. */
  ticketLinks(id: string): { parent?: TicketLinkView; children: readonly TicketLinkView[] } {
    const tickets: TicketRecord[] = [...this.domain!.table('tickets').entries()].map(([, record]) => record)
    const linkOf = (record: TicketRecord): TicketLinkView => ({ id: record.id, title: record.title, state: record.state })
    const record = tickets.find(entry => entry.id === id)
    const parent = record?.followUpOf !== undefined
      ? tickets.find(entry => entry.id === record.followUpOf)
      : undefined
    const children = tickets
      .filter(entry => entry.followUpOf === id)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(linkOf)
    return {
      ...(parent === undefined ? {} : { parent: linkOf(parent) }),
      children,
    }
  }

  /** The tickets currently holding a pending attention, for the 待人工 projection. */
  pendingAttentionTicketIds(): ReadonlySet<string> {
    return new Set([...this.domain!.table('attentions').entries()]
      .map(([, record]) => record)
      .filter(record => record.status === 'pending')
      .map(record => record.ticketId))
  }

  /** The tickets with a queued or running dispatch, for the 进行中 projection. */
  runningDispatchTicketIds(): ReadonlySet<string> {
    return new Set([...this.domain!.table('dispatches').entries()]
      .map(([, record]) => record)
      .filter(record => record.state === 'running' || record.state === 'queued')
      .map(record => record.ticketId))
  }

  /** The projected board state: pending attention lifts to 待人工; active dispatch lifts todo to 进行中. */
  private projectedState(
    record: TicketRecord,
    pendingAttentionIds: ReadonlySet<string>,
    runningTicketIds: ReadonlySet<string> = new Set(),
  ): TicketRecord['state'] {
    if (record.state !== 'ended' && pendingAttentionIds.has(record.id)) return 'attention'
    if (record.state === 'todo' && runningTicketIds.has(record.id)) return 'running'
    return record.state
  }

  /** One raw ticket record, for services reading tickets host-internally. */
  ticketRecord(id: string): TicketRecord | undefined {
    return this.domain!.table('tickets').get(id as never)
  }

  /** Every raw ticket record, for services aggregating the pool host-internally. */
  ticketRecords(): readonly TicketRecord[] {
    return [...this.domain!.table('tickets').entries()].map(([, record]) => record)
  }

  /** Read the ticket pool and project the board columns, optionally filtered. */
  @Remote
  async summary(rawInput?: BoardFilter): Promise<BoardSummary> {
    const filter = boardFilterSchema.parse(rawInput ?? {})
    const all: TicketRecord[] = [...this.domain!.table('tickets').entries()].map(([, value]) => value)
    // The inbox column derives from the trigger side: one pending thread each.
    // Threads with a live ticket are subscribed — their triggers fan out to
    // the ticket instead of queueing a new eval. The inbox stays unfiltered:
    // it counts waiting work, not the visible slice.
    const facts = this.ctx.dshManagerSources.listTriggerFacts()
    const evals: EvalRecord[] = [...this.domain!.table('evals').entries()].map(([, value]) => value)
    const pending = pendingBacklog(facts, evals, all).length
    const candidates = evals.filter(evalRecord => evalRecord.status === 'candidate').length
    const resolvedThreads = new Set<string>([
      ...all.map(ticket => ticket.threadId),
      ...evals
        .filter(evalRecord => evalRecord.status === 'accepted' || evalRecord.status === 'candidate' || evalRecord.status === 'rejected')
        .map(evalRecord => evalRecord.threadId),
    ])
    // The rework pool: evals the steward gave up on whose thread has not later resolved.
    const pool = evals.filter(evalRecord =>
      (evalRecord.status === 'failed' || evalRecord.status === 'incomplete')
      && !resolvedThreads.has(evalRecord.threadId),
    ).length
    const pendingAttentionIds = this.pendingAttentionTicketIds()
    const runningTicketIds = this.runningDispatchTicketIds()
    return boardSummaryOf(this.filterTickets(all, filter).map(record => {
      const nextState = this.projectedState(record, pendingAttentionIds, runningTicketIds)
      return nextState === record.state ? record : { ...record, state: nextState }
    }), pending + candidates, pool)
  }

  /** List ticket cards with their fanned-in context, filtered, newest accepted first. */
  @Remote
  async ticketList(rawInput?: BoardFilter): Promise<{ readonly tickets: readonly TicketView[] }> {
    const filter = boardFilterSchema.parse(rawInput ?? {})
    const evals: EvalRecord[] = [...this.domain!.table('evals').entries()].map(([, value]) => value)
    // The batch each ticket's accepting eval covered; the rest of its thread
    // fans in as context.
    const batchByTicket = new Map<string, readonly string[]>()
    for (const evalRecord of evals) {
      if (evalRecord.status === 'accepted' && evalRecord.ticketId !== undefined) {
        batchByTicket.set(evalRecord.ticketId, evalRecord.triggerIds)
      }
    }
    const records = this.filterTickets(
      [...this.domain!.table('tickets').entries()].map(([, record]) => record), filter)
    const pendingAttentionIds = this.pendingAttentionTicketIds()
    const runningTicketIds = this.runningDispatchTicketIds()
    const tickets = [...records]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(record => this.projectTicket(record, batchByTicket.get(record.id) ?? [], pendingAttentionIds, runningTicketIds, records))
    return { tickets }
  }

  /** One ticket card with its fanned-in context, for the detail view. */
  ticketView(id: string): TicketView | undefined {
    const record = this.domain!.table('tickets').get(id as never)
    if (record === undefined) return undefined
    const evals: EvalRecord[] = [...this.domain!.table('evals').entries()].map(([, value]) => value)
    const batch = evals.find(evalRecord => evalRecord.status === 'accepted' && evalRecord.ticketId === id)?.triggerIds ?? []
    return this.projectTicket(record, batch, this.pendingAttentionTicketIds(), this.runningDispatchTicketIds(), this.ticketRecords())
  }

  /** Resolve live pipeline name and stage count for in-flight projections; falls back cleanly if removed. */
  private resolveLivePipeline(pipelineId: string): { readonly name: string; readonly stageCount: number } | undefined {
    const svc = this.ctx.get('dshManagerPipeline')
    if (svc === undefined) return undefined
    try {
      const pipeline = svc.require(pipelineId)
      return { name: pipeline.name, stageCount: pipeline.stages.length }
    } catch {
      return undefined
    }
  }

  /** Project one stored record into its wire card, given its accepting batch. */
  private projectTicket(
    record: TicketRecord,
    batch: readonly string[],
    pendingAttentionIds: ReadonlySet<string> = new Set(),
    runningTicketIds: ReadonlySet<string> = new Set(),
    allRecords: readonly TicketRecord[] = this.ticketRecords(),
  ): TicketView {
    const fanIn = fanInViewOf(record, batch, this.ctx.dshManagerSources.threadTriggers(record.threadId))
    const waitingOn = unresolvedDependencies(allRecords, record)
    const live = record.flow === undefined ? undefined : this.resolveLivePipeline(record.flow.pipelineId)
    const flow = record.flow === undefined ? undefined : {
      ...record.flow,
      ...(live === undefined ? {} : {
        pipelineName: live.name,
        stageCount: Math.max(live.stageCount, record.flow.stageIndex + 1),
      }),
    }
    const workspaceRegistry = (this.ctx as unknown as {
      get?: (name: string) => { get?: (id: string) => { title?: string } | undefined } | undefined
    }).get?.('workspaceRegistry')
    const projectName = record.projectId === undefined
      ? undefined
      : workspaceRegistry?.get?.(record.projectId)?.title
    const sourceConnectionName = record.sourceConnectionId === undefined
      ? undefined
      : this.ctx.get('dshManagerConnections')?.connectionName(record.sourceConnectionId)
    return {
      id: record.id,
      title: record.title,
      state: this.projectedState(record, pendingAttentionIds, runningTicketIds),
      threadId: record.threadId,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      ...(projectName === undefined || projectName === '' ? {} : { projectName }),
      ...(record.sourceConnectionId === undefined ? {} : { sourceConnectionId: record.sourceConnectionId }),
      ...(sourceConnectionName === undefined || sourceConnectionName === '' ? {} : { sourceConnectionName }),
      ...(record.externalKey === undefined ? {} : { externalKey: record.externalKey }),
      ...(record.url === undefined ? {} : { url: record.url }),
      ...(record.mandate === undefined ? {} : { mandate: record.mandate }),
      ...(flow === undefined ? {} : { flow }),
      ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
      ...(record.scratchDir === undefined ? {} : { scratchDir: record.scratchDir }),
      ...(record.dependsOn === undefined || record.dependsOn.length === 0 ? {} : { dependsOn: record.dependsOn }),
      ...(waitingOn.length === 0 ? {} : { waitingOn }),
      ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
      ...(fanIn.length > 0 ? { fanIn } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /** Keep only the tickets matching the combined filter. */
  private filterTickets(tickets: readonly TicketRecord[], filter: BoardFilter): readonly TicketRecord[] {
    const needle = filter.search?.trim().toLowerCase()
    if (filter.connectionId === undefined && filter.projectId === undefined
      && filter.kind === undefined && needle === undefined) return tickets
    const threadKinds = new Map(
      this.ctx.dshManagerSources.listThreadFacts().map(fact => [fact.id, fact.kind]))
    return tickets.filter(record => {
      if (filter.connectionId !== undefined && record.sourceConnectionId !== filter.connectionId) return false
      if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false
      if (filter.kind !== undefined && threadKinds.get(record.threadId) !== filter.kind) return false
      if (needle !== undefined
        && !record.title.toLowerCase().includes(needle)
        && !(record.externalKey ?? '').toLowerCase().includes(needle)) return false
      return true
    })
  }
}

/** The bundle's composition root: one entry, every facility, in order. */
export class DshManagerBundle extends Service {
  /** Host facilities the composition root mounts on. */
  static inject = ['storageDomain']

  static Config: z<BundleConfig> = BundleConfig

  private config: BundleConfig

  constructor(ctx: Context, config: BundleConfig) {
    super(ctx, 'dshManagerBundle')
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    await this.ctx.plugin(DshManagerEffects)
    await this.ctx.plugin(DshManagerConnections)
    await this.ctx.plugin(DshManagerMappings)
    await this.ctx.plugin(DshManagerSources)
    await this.ctx.plugin(DshManagerNotifications)
    await this.ctx.plugin(DshManagerChannel)
    // The versioned Policy feeds every Eval's input and mints versions on
    // the user's confirmations and page edits.
    await this.ctx.plugin(DshManagerPolicy)
    // The UI settings (panel display name) persist independently of the board.
    await this.ctx.plugin(DshManagerSettings)
    // Declarative YAML SSOT for crew, pipelines, and routes (hot-reloading).
    await this.ctx.plugin(
      DshManagerTeamConfig,
      this.config.teamConfigPath === undefined ? undefined : { filePath: this.config.teamConfigPath },
    )
    // The crew's role cards back the pipeline stages (mounted before the
    // facilities that will reference them).
    await this.ctx.plugin(DshManagerCrew)
    // The pipelines reference the crew and validate stage members on write.
    await this.ctx.plugin(DshManagerPipeline)
    // The route rules reference the pipelines and validate them on write.
    await this.ctx.plugin(DshManagerRoute)
    await this.ctx.plugin(DshManagerBoard, this.config.executor?.cwd === undefined ? undefined : { flowsCwd: this.config.executor.cwd })
    // The Steward drives evals through the agent runtime; it reads the board's
    // eval store and the sources' trigger facts (both mounted above).
    await this.ctx.plugin(DshManagerSteward, this.config.steward)
    // The executor dispatches tickets into Executor Sessions; it reads the
    // board's dispatch store and enqueues durable starts on the effects queue.
    await this.ctx.plugin(DshManagerExecutor, this.config.executor)
    // The Watchdog sweeps for silent dispatches, failure runs, and dead
    // connections; its findings surface on the board's 待人工 column.
    await this.ctx.plugin(DshManagerWatchdog, this.config.watchdog)
    // Optional IM companion bridge: dynamically discovers `ctx.dshIm` and global `tools`.
    await this.ctx.plugin(DshManagerIm)
  }
}

export default DshManagerBundle
