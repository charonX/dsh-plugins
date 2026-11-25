/**
 * The crew facility: role cards backed by the unified team-config YAML store.
 * Crew members are the pipeline's labor pool — stages reference them, and a
 * dispatch carries the member's duty prompt with the stage instruction.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { crewMember, type CrewMember } from './crew/crew-core.ts'
import { probeAgentKinds } from './dispatch/cli-backend.ts'
import type {} from './team-config-service.ts'
import {
  agentKindOptionsInputSchema,
  crewInputSchema,
  crewMemberIdSchema,
  crewUpdateInputSchema,
  type AgentKindOption,
  type AgentKindOptionsInput,
  type AgentSlashCommand,
  type CrewInput,
  type CrewMemberIdInput,
  type CrewMemberView,
  type CrewUpdateInput,
  type ModelProviderOptions,
} from './crew/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The crew API served to the Dsh Manager client. */
    dshManagerCrew: DshManagerCrew
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed crew member does not exist. */
    'dshManager/crew-not-found': { readonly memberId: string }
  }
}

/** Crew facet configuration. */
export interface CrewConfig {}

export const CrewConfig: z<CrewConfig> = z.object({})

export class DshManagerCrew extends TypertRemoteService {
  /** Host facilities the crew reads: teamConfig holds the YAML SSOT, llm backs the model catalog. */
  static inject = ['dshManagerTeamConfig', 'llm']

  static Config: z<CrewConfig> = CrewConfig

  private agentKindCache?: readonly AgentKindOption[]

  constructor(ctx: Context, config: CrewConfig) {
    super(ctx, 'dshManagerCrew', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {}

  /** The members, oldest first: the team page's stable roster order. */
  @Remote
  async crewList(): Promise<{ readonly members: readonly CrewMemberView[] }> {
    return { members: this.list() }
  }

  /**
   * The model catalog the member form's dropdowns offer: every registered
   * provider with its advertised models. Providers that fail discovery (no
   * credentials, unreachable endpoint) drop out rather than blocking the form.
   */
  @Remote
  async modelOptions(): Promise<{ readonly providers: readonly ModelProviderOptions[] }> {
    const providers = this.ctx.llm.listProviders()
    const entries = await Promise.all(providers.map(async provider => ({
      provider: provider.id,
      providerName: provider.name,
      models: await this.ctx.llm.listModels(provider.id).then(
        models => models.map(model => ({ id: model.id, name: model.name })),
        () => [] as readonly { id: string; name: string }[],
      ),
    })))
    return { providers: entries.filter(entry => entry.models.length > 0) }
  }

  /**
   * Probe which execution backends are available on the local host (`builtin`
   * always, external CLIs via `subprocess`). Results are cached until
   * `{ refresh: true }`.
   */
  @Remote
  async agentKindOptions(rawInput?: AgentKindOptionsInput): Promise<{ readonly kinds: readonly AgentKindOption[] }> {
    const input = rawInput === undefined ? {} : agentKindOptionsInputSchema.parse(rawInput)
    const refresh = input.refresh === true
    const baseKinds = (!refresh && this.agentKindCache !== undefined)
      ? this.agentKindCache
      : await probeAgentKinds(this.ctx.get('subprocess'))
    if (refresh || this.agentKindCache === undefined) {
      this.agentKindCache = baseKinds
    }
    const kinds = await this.attachExternalSlashCommands(baseKinds, refresh)
    return { kinds }
  }

  /**
   * Enrich external agent kinds with live slash commands from the optional
   * `externalAgents` service without taking a hard dependency on that plugin.
   */
  private async attachExternalSlashCommands(
    kinds: readonly AgentKindOption[],
    _refresh: boolean,
  ): Promise<readonly AgentKindOption[]> {
    type CatalogEntry = {
      readonly id?: unknown
      readonly commands?: readonly {
        readonly name?: unknown
        readonly description?: unknown
        readonly argumentHint?: unknown
      }[]
    }
    type CatalogPayload = readonly CatalogEntry[] | { readonly agents?: readonly CatalogEntry[] }
    const ctxWithRoot = this.ctx as unknown as { root?: { get?: (key: string) => unknown } }
    const externalAgents = (this.ctx.get('externalAgents' as never) ?? ctxWithRoot.root?.get?.('externalAgents')) as {
      getCatalog?: () => Promise<CatalogPayload>
    } | undefined
    if (typeof externalAgents?.getCatalog !== 'function') return kinds
    try {
      const catalog = await externalAgents.getCatalog()
      const entries = Array.isArray(catalog)
        ? catalog
        : catalog !== null && typeof catalog === 'object' && 'agents' in catalog && Array.isArray(catalog.agents)
          ? catalog.agents
          : undefined
      if (entries === undefined) return kinds
      const byId = new Map<string, readonly AgentSlashCommand[]>()
      for (const entry of entries) {
        if (typeof entry?.id !== 'string' || !Array.isArray(entry.commands)) continue
        const parsed: AgentSlashCommand[] = []
        for (const cmd of entry.commands) {
          if (typeof cmd?.name !== 'string' || cmd.name.trim() === '') continue
          parsed.push({
            name: cmd.name.trim(),
            ...(typeof cmd.description === 'string' && cmd.description.trim() !== ''
              ? { description: cmd.description.trim() }
              : {}),
            ...(typeof cmd.argumentHint === 'string' && cmd.argumentHint.trim() !== ''
              ? { argumentHint: cmd.argumentHint.trim() }
              : {}),
          })
        }
        if (parsed.length > 0) byId.set(entry.id, parsed)
      }
      if (byId.size === 0) return kinds
      return kinds.map((kind) => {
        const commands = byId.get(kind.kind)
        return commands === undefined ? kind : { ...kind, slashCommands: commands }
      })
    } catch {
      return kinds
    }
  }

  /** Create one member from the form facts. */
  @Remote
  async crewAdd(rawInput: CrewInput): Promise<{ readonly member: CrewMemberView }> {
    const input = crewInputSchema.parse(rawInput)
    const now = Date.now()
    const record = crewMember.parse({
      id: `crew-${crypto.randomUUID()}`,
      name: input.name,
      role: input.role,
      ...(input.agentKind == null ? {} : { agentKind: input.agentKind }),
      ...(input.provider == null ? {} : { provider: input.provider }),
      ...(input.model == null ? {} : { model: input.model }),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      crew: [...doc.crew, record],
    }))
    return { member: record }
  }

  /** Edit one member's facts; the member must exist. A `null` provider or model clears the override. */
  @Remote
  async crewUpdate(rawInput: CrewUpdateInput): Promise<{ readonly member: CrewMemberView }> {
    const input = crewUpdateInputSchema.parse(rawInput)
    const current = this.require(input.memberId)
    const next: CrewMember = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: Date.now(),
    }
    if (input.provider !== undefined) {
      if (input.provider === null) delete next.provider
      else next.provider = input.provider
    }
    if (input.model !== undefined) {
      if (input.model === null) delete next.model
      else next.model = input.model
    }
    if (input.agentKind !== undefined) {
      if (input.agentKind === null) delete next.agentKind
      else next.agentKind = input.agentKind
    }
    const record = crewMember.parse(next)
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      crew: doc.crew.map(item => (item.id === record.id ? record : item)),
    }))
    return { member: record }
  }

  /** Remove one member and prune any referencing pipeline stages so the YAML stays consistent. */
  @Remote
  async crewRemove(rawInput: CrewMemberIdInput): Promise<{ readonly removed: boolean }> {
    const { memberId } = crewMemberIdSchema.parse(rawInput)
    this.require(memberId)
    const now = Date.now()
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      crew: doc.crew.filter(item => item.id !== memberId),
      pipelines: doc.pipelines.map(pipeline => {
        const stages = pipeline.stages.filter(stage => stage.memberId !== memberId)
        return stages.length === pipeline.stages.length ? pipeline : { ...pipeline, stages, updatedAt: now }
      }),
    }))
    return { removed: true }
  }

  /** The members a pipeline may reference; disabled ones are hidden from new stages. */
  list(): readonly CrewMember[] {
    return this.ctx.dshManagerTeamConfig.crew()
  }

  /** One member by id, or a RemoteError the client renders. */
  require(memberId: string): CrewMember {
    const record = this.ctx.dshManagerTeamConfig.crew().find(item => item.id === memberId)
    if (record === undefined) {
      throw new RemoteError('dshManager/crew-not-found', `crew member ${memberId} does not exist`, { memberId })
    }
    return record
  }
}

export default DshManagerCrew
