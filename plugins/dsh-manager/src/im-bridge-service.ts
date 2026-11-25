/**
 * The IM companion bridge: dynamically discovers `@xmanrui/dsh-im` (`ctx.dshIm`)
 * when installed, pushes configured notifications (`attention` by default, plus
 * optional `progress`) to the user's bound IM target, and
 * registers global DSH tools so ordinary chat sessions (WeChat / Web) can
 * query the board, answer/approve attentions, and create manual tickets.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { extractScratchTaskDirFromText } from './dispatch/scratch-artifacts.ts'
import {
  defaultImSettings,
  formatNotificationForIm,
  imDomain,
  imSettingsViewOf,
  matchPendingAttention,
  prefersMarkdownFormat,
  resolveAttentionAnswer,
  shouldSendNotification,
  type DshImCompanionService,
  type ImConfigId,
  type ImDescribedConversation,
  type ImSettingsRecord,
} from './im/im-core.ts'
import {
  imSettingsUpdateInputSchema,
  imTestSendInputSchema,
  type ImBotOption,
  type ImSettingsSnapshotView,
  type ImSettingsUpdateInput,
  type ImTestSendInput,
} from './im/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** External IM companion service provided by `@xmanrui/dsh-im` when installed. */
    dshIm: DshImCompanionService
    /** Dsh Manager's optional IM integration & companion-tool service. */
    dshManagerIm: DshManagerIm
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested `dshIm` operation failed because `dsh-im` or the target is unavailable. */
    'dshManager/im-unavailable': { readonly reason: string }
  }
}

/** IM bridge facet configuration. */
export interface ImBridgeConfig {}

export const ImBridgeConfig: z<ImBridgeConfig> = z.object({})

const IM_RECORD_ID = 'im' as ImConfigId

export class DshManagerIm extends TypertRemoteService {
  /** Only depend on local bundle/core services; `dshIm` and `tools` are discovered lazily. */
  static inject = ['storageDomain', 'dshManagerNotifications', 'dshManagerBoard']

  static Config: z<ImBridgeConfig> = ImBridgeConfig

  private domain?: Domain<typeof imDomain>
  private dshIm: DshImCompanionService | undefined
  private lastDeliveryError: string | undefined

  constructor(ctx: Context, config: ImBridgeConfig) {
    super(ctx, 'dshManagerIm', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(imDomain)
    this.domain = domain
    if (this.domain.table('config').get(IM_RECORD_ID) === undefined) {
      await this.putRecord(defaultImSettings(Date.now()))
    }
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close im domain')

    // Optional reactive binding to `@xmanrui/dsh-im`.
    this.ctx.inject(['dshIm'], (imCtx) => {
      this.dshIm = imCtx.dshIm
      this.lastDeliveryError = undefined
      imCtx.effect(() => () => {
        if (this.dshIm === imCtx.dshIm) this.dshIm = undefined
      }, 'dsh-manager: detach dshIm')
    })

    // Register the IM notification outlet onto the shared notification hub.
    const disposeOutlet = this.ctx.dshManagerNotifications.registerOutlet({
      id: 'dsh-im',
      notify: async (notification) => {
        await this.deliverNotification(notification)
      },
    })
    this.ctx.effect(() => disposeOutlet, 'dsh-manager: unregister dsh-im outlet')

    // Expose lightweight companion tools globally so ordinary IM/Web sessions can interact with Dsh Manager.
    this.ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => toolsCtx.tools.register(this.boardSummaryTool()), 'dsh-manager: register board summary tool')
      toolsCtx.effect(() => toolsCtx.tools.register(this.answerAttentionTool()), 'dsh-manager: register answer attention tool')
      toolsCtx.effect(() => toolsCtx.tools.register(this.createTicketTool()), 'dsh-manager: register create ticket tool')
    })
  }

  /** Read the current IM settings, availability, discovered bots, and targets. */
  @Remote
  async imSettings(): Promise<ImSettingsSnapshotView> {
    const record = this.currentRecord()
    const bots = await this.discoverBots()
    return {
      available: this.dshIm !== undefined,
      settings: imSettingsViewOf(record),
      bots,
      ...(this.lastDeliveryError === undefined ? {} : { lastError: this.lastDeliveryError }),
    }
  }

  /** Update durable IM notification preferences and return the fresh snapshot. */
  @Remote
  async imSettingsUpdate(rawInput: ImSettingsUpdateInput): Promise<ImSettingsSnapshotView> {
    const input = imSettingsUpdateInputSchema.parse(rawInput ?? {})
    const prev = this.currentRecord()
    const nextBotId = input.botId === undefined ? prev.botId : (input.botId === '' ? undefined : input.botId)
    const nextTargetId = input.targetId === undefined
      ? (nextBotId !== prev.botId ? undefined : prev.targetId)
      : (input.targetId === '' ? undefined : input.targetId)
    const next: ImSettingsRecord = {
      id: 'im',
      enabled: input.enabled ?? prev.enabled,
      ...(nextBotId === undefined ? {} : { botId: nextBotId }),
      ...(nextTargetId === undefined ? {} : { targetId: nextTargetId }),
      notifyAttention: input.notifyAttention ?? prev.notifyAttention,
      notifyProgress: input.notifyProgress ?? prev.notifyProgress,
      updatedAt: Date.now(),
    }
    await this.putRecord(next)
    this.lastDeliveryError = undefined
    return await this.imSettings()
  }

  /** Send one immediate verification message through `ctx.dshIm.send`. */
  @Remote
  async imTestSend(rawInput?: ImTestSendInput): Promise<{ readonly sent: boolean; readonly error?: string }> {
    const input = imTestSendInputSchema.parse(rawInput ?? {})
    if (this.dshIm === undefined) {
      throw new RemoteError('dshManager/im-unavailable', 'dsh-im service is not available on this host', { reason: 'dsh-im-missing' })
    }
    const current = this.currentRecord()
    const botId = input.botId ?? current.botId
    const targetId = input.targetId ?? current.targetId
    if (botId === undefined || botId === '' || targetId === undefined || targetId === '') {
      throw new RemoteError('dshManager/im-unavailable', 'select an IM bot and delivery target first', { reason: 'target-missing' })
    }
    try {
      const result = await this.dshIm.send(
        botId,
        targetId,
        '[中控台 · 测试] Dsh Manager 已成功连接到当前 IM 投递目标。',
        { format: 'plain' },
      )
      if (result.sent === true) {
        this.lastDeliveryError = undefined
        return { sent: true }
      }
      this.lastDeliveryError = 'dsh-im send returned sent=false'
      return { sent: false, error: this.lastDeliveryError }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.lastDeliveryError = detail
      return { sent: false, error: detail }
    }
  }

  /** Deliver one notification to its origin IM topic/session (when IM-originated) and/or global IM target. */
  private async deliverNotification(notification: Parameters<Parameters<typeof this.ctx.dshManagerNotifications.registerOutlet>[0]['notify']>[0]): Promise<void> {
    if (this.dshIm === undefined || notification.origin === 'im-tool') return
    const current = this.currentRecord()
    const ticket = notification.ticketId === ''
      ? undefined
      : this.ctx.dshManagerBoard.ticketRecord(notification.ticketId)
    const takeoverSessionId = this.latestTakeoverSessionId(notification.ticketId, ticket?.handoffSessionId)

    let originDescribed: ImDescribedConversation | null = null
    let originDelivered = false
    if (
      ticket?.handoffSessionId !== undefined
      && ticket.handoffSessionId !== ''
      && typeof this.dshIm.describeConversation === 'function'
      && typeof this.dshIm.deliverSessionText === 'function'
      && (notification.kind === 'attention' || notification.kind === 'progress')
    ) {
      try {
        originDescribed = await this.dshIm.describeConversation(ticket.handoffSessionId)
        if (originDescribed !== null) {
          const originFormat = prefersMarkdownFormat(originDescribed.channel) ? 'markdown' : 'plain'
          const originText = formatNotificationForIm(notification, ticket.title, {
            format: originFormat,
            ...(takeoverSessionId === undefined ? {} : { takeoverSessionId }),
          })
          const res = await this.dshIm.deliverSessionText(ticket.handoffSessionId, originText, { format: originFormat })
          if (res.sent === true) {
            originDelivered = true
            this.lastDeliveryError = undefined
          }
        }
      } catch (error) {
        this.lastDeliveryError = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn('dsh-manager: origin IM session delivery failed: %s', this.lastDeliveryError)
      }
    }

    if (!shouldSendNotification(current, notification)) return
    // Avoid duplicate delivery when origin delivery already posted to the same bot & matching DM/group target.
    if (originDelivered && originDescribed !== null && originDescribed.botId === current.botId) {
      const targetMeta = await this.findTargetMeta(current.botId!, current.targetId!)
      const isDirectOrigin = originDescribed.chatType === 'dm'
        || (originDescribed.conversationKey?.startsWith('p2p:') ?? false)
        || (originDescribed.conversationKey?.startsWith('direct:') ?? false)
      if (isDirectOrigin && targetMeta?.kind === 'user') return
      if (!isDirectOrigin && targetMeta?.kind === 'group') return
    }

    const botChannel = await this.resolveBotChannel(current.botId!)
    const format = prefersMarkdownFormat(botChannel) ? 'markdown' : 'plain'
    const text = formatNotificationForIm(notification, ticket?.title, {
      format,
      ...(takeoverSessionId === undefined ? {} : { takeoverSessionId }),
    })
    try {
      const result = await this.dshIm.send(current.botId!, current.targetId!, text, { format })
      if (result.sent !== true) {
        this.lastDeliveryError = 'dsh-im send returned sent=false'
        return
      }
      this.lastDeliveryError = undefined
    } catch (error) {
      this.lastDeliveryError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private latestTakeoverSessionId(ticketId: string, fallbackSessionId?: string): string | undefined {
    if (ticketId === '') return fallbackSessionId
    const dispatches = this.ctx.dshManagerBoard.dispatchStore().listDispatches()
      .filter(record => record.ticketId === ticketId && record.sessionId !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
    return dispatches[0]?.sessionId ?? fallbackSessionId
  }

  private async resolveBotChannel(botId: string): Promise<string | undefined> {
    if (this.dshIm === undefined) return undefined
    try {
      const bots = await this.dshIm.listBots()
      return bots.find(bot => bot.botId === botId)?.channel
    } catch {
      return undefined
    }
  }

  private async findTargetMeta(botId: string, targetId: string): Promise<{ readonly kind: string } | undefined> {
    if (this.dshIm === undefined) return undefined
    try {
      const targets = await this.dshIm.listTargets(botId)
      return targets.find(target => target.targetId === targetId)
    } catch {
      return undefined
    }
  }

  private resolveProjectId(explicitProjectId: string | undefined, sessionId?: string, sessionCwd?: string): string | undefined {
    if (explicitProjectId !== undefined && explicitProjectId !== '') return explicitProjectId
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const workspaces = registry.list()
    if (sessionId !== undefined && sessionId !== '') {
      const bySession = workspaces.find(ws => ws.sessionIds.includes(sessionId as never))
      if (bySession !== undefined) return bySession.id
    }
    if (sessionCwd !== undefined && sessionCwd !== '') {
      const byPath = workspaces.find(ws => ws.path === sessionCwd)
      if (byPath !== undefined) return byPath.id
    }
    return undefined
  }

  private currentRecord(): ImSettingsRecord {
    return this.domain?.table('config').get(IM_RECORD_ID) ?? defaultImSettings(0)
  }

  private async putRecord(record: ImSettingsRecord): Promise<void> {
    await this.domain!.table('config').put(IM_RECORD_ID, record)
  }

  private async discoverBots(): Promise<readonly ImBotOption[]> {
    if (this.dshIm === undefined) return []
    try {
      const rawBots = await this.dshIm.listBots()
      return await Promise.all(rawBots.map(async (bot) => {
        try {
          const targets = await this.dshIm!.listTargets(bot.botId)
          return {
            botId: bot.botId,
            channel: bot.channel,
            targets: targets.map(target => ({
              targetId: target.targetId,
              ...(target.name === undefined ? {} : { name: target.name }),
              kind: target.kind,
            })),
          }
        } catch {
          return { botId: bot.botId, channel: bot.channel, targets: [] }
        }
      }))
    } catch (error) {
      this.ctx.logger?.warn('dsh-manager: failed to list dsh-im bots: %s', String(error))
      return []
    }
  }

  private boardSummaryTool() {
    const self = this
    return defineTool({
      name: 'dsh_manager_board_summary',
      description: 'Inspect Dsh Manager board counts, pending human attentions/approvals, and active tickets. Use when the user asks about tasks, board status, or pending approvals.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            columns: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pendingAttentions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            activeTickets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        const summary = await self.ctx.dshManagerBoard.summary({})
        const columns = summary.columns.map(column => ({ id: column.id, count: column.count }))
        const pendingAttentions = self.ctx.dshManagerBoard.attentionStore().listAttentions()
          .filter(item => item.status === 'pending')
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, 12)
          .map(item => ({
            id: item.id,
            kind: item.kind,
            ticketId: item.ticketId,
            question: item.question,
            ...(item.details === undefined ? {} : { details: item.details }),
          }))
        const activeTickets = self.ctx.dshManagerBoard.ticketRecords()
          .filter(ticket => ticket.state !== 'ended')
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 12)
          .map(ticket => ({
            id: ticket.id,
            title: ticket.title,
            state: ticket.state,
            ...(ticket.flow === undefined ? {} : {
              stage: `${ticket.flow.stageIndex + 1}/${ticket.flow.stageCount}`,
              pipeline: ticket.flow.pipelineName,
            }),
          }))
        return { columns, pendingAttentions, activeTickets }
      },
    })
  }

  private answerAttentionTool() {
    const self = this
    return defineTool({
      name: 'dsh_manager_answer_attention',
      description: 'Approve, reject, or answer one pending Dsh Manager attention/approval item on behalf of the user (e.g., when replying to an IM notification).',
      parameters: {
        attentionId: {
          type: 'string',
          description: 'Pending attention id (full or unique prefix/suffix). Optional only when exactly one pending attention exists.',
        },
        action: {
          type: 'string',
          required: true,
          enum: ['approve', 'reject', 'answer'],
          description: 'Whether to approve/confirm, reject, or provide a text answer.',
        },
        text: {
          type: 'string',
          description: 'Required when action is `answer`; optional rejection reason or feedback when action is `reject`.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            attentionId: { type: 'string' },
            ticketId: { type: 'string' },
            answer: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.ok ? `answered ${value.attentionId} (${value.answer})` : `failed: ${String(value.error)}` }],
      },
      async execute(args) {
        const executor = self.ctx.get('dshManagerExecutor')
        if (executor === undefined) {
          return { ok: false, error: 'dshManagerExecutor is not ready' }
        }
        const attentionIdArg = typeof args.attentionId === 'string' ? args.attentionId : undefined
        const textArg = typeof args.text === 'string' ? args.text : undefined
        const matched = matchPendingAttention(
          self.ctx.dshManagerBoard.attentionStore().listAttentions(),
          attentionIdArg,
        )
        if (!matched.ok) return { ok: false, error: matched.reason }
        const resolved = resolveAttentionAnswer(matched.attention, args.action as 'approve' | 'reject' | 'answer', textArg)
        if (!resolved.ok) return { ok: false, error: resolved.reason }
        await executor.answerAttentionWithOrigin({
          attentionId: matched.attention.id,
          answer: resolved.answer,
        }, 'im-tool')
        return {
          ok: true,
          attentionId: matched.attention.id,
          ticketId: matched.attention.ticketId,
          answer: resolved.answer,
        }
      },
    })
  }

  private createTicketTool() {
    const self = this
    return defineTool({
      name: 'dsh_manager_create_ticket',
      description: 'Create a ticket in Dsh Manager ONLY when the user explicitly requests to create a ticket/task or hand off confirmed work. Never guess or proactively create tickets during open-ended discussion or brainstorming.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short descriptive title of the confirmed task or bug.' },
        description: { type: 'string', required: true, description: 'Concise requirement summary, context, or reproduction info.' },
        scope: { type: 'string', description: 'Explicit mandate scope/boundaries agreed with the user; defaults to description.' },
        acceptanceCriteria: { type: 'string', description: 'Agreed acceptance criteria or checks to run before reporting done.' },
        scratchDir: { type: 'string', description: 'Optional shared scratch task directory path (e.g. home-repos/scratch/tasks/<slug>).' },
        projectId: { type: 'string', description: 'Optional target DSH project id; auto-resolved from the active workspace when omitted.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional prerequisite root ticket IDs that must reach ended before this ticket dispatches.',
        },
        mode: { type: 'string', enum: ['direct', 'inbox'], description: 'direct (default) mints immediately onto todo and routes/dispatches; inbox queues for Steward eval.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            submitted: { type: 'boolean' },
            mode: { type: 'string' },
            ticketId: { type: 'string' },
            threadId: { type: 'string' },
            projectId: { type: 'string' },
            routed: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.submitted
            ? (value.ticketId
              ? `created ${String(value.ticketId)} (${String(value.mode ?? 'direct')}, routed=${String(value.routed ?? false)})`
              : `submitted onto thread ${String(value.threadId)}`)
            : `failed: ${String(value.error)}`,
        }],
      },
      async execute(args, exec) {
        const handoffSessionId = exec?.agent?.id
        const sessionCwd = (exec?.agent as { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined)?.session?.header?.cwd
        const explicitProject = typeof args.projectId === 'string' && args.projectId !== '' ? args.projectId : undefined
        const resolvedProjectId = self.resolveProjectId(explicitProject, handoffSessionId, sessionCwd)
        const mode = args.mode === 'inbox' ? 'inbox' : 'direct'
        const title = String(args.title ?? '').trim()
        const description = String(args.description ?? '').trim()
        const scope = typeof args.scope === 'string' && args.scope.trim() !== '' ? args.scope.trim() : description
        const acceptanceCriteria = typeof args.acceptanceCriteria === 'string' && args.acceptanceCriteria.trim() !== ''
          ? args.acceptanceCriteria.trim()
          : undefined
        const explicitScratch = typeof args.scratchDir === 'string' && args.scratchDir.trim() !== ''
          ? args.scratchDir.trim()
          : undefined
        const dependsOn = Array.isArray(args.dependsOn)
          ? [...new Set(args.dependsOn.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
          : undefined
        const workspaceBase = resolvedProjectId === undefined
          ? sessionCwd
          : (self.ctx.get('workspaceRegistry') as { get?: (id: string) => { path?: string } | undefined } | undefined)?.get?.(resolvedProjectId)?.path ?? sessionCwd
        const resolvedScratchDir = explicitScratch ?? extractScratchTaskDirFromText([scope, acceptanceCriteria].filter(Boolean).join('\n'), workspaceBase)

        if (mode === 'inbox') {
          const sources = self.ctx.get('dshManagerSources')
          if (sources === undefined) {
            return { submitted: false, error: 'dshManagerSources is not ready' }
          }
          const created = await sources.manualInput({
            title,
            description,
            ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
          })
          return {
            submitted: true,
            mode: 'inbox',
            threadId: created.threadId,
            ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
          }
        }

        const ticket = await self.ctx.dshManagerBoard.mintDirectTicket({
          title,
          scope,
          ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
          ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
          ...(handoffSessionId === undefined ? {} : { handoffSessionId }),
          ...(resolvedScratchDir === undefined ? {} : { scratchDir: resolvedScratchDir }),
          ...(dependsOn !== undefined && dependsOn.length > 0 ? { dependsOn } : {}),
        }, Date.now())

        let routed = false
        const steward = self.ctx.get('dshManagerSteward')
        if (steward !== undefined) {
          try {
            routed = await steward.routeDirectTicket(ticket.id)
          } catch (error) {
            self.ctx.logger?.warn('dsh-manager: direct ticket route failed for %s: %s', ticket.id, String(error))
          }
        }
        return {
          submitted: true,
          mode: 'direct',
          ticketId: ticket.id,
          routed,
          ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
        }
      },
    })
  }
}

export default DshManagerIm
