/**
 * The Flow facility: manages Flow IR definitions, built-in domain-agnostic presets,
 * one-shot Playbook compilation with hash caching, unified Skill catalog discovery
 * (`ctx.skills` + workspace), and execution backend / model probing.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { probeAgentKinds } from './dispatch/cli-backend.ts'
import {
  discoverWorkspaceSkills,
  type DiscoveredSkill,
  type HostSkillsPort,
} from './dispatch/workspace-skills.ts'
import {
  discoverPlaybooks,
  loadPlaybookSource,
  toDiscoveredPlaybookView,
} from './flow/playbook-catalog.ts'
import {
  flowDefSchema,
  flowIdSchema,
  flowImportPlaybookInputSchema,
  flowInputSchema,
  flowPresetApplyInputSchema,
  flowSyncPlaybookInputSchema,
  flowUpdateInputSchema,
  materializeCompiledPlaybook,
  normalizeStepInputs,
  type AgentKindOption,
  type AgentSlashCommand,
  type DiscoveredPlaybook,
  type FlowDef,
  type FlowIdInput,
  type FlowImportPlaybookInput,
  type FlowInput,
  type FlowPresetApplyInput,
  type FlowSyncPlaybookInput,
  type FlowUpdateInput,
  type ModelProviderOptions,
} from './flow/flow-ir.ts'
import { compilePlaybookToFlow } from './flow/playbook-compiler.ts'
import type { TeamConfigStatusView } from './team-config/team-config-core.ts'
import type {} from './team-config-service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Unified Flow IR, Skill catalog, and Playbook compiler facility. */
    dshManagerFlow: DshManagerFlow
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dshManager/flow-not-found': { readonly flowId: string }
    'dshManager/flow-invalid': { readonly reason: string }
  }
}

export interface FlowServiceConfig {
  /** Optional working directory hint for discovering `skills/playbooks/*.md` and workspace skills. */
  playbookCwd?: string
}

export const FlowServiceConfig: z<FlowServiceConfig> = z.object({
  playbookCwd: z.string(),
})

export class DshManagerFlow extends TypertRemoteService {
  static inject = ['dshManagerTeamConfig', 'llm']

  static Config: z<FlowServiceConfig> = FlowServiceConfig

  private agentKindCache?: readonly AgentKindOption[]
  private readonly playbookCwdConfig: string | undefined

  constructor(ctx: Context, config: FlowServiceConfig = {}) {
    super(ctx, 'dshManagerFlow', { namespace: 'dshManager' })
    this.playbookCwdConfig = config.playbookCwd
  }

  protected async [Service.init](): Promise<void> {}

  private hostSkills(): HostSkillsPort | undefined {
    return (this.ctx as unknown as { get?: (key: string) => unknown }).get?.('skills') as HostSkillsPort | undefined
  }

  private defaultCwd(): string {
    if (this.playbookCwdConfig !== undefined && this.playbookCwdConfig.trim() !== '') {
      return this.playbookCwdConfig
    }
    const reg = (this.ctx as unknown as {
      get?: (key: string) => { list?: () => readonly { readonly path?: string }[] } | undefined
    }).get?.('workspaceRegistry')
    const firstPath = reg?.list?.()?.[0]?.path
    return firstPath !== undefined && firstPath !== '' ? firstPath : process.cwd()
  }

  /** All configured flows, oldest first. */
  list(): readonly FlowDef[] {
    return this.ctx.dshManagerTeamConfig.flows()
  }

  /** Resolve one flow by id, or throw `dshManager/flow-not-found`. */
  require(flowId: string): FlowDef {
    const hit = this.list().find(flow => flow.id === flowId)
    if (hit === undefined) {
      throw new RemoteError('dshManager/flow-not-found', `flow ${flowId} does not exist`, { flowId })
    }
    return hit
  }

  @Remote
  async flowList(): Promise<{ readonly flows: readonly FlowDef[] }> {
    return { flows: this.list() }
  }

  @Remote
  async flowAdd(rawInput: FlowInput): Promise<{ readonly flow: FlowDef }> {
    const input = flowInputSchema.parse(rawInput)
    const now = Date.now()
    const steps = normalizeStepInputs(input.steps)
    const record = flowDefSchema.parse({
      id: `flow-${crypto.randomUUID()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      when: input.when,
      workspaceMode: input.workspaceMode ?? 'in-place',
      steps,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await this.ctx.dshManagerTeamConfig.mutate(doc => ({
        ...doc,
        flows: [...doc.flows, record],
      }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/flow-invalid', reason, { reason })
    }
    return { flow: record }
  }

  @Remote
  async flowUpdate(rawInput: FlowUpdateInput): Promise<{ readonly flow: FlowDef }> {
    const input = flowUpdateInputSchema.parse(rawInput)
    const current = this.require(input.flowId)
    const steps = input.steps === undefined ? current.steps : normalizeStepInputs(input.steps)
    const next = flowDefSchema.parse({
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.when === undefined ? {} : { when: input.when }),
      ...(input.workspaceMode === undefined ? {} : { workspaceMode: input.workspaceMode }),
      steps,
      updatedAt: Date.now(),
    })
    try {
      await this.ctx.dshManagerTeamConfig.mutate(doc => ({
        ...doc,
        flows: doc.flows.map(item => (item.id === next.id ? next : item)),
      }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/flow-invalid', reason, { reason })
    }
    return { flow: next }
  }

  @Remote
  async flowRemove(rawInput: FlowIdInput): Promise<{ readonly removed: boolean }> {
    const { flowId } = flowIdSchema.parse(rawInput)
    this.require(flowId)
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      flows: doc.flows.filter(item => item.id !== flowId),
    }))
    return { removed: true }
  }

  @Remote
  async flowPresetApply(rawInput: FlowPresetApplyInput): Promise<{
    readonly flow: FlowDef
    readonly status: TeamConfigStatusView
  }> {
    const input = flowPresetApplyInputSchema.parse(rawInput)
    const cwd = this.defaultCwd()
    const hostSkills = this.hostSkills()
    const [catalog, availableSkills] = await Promise.all([
      discoverPlaybooks(cwd),
      discoverWorkspaceSkills(cwd, hostSkills).catch(() => []),
    ])
    const entry = catalog.find(item => item.id === input.presetId)
    if (entry === undefined) {
      throw new RemoteError('dshManager/flow-invalid', `unknown preset "${input.presetId}"`, {
        reason: `unknown preset "${input.presetId}"`,
      })
    }
    const compiled = await compilePlaybookToFlow({
      kind: 'file',
      ref: entry.ref,
      content: entry.content,
      availableSkillNames: availableSkills.map(s => s.name),
    })
    let created!: FlowDef
    await this.ctx.dshManagerTeamConfig.mutate((doc) => {
      created = materializeCompiledPlaybook(doc.flows, compiled.flow)
      return { ...doc, flows: [...doc.flows, created] }
    })
    return { flow: created, status: this.ctx.dshManagerTeamConfig.status() }
  }

  /** Compile a Playbook Skill or Markdown file once into a cached Flow IR entry. */
  @Remote
  async flowImportPlaybook(rawInput: FlowImportPlaybookInput): Promise<{
    readonly flow: FlowDef
    readonly cacheHit: boolean
    readonly method: 'cache' | 'frontmatter' | 'markdown' | 'llm'
    readonly status: TeamConfigStatusView
  }> {
    const input = flowImportPlaybookInputSchema.parse(rawInput)
    const cwd = input.cwd ?? this.defaultCwd()
    const hostSkills = this.hostSkills()
    const availableSkills = await discoverWorkspaceSkills(cwd, hostSkills).catch(() => [])
    let content = input.content
    let resolvedRef = input.ref
    if (content === undefined || content.trim() === '') {
      if (input.kind === 'markdown') {
        throw new RemoteError('dshManager/flow-invalid', 'markdown content is required when kind="markdown"', {
          reason: 'markdown content is required',
        })
      }
      try {
        const loaded = await loadPlaybookSource(input.kind, input.ref, cwd, hostSkills)
        content = loaded.content
        resolvedRef = loaded.resolvedRef
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new RemoteError('dshManager/flow-invalid', reason, { reason })
      }
    }
    const existing = this.list().find(f => f.source?.ref === resolvedRef || f.source?.ref === input.ref)
    const result = await compilePlaybookToFlow({
      kind: input.kind === 'markdown' ? 'file' : input.kind,
      ref: resolvedRef,
      content,
      availableSkillNames: availableSkills.map(s => s.name),
      ...(existing === undefined ? {} : { existingFlow: existing }),
      ...(input.useLlm === true ? { compileWithLlm: prompt => this.runPlaybookLlmExtract(prompt) } : {}),
    })
    if (!result.cacheHit) {
      await this.ctx.dshManagerTeamConfig.mutate((doc) => {
        const exists = doc.flows.some(f => f.id === result.flow.id)
        return {
          ...doc,
          flows: exists
            ? doc.flows.map(f => (f.id === result.flow.id ? result.flow : f))
            : [...doc.flows, result.flow],
        }
      })
    }
    return {
      flow: result.flow,
      cacheHit: result.cacheHit,
      method: result.method,
      status: this.ctx.dshManagerTeamConfig.status(),
    }
  }

  /** Re-check a compiled flow's source hash and refresh only if the source changed. */
  @Remote
  async flowSyncPlaybook(rawInput: FlowSyncPlaybookInput): Promise<{
    readonly flow: FlowDef
    readonly cacheHit: boolean
    readonly method: 'cache' | 'frontmatter' | 'markdown' | 'llm'
    readonly status: TeamConfigStatusView
  }> {
    const input = flowSyncPlaybookInputSchema.parse(rawInput)
    const current = this.require(input.flowId)
    if (current.source === undefined) {
      return { flow: current, cacheHit: true, method: 'cache', status: this.ctx.dshManagerTeamConfig.status() }
    }
    const cwd = input.cwd ?? this.defaultCwd()
    const hostSkills = this.hostSkills()
    const availableSkills = await discoverWorkspaceSkills(cwd, hostSkills).catch(() => [])
    let loaded: { readonly resolvedKind: 'skill' | 'file'; readonly resolvedRef: string; readonly content: string }
    try {
      loaded = await loadPlaybookSource(current.source.kind, current.source.ref, cwd, hostSkills)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/flow-invalid', reason, { reason })
    }
    const result = await compilePlaybookToFlow({
      kind: loaded.resolvedKind,
      ref: loaded.resolvedRef,
      content: loaded.content,
      availableSkillNames: availableSkills.map(s => s.name),
      existingFlow: current,
      ...(input.useLlm === true ? { compileWithLlm: prompt => this.runPlaybookLlmExtract(prompt) } : {}),
    })
    if (!result.cacheHit) {
      await this.ctx.dshManagerTeamConfig.mutate(doc => ({
        ...doc,
        flows: doc.flows.map(f => (f.id === current.id ? result.flow : f)),
      }))
    }
    return {
      flow: result.flow,
      cacheHit: result.cacheHit,
      method: result.method,
      status: this.ctx.dshManagerTeamConfig.status(),
    }
  }

  /** List all discovered Playbooks (workspace `skills/playbooks/*.md` priority + plugin built-ins). */
  @Remote
  async playbookCatalog(rawInput?: { readonly cwd?: string }): Promise<{ readonly playbooks: readonly DiscoveredPlaybook[] }> {
    const cwd = rawInput?.cwd !== undefined && rawInput.cwd !== '' ? rawInput.cwd : this.defaultCwd()
    const entries = await discoverPlaybooks(cwd)
    return { playbooks: entries.map(toDiscoveredPlaybookView) }
  }

  /** List all discovered Skills across workspace roots and host `ctx.skills` (including skills-manager). */
  @Remote
  async skillCatalog(rawInput?: { readonly cwd?: string }): Promise<{ readonly skills: readonly DiscoveredSkill[] }> {
    const cwd = rawInput?.cwd !== undefined && rawInput.cwd !== '' ? rawInput.cwd : this.defaultCwd()
    const skills = await discoverWorkspaceSkills(cwd, this.hostSkills())
    return { skills }
  }

  /** Available LLM providers and models for optional per-step overrides. */
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

  /** Available execution backends (`builtin` + probed external CLIs). */
  @Remote
  async agentKindOptions(rawInput?: { readonly refresh?: boolean }): Promise<{ readonly kinds: readonly AgentKindOption[] }> {
    const refresh = rawInput?.refresh === true
    const baseKinds = (!refresh && this.agentKindCache !== undefined)
      ? this.agentKindCache
      : await probeAgentKinds((this.ctx as unknown as { get?: (key: string) => unknown }).get?.('subprocess') as never)
    if (refresh || this.agentKindCache === undefined) {
      this.agentKindCache = baseKinds
    }
    const kinds = await this.attachExternalSlashCommands(baseKinds)
    return { kinds }
  }

  private async runPlaybookLlmExtract(prompt: string): Promise<string> {
    const providers = this.ctx.llm.listProviders()
    const firstProvider = providers[0]
    if (firstProvider === undefined) throw new Error('no LLM provider available')
    const models = await this.ctx.llm.listModels(firstProvider.id)
    const firstModel = models[0]
    if (firstModel === undefined) throw new Error(`no models available for provider ${firstProvider.id}`)
    let output = ''
    for await (const chunk of this.ctx.llm.stream({
      provider: firstProvider.id,
      model: firstModel.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
    }
    return output
  }

  private async attachExternalSlashCommands(kinds: readonly AgentKindOption[]): Promise<readonly AgentKindOption[]> {
    type CatalogEntry = {
      readonly id?: unknown
      readonly commands?: readonly {
        readonly name?: unknown
        readonly description?: unknown
        readonly argumentHint?: unknown
      }[]
    }
    const ext = (this.ctx as unknown as {
      get?: (key: string) => {
        getCatalog?: () => Promise<{ readonly agents?: readonly CatalogEntry[] }>
        listAgentCatalog?: () => Promise<readonly CatalogEntry[]>
      } | undefined
    }).get?.('externalAgents')
    if (ext?.getCatalog === undefined && ext?.listAgentCatalog === undefined) return kinds
    try {
      const catalog = ext.getCatalog !== undefined
        ? (await ext.getCatalog()).agents ?? []
        : await ext.listAgentCatalog!()
      const byId = new Map<string, readonly AgentSlashCommand[]>()
      for (const entry of catalog) {
        if (typeof entry.id !== 'string' || !Array.isArray(entry.commands)) continue
        const cmds: AgentSlashCommand[] = entry.commands
          .filter((cmd): cmd is { name: string; description?: string; argumentHint?: string } =>
            typeof cmd.name === 'string' && cmd.name.trim() !== '')
          .map(cmd => ({
            name: cmd.name.trim(),
            ...(typeof cmd.description === 'string' && cmd.description.trim() !== '' ? { description: cmd.description.trim() } : {}),
            ...(typeof cmd.argumentHint === 'string' && cmd.argumentHint.trim() !== '' ? { argumentHint: cmd.argumentHint.trim() } : {}),
          }))
        byId.set(entry.id, cmds)
      }
      return kinds.map((kind) => {
        const commands = byId.get(kind.kind)
        return commands === undefined || commands.length === 0 ? kind : { ...kind, slashCommands: commands }
      })
    } catch {
      return kinds
    }
  }
}

export default DshManagerFlow
