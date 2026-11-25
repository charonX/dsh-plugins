/**
 * Declarative YAML single-source-of-truth (SSOT) store for Crew, Pipelines,
 * and Route Rules with atomic writes, one-time migration from legacy
 * storage-domain tables, anti-echo file watching, and all-or-nothing
 * validation on hot reload.
 */
import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { crewDomain } from './crew/crew-domain.ts'
import type { CrewMember } from './crew/crew-core.ts'
import { pipelineDomain } from './pipeline/pipeline-domain.ts'
import type { PipelineRecord } from './pipeline/pipeline-core.ts'
import { routeDomain } from './route/route-domain.ts'
import type { RouteRule } from './route/route-core.ts'
import type { TicketRecord } from './board-domain.ts'
import { discoverWorkspaceSkills } from './dispatch/workspace-skills.ts'
import { discoverProjectLandingFacts, formatLandingDiscoveryPromptLines } from './dispatch/landing-discovery.ts'
import { TURN_IDS, TURN_REGISTRY, type TurnId } from './prompt/prompt-sections.ts'
import { resolveSections, type GlobalPromptsConfig, type PromptSectionsMap } from './prompt/prompt-resolve.ts'
import { PROMPT_VARIABLES, buildPromptContext } from './prompt/prompt-vars.ts'
import { probeProjectFacts } from './prompt/project-facts.ts'
import { renderTurn } from './prompt/prompt-render.ts'
import {
  emptyTeamConfig,
  parseTeamConfigYaml,
  sanitizeLegacyTeamConfig,
  serializeTeamConfigYaml,
  validateTeamConfigDocument,
  type TeamConfigDocument,
  type TeamConfigStatusView,
} from './team-config/team-config-core.ts'
import { createTeamConfigTools } from './team-config/team-config-tools.ts'
import { applyPresetToTeamConfig } from './team-config/presets.ts'
import {
  presetApplyInputSchema,
  promptPreviewInputSchema,
  promptSaveInputSchema,
  teamConfigImportYamlInputSchema,
  type PresetApplyInput,
  type PromptPreviewInput,
  type PromptPreviewView,
  type PromptRegistryView,
  type PromptSaveInput,
  type TeamConfigImportYamlInput,
} from './team-config/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Unified hot-reloading YAML configuration store for team, pipelines, and routes. */
    dshManagerTeamConfig: DshManagerTeamConfig
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Prompt template validation or scope mutation failed. */
    'dshManager/prompt-invalid': { readonly reason: string }
  }
}

/** Configuration options for the team-config YAML store. */
export interface TeamConfigOptions {
  /** Override YAML file path; defaults to `<DSH_HOME>/dsh-manager/team-config.yaml`. */
  filePath?: string
  /** File-watch debounce in milliseconds; defaults to 60ms. */
  debounceMs?: number
}

export const TeamConfigOptions: z<TeamConfigOptions> = z.object({
  filePath: z.string(),
  debounceMs: z.natural(),
})

const DEFAULT_DEBOUNCE_MS = 60

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function resolveDshHome(ctx: Context): string {
  const profileContext = (ctx as unknown as { get?: (key: string) => unknown }).get?.('profileContext') as
    | { readonly home?: string }
    | undefined
  return profileContext?.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.tmp-${randomUUID()}`)
  try {
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

export class DshManagerTeamConfig extends TypertRemoteService {
  /** Reads legacy storage-domain tables once during first-boot migration. */
  static inject = ['storageDomain']

  static Config: z<TeamConfigOptions> = TeamConfigOptions

  private readonly filePath: string
  private readonly debounceMs: number
  private doc: TeamConfigDocument = emptyTeamConfig()
  private revision = 1
  private loadedAt = Date.now()
  private lastError: string | undefined
  private lastErrorAt: number | undefined
  private lastWrittenHash: string | undefined
  private chain: Promise<void> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly listeners = new Set<(status: TeamConfigStatusView) => void>()

  constructor(ctx: Context, config: TeamConfigOptions = {}) {
    super(ctx, 'dshManagerTeamConfig', { namespace: 'dshManager' })
    this.filePath = config.filePath ?? join(resolveDshHome(ctx), 'dsh-manager', 'team-config.yaml')
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  protected async [Service.init](): Promise<void> {
    await this.loadOrMigrate()
    await this.startWatcher()
    this.ctx.effect(() => () => {
      this.closed = true
      if (this.debounceTimer !== undefined) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = undefined
      }
      this.watcher?.close()
      this.watcher = undefined
    }, 'dsh-manager: close team-config watcher')

    // Register global chat/MCP tools when `tools` is available on the host.
    this.ctx.inject(['tools'], (toolsCtx) => {
      for (const tool of createTeamConfigTools(this)) {
        toolsCtx.effect(
          () => (toolsCtx as unknown as { tools: { register(def: unknown): () => void } }).tools.register(tool),
          `dsh-manager: register ${tool.name}`,
        )
      }
    })
  }

  /** Current crew members sorted by creation order. */
  crew(): readonly CrewMember[] {
    return [...this.doc.crew].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Current pipelines sorted by creation order. */
  pipelines(): readonly PipelineRecord[] {
    return [...this.doc.pipelines].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Current route rules in stable order. */
  routes(): readonly RouteRule[] {
    return [...this.doc.routes].sort((left, right) => left.order - right.order || left.createdAt - right.createdAt)
  }

  /** Immutable snapshot of the active validated configuration. */
  snapshot(): TeamConfigDocument {
    return this.doc
  }

  /** Current file path, revision counter, and last validation error (if any). */
  status(): TeamConfigStatusView {
    return {
      filePath: this.filePath,
      revision: this.revision,
      loadedAt: this.loadedAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
    }
  }

  /** Subscribe to in-process config or validation-status changes. */
  subscribe(listener: (status: TeamConfigStatusView) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Remote status query consumed by Team UI polling / refresh. */
  @Remote
  async teamConfigStatus(): Promise<TeamConfigStatusView> {
    return this.status()
  }

  /** Remote explicit reload trigger from disk (also used in tests). */
  @Remote
  async teamConfigReload(): Promise<TeamConfigStatusView> {
    return await this.reloadFromDisk()
  }

  /** Materialize an independent pipeline (and any missing crew members) from a built-in read-only preset. */
  @Remote
  async presetApply(rawInput: PresetApplyInput): Promise<{
    readonly pipeline: PipelineRecord
    readonly createdMembers: readonly CrewMember[]
    readonly status: TeamConfigStatusView
  }> {
    const input = presetApplyInputSchema.parse(rawInput)
    let createdPipeline!: PipelineRecord
    let createdMembers: readonly CrewMember[] = []
    await this.mutate((current) => {
      const result = applyPresetToTeamConfig(current, input.presetId)
      createdPipeline = result.pipeline
      createdMembers = result.createdMembers
      return result.nextDoc
    })
    return { pipeline: createdPipeline, createdMembers, status: this.status() }
  }

  /** Build the Prompt Studio registry snapshot: built-in turns, variables, current overrides, pipelines, and YAML. */
  @Remote
  async promptRegistry(): Promise<PromptRegistryView> {
    return this.buildRegistryView()
  }

  /** Save or clear prompt section overrides at global, pipeline, or stage level through the single write chain. */
  @Remote
  async promptSave(rawInput: PromptSaveInput): Promise<{ readonly status: TeamConfigStatusView; readonly registry: PromptRegistryView }> {
    const input = promptSaveInputSchema.parse(rawInput)
    try {
      await this.mutate((current) => {
        const mergeSections = (
          existing: PromptSectionsMap | undefined,
        ): PromptSectionsMap | undefined => {
          const next: Record<string, string> = { ...(existing?.sections ?? {}) }
          for (const [secId, val] of Object.entries(input.sections)) {
            if (val === null) delete next[secId]
            else next[secId] = val
          }
          return Object.keys(next).length === 0 ? undefined : { sections: next }
        }

        if (input.scope === 'global') {
          if (input.turnId === undefined) {
            throw new Error('turnId is required when scope is "global"')
          }
          const turns: Record<string, PromptSectionsMap | undefined> = { ...(current.prompts?.turns ?? {}) }
          const merged = mergeSections(turns[input.turnId])
          if (merged === undefined) delete turns[input.turnId]
          else turns[input.turnId] = merged
          const hasAnyTurn = Object.values(turns).some(t => t?.sections !== undefined && Object.keys(t.sections).length > 0)
          const nextDoc: TeamConfigDocument = {
            version: current.version,
            crew: current.crew,
            pipelines: current.pipelines,
            routes: current.routes,
            ...(hasAnyTurn ? { prompts: { turns } as GlobalPromptsConfig } : {}),
          }
          return nextDoc
        }

        if (input.pipelineId === undefined) {
          throw new Error(`pipelineId is required when scope is "${input.scope}"`)
        }
        const targetPipeline = current.pipelines.find(p => p.id === input.pipelineId)
        if (targetPipeline === undefined) {
          throw new Error(`pipeline "${input.pipelineId}" does not exist`)
        }
        const now = Date.now()
        const pipelines = current.pipelines.map((p) => {
          if (p.id !== input.pipelineId) return p
          if (input.scope === 'pipeline') {
            const nextPrompt = mergeSections(p.prompt)
            const { prompt: _old, ...rest } = p
            return {
              ...rest,
              ...(nextPrompt === undefined ? {} : { prompt: nextPrompt }),
              updatedAt: now,
            }
          }
          if (input.stageIndex === undefined || input.stageIndex < 0 || input.stageIndex >= p.stages.length) {
            throw new Error(`pipeline "${input.pipelineId}" has no stage at index ${String(input.stageIndex)}`)
          }
          const stages = p.stages.map((st, idx) => {
            if (idx !== input.stageIndex) return st
            const nextPrompt = mergeSections(st.prompt)
            const { prompt: _old, ...rest } = st
            return {
              ...rest,
              ...(nextPrompt === undefined ? {} : { prompt: nextPrompt }),
            }
          })
          return { ...p, stages, updatedAt: now }
        })
        return { ...current, pipelines }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/prompt-invalid', reason, { reason })
    }
    return { status: this.status(), registry: this.buildRegistryView() }
  }

  /** Validate and import a pasted `team-config.yaml` string atomically through the shared parser/validator. */
  @Remote
  async teamConfigImportYaml(rawInput: TeamConfigImportYamlInput): Promise<{ readonly status: TeamConfigStatusView; readonly registry: PromptRegistryView }> {
    const input = teamConfigImportYamlInputSchema.parse(rawInput)
    try {
      const parsed = parseTeamConfigYaml(input.yaml)
      await this.mutate(() => parsed)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/prompt-invalid', reason, { reason })
    }
    return { status: this.status(), registry: this.buildRegistryView() }
  }

    private applyDraftSections(
    existing: Readonly<Record<string, string>> | undefined,
    drafts: Readonly<Record<string, string | null>> | undefined,
  ): PromptSectionsMap | undefined {
    if (drafts === undefined) {
      return existing === undefined ? undefined : { sections: existing }
    }
    const merged: Record<string, string> = { ...(existing ?? {}) }
    for (const [secId, val] of Object.entries(drafts)) {
      if (val === null) {
        delete merged[secId]
      } else {
        merged[secId] = val
      }
    }
    return Object.keys(merged).length === 0 ? undefined : { sections: merged }
  }

/** Render a live preview of `turnId` against real project facts, ticket (or sample context), and draft edits. */
  @Remote
  async promptRenderPreview(rawInput: PromptPreviewInput): Promise<PromptPreviewView> {
    const input = promptPreviewInputSchema.parse(rawInput)
    const doc = this.doc
    const pipeline = input.pipelineId === undefined
      ? undefined
      : doc.pipelines.find(p => p.id === input.pipelineId)
    const stageIndex = input.stageIndex ?? (pipeline !== undefined && pipeline.stages.length > 0 ? 0 : undefined)
    const stage = pipeline !== undefined && stageIndex !== undefined
      ? pipeline.stages[stageIndex]
      : undefined
    const member = stage === undefined
      ? undefined
      : doc.crew.find(m => m.id === stage.memberId)

    const boardSvc = (this.ctx as unknown as {
      get?: (key: string) => { ticketRecord?: (id: string) => TicketRecord | undefined } | undefined
    }).get?.('dshManagerBoard')
    const realTicket = input.ticketId === undefined ? undefined : boardSvc?.ticketRecord?.(input.ticketId)
    const ticket: TicketRecord = realTicket ?? {
      id: 'ticket-sample-1',
      title: 'Sample preview ticket',
      state: 'todo',
      threadId: 'thread-sample-1',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      mandate: {
        scope: 'Implement feature or verify repository changes',
        strength: 'explicit',
        policyVersion: '1',
      },
      acceptanceCriteria: 'All verification gates pass',
      ...(pipeline !== undefined && stageIndex !== undefined
        ? {
            flow: {
              pipelineId: pipeline.id,
              pipelineName: pipeline.name,
              stageIndex,
              stageCount: pipeline.stages.length,
            },
          }
        : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const resolvedProjectId = input.projectId ?? realTicket?.projectId
    const workspaceSvc = (this.ctx as unknown as {
      get?: (key: string) => {
        get?: (id: WorkspaceId) => { readonly id: string; readonly title?: string; readonly path: string } | undefined
      } | undefined
    }).get?.('workspaceRegistry')
    const workspace = resolvedProjectId === undefined ? undefined : workspaceSvc?.get?.(resolvedProjectId as WorkspaceId)
    const subprocessSvc = (this.ctx as unknown as {
      get?: (key: string) => unknown
    }).get?.('subprocess')

    const cwd = workspace?.path ?? process.cwd()
    const skills = workspace === undefined ? [] : await discoverWorkspaceSkills(workspace.path).catch(() => [])
    const landingFacts = workspace !== undefined && subprocessSvc !== undefined
      ? await discoverProjectLandingFacts(subprocessSvc as never, workspace.path).catch(() => undefined)
      : undefined
    const projectFacts = workspace === undefined
      ? undefined
      : await probeProjectFacts(workspace.path, landingFacts).catch(() => undefined)

    const hasDrafts = input.draftSections !== undefined

    // Apply draft sections (including `null` deletions) at the targeted scope.
    let effectiveConfig: TeamConfigDocument = doc
    if (input.pipelineId === undefined && hasDrafts) {
      const nextMap = this.applyDraftSections(doc.prompts?.turns?.[input.turnId]?.sections, input.draftSections)
      const nextTurns = { ...(doc.prompts?.turns ?? {}) }
      if (nextMap === undefined) delete nextTurns[input.turnId]
      else nextTurns[input.turnId] = nextMap
      const { prompts: _omitted, ...restDoc } = doc
      effectiveConfig = Object.keys(nextTurns).length === 0
        ? restDoc
        : { ...restDoc, prompts: { turns: nextTurns } }
    }
    let effectivePipeline = pipeline
    if (pipeline !== undefined && input.pipelineId !== undefined && input.stageIndex === undefined && hasDrafts) {
      const nextPrompt = this.applyDraftSections(pipeline.prompt?.sections, input.draftSections)
      const { prompt: _omitted, ...rest } = pipeline
      effectivePipeline = nextPrompt === undefined ? rest : { ...rest, prompt: nextPrompt }
    }
    let effectiveStage = stage
    if (stage !== undefined && input.stageIndex !== undefined && hasDrafts) {
      const nextPrompt = this.applyDraftSections(stage.prompt?.sections, input.draftSections)
      const { prompt: _omitted, ...rest } = stage
      effectiveStage = nextPrompt === undefined ? rest : { ...rest, prompt: nextPrompt }
    }

    const stageMode = stage?.mode ?? 'execute'
    const scratchDir = workspace === undefined ? undefined : `${workspace.path}/.dsh-scratch/${ticket.id}`
    const landingLines = landingFacts === undefined ? [] : formatLandingDiscoveryPromptLines(landingFacts)

    const ctx = buildPromptContext({
      ticket,
      ...(pipeline === undefined ? {} : { pipeline }),
      ...(stage === undefined ? {} : { stage }),
      ...(member === undefined ? {} : { member }),
      ...(stageIndex === undefined ? {} : { stageIndex }),
      ...(pipeline === undefined ? {} : { stageCount: pipeline.stages.length }),
      ...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
      ...(workspace?.title === undefined ? {} : { projectName: workspace.title }),
      ...(workspace === undefined ? {} : { projectRoot: workspace.path }),
      ...(projectFacts === undefined ? {} : { projectFacts }),
      ...(landingFacts === undefined ? {} : { landingFacts }),
      skills,
      landingLines,
      cwd,
      ...(scratchDir === undefined ? {} : { scratchDir }),
      stageMode,
      evalId: 'eval-sample-1',
      dispatchId: 'dispatch-sample-1',
      batchCount: 1,
      portfolioLines: ['Portfolio tickets: none'],
      ruleLines: doc.routes.map(r => `- rule ${r.id}: ${r.condition}`),
      triggerLines: ['- [SAMPLE-1] https://example.invalid/1'],
      dataBlocks: {
        items: ['Items:', '1. thread thread-sample-1 (eval eval-sample-1)'],
        triggers: ['Triggers:', '- [SAMPLE-1] https://example.invalid/1'],
        decisions: ['Decision records (binding):', '- none recorded'],
        portfolio: ['Portfolio tickets: none'],
        rules: doc.routes.length > 0
          ? ['Configured route rules:', ...doc.routes.map(r => `- rule ${r.id}: ${r.condition}`)]
          : ['Configured route rules: none'],
        context: [`Mandate scope: ${ticket.mandate?.scope ?? 'sample'}`],
        reports: ['The executor\'s summary report:\nSample ready report.'],
        trigger: ['Trigger: [SAMPLE-1] merge request (merged) — https://example.invalid/1'],
      },
    })

    const resolved = resolveSections(input.turnId as TurnId, {
      config: effectiveConfig,
      ...(effectivePipeline === undefined ? {} : { pipeline: effectivePipeline }),
      ...(effectiveStage === undefined ? {} : { stage: effectiveStage }),
      variants: ctx.variants,
    })

    const rendered = renderTurn(input.turnId as TurnId, ctx, resolved)
    return {
      turnId: rendered.turnId,
      text: rendered.text,
      truncated: rendered.truncated,
      sections: resolved.map((sec) => {
        const renderedSec = rendered.sections.find(r => r.id === sec.id)
        return {
          id: sec.id,
          label: sec.label,
          text: renderedSec?.text ?? sec.text,
          defaultText: sec.defaultText,
          source: sec.source,
          locked: sec.locked,
        }
      }),
      missingVars: rendered.missingVars,
      unknownVars: rendered.unknownVars,
      ...(workspace === undefined
        ? {}
        : {
            resolvedProject: {
              id: workspace.id,
              name: workspace.title ?? workspace.id,
              root: workspace.path,
            },
          }),
    }
  }

  private buildRegistryView(): PromptRegistryView {
    const doc = this.doc
    const membersById = new Map(doc.crew.map(m => [m.id, m]))
    return {
      turns: TURN_IDS.map((turnId) => {
        const def = TURN_REGISTRY[turnId]
        return {
          id: def.id,
          label: def.label,
          description: def.description,
          scopeConfigurable: def.scopeConfigurable,
          sections: def.sections.map(s => ({
            id: s.id,
            label: s.label,
            description: s.description,
            defaultText: s.defaultText,
            locked: s.locked,
            ...(s.variants === undefined ? {} : { variants: s.variants }),
          })),
          dataBlocks: def.dataBlocks,
        }
      }),
      variables: PROMPT_VARIABLES,
      ...(doc.prompts === undefined ? {} : { globalPrompts: doc.prompts }),
      pipelines: doc.pipelines.map(p => ({
        id: p.id,
        name: p.name,
        ...(p.prompt === undefined ? {} : { prompt: p.prompt }),
        stages: p.stages.map((st, index) => {
          const member = membersById.get(st.memberId)
          return {
            index,
            memberId: st.memberId,
            memberName: member?.name ?? st.memberId,
            ...(member?.agentKind === undefined ? {} : { memberAgentKind: member.agentKind }),
            ...(st.mode === undefined ? {} : { mode: st.mode }),
            ...(st.prompt === undefined ? {} : { prompt: st.prompt }),
          }
        }),
      })),
      yaml: serializeTeamConfigYaml(doc),
      status: this.status(),
    }
  }

  /**
   * Atomically transform, validate, persist to YAML, and publish a config
   * mutation. Serialized on a single write chain to prevent interleaved edits.
   */
  async mutate(transform: (current: TeamConfigDocument) => TeamConfigDocument): Promise<TeamConfigDocument> {
    return await this.enqueue(async () => {
      const next = validateTeamConfigDocument(transform(this.doc))
      const yamlText = serializeTeamConfigYaml(next)
      const hash = sha256(yamlText)
      await writeTextAtomic(this.filePath, yamlText)
      this.lastWrittenHash = hash
      this.doc = next
      this.revision += 1
      this.loadedAt = Date.now()
      this.lastError = undefined
      this.lastErrorAt = undefined
      this.emitChange()
      return next
    })
  }

  /** Re-read `team-config.yaml` from disk, applying atomically or preserving the previous valid state on error. */
  async reloadFromDisk(): Promise<TeamConfigStatusView> {
    return await this.enqueue(async () => {
      await this.applyFromDisk('reload')
      return this.status()
    })
  }

  private async loadOrMigrate(): Promise<void> {
    let existingText: string | undefined
    try {
      existingText = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.recordFailure(`failed to read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    if (existingText !== undefined) {
      await this.applyYamlText(existingText)
      return
    }

    // First-boot migration from legacy storage-domain tables (if any records exist).
    const migrated = await this.readLegacyDomains()
    const yamlText = serializeTeamConfigYaml(migrated)
    const hash = sha256(yamlText)
    await writeTextAtomic(this.filePath, yamlText)
    this.lastWrittenHash = hash
    this.doc = migrated
    this.loadedAt = Date.now()
    this.lastError = undefined
    this.lastErrorAt = undefined
  }

  private async readLegacyDomains(): Promise<TeamConfigDocument> {
    const crewDom = await this.ctx.storageDomain.open(crewDomain)
    const pipelineDom = await this.ctx.storageDomain.open(pipelineDomain)
    const routeDom = await this.ctx.storageDomain.open(routeDomain)
    try {
      const crew = [...crewDom.table('members').entries()].map(([, record]) => record)
      const pipelines = [...pipelineDom.table('pipelines').entries()].map(([, record]) => record)
      const routes = [...routeDom.table('rules').entries()].map(([, record]) => record)
      if (crew.length === 0 && pipelines.length === 0 && routes.length === 0) {
        return emptyTeamConfig()
      }
      const { doc, warnings } = sanitizeLegacyTeamConfig({ crew, pipelines, routes })
      for (const warning of warnings) {
        this.ctx.logger?.warn('dsh-manager team-config migration: %s', warning)
      }
      return doc
    } finally {
      await Promise.allSettled([crewDom.close(), pipelineDom.close(), routeDom.close()])
    }
  }

  private async startWatcher(): Promise<void> {
    const dir = dirname(this.filePath)
    const targetName = basename(this.filePath)
    await mkdir(dir, { recursive: true })
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (this.closed) return
        if (filename !== null && filename !== undefined && String(filename) !== targetName) return
        if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined
          if (!this.closed) void this.reloadFromDisk()
        }, this.debounceMs)
      })
      this.watcher.on('error', (error) => {
        this.ctx.logger?.warn('dsh-manager team-config watcher error: %s', error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      this.ctx.logger?.warn('dsh-manager team-config watcher unavailable: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private async applyFromDisk(source: 'watch' | 'reload'): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recordFailure(`team-config file missing: ${this.filePath}`)
        return
      }
      this.recordFailure(`failed to read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const hash = sha256(text)
    if (hash === this.lastWrittenHash && this.lastError === undefined) {
      return
    }
    await this.applyYamlText(text, hash, source)
  }

  private async applyYamlText(text: string, hash = sha256(text), _source: 'boot' | 'watch' | 'reload' = 'boot'): Promise<void> {
    try {
      const parsed = parseTeamConfigYaml(text)
      this.doc = parsed
      this.lastWrittenHash = hash
      this.revision += 1
      this.loadedAt = Date.now()
      this.lastError = undefined
      this.lastErrorAt = undefined
      this.emitChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordFailure(message)
    }
  }

  private recordFailure(message: string): void {
    this.lastError = message
    this.lastErrorAt = Date.now()
    this.revision += 1
    this.ctx.logger?.warn('dsh-manager team-config validation failed (keeping previous valid config): %s', message)
    this.emitChange()
  }

  private emitChange(): void {
    const current = this.status()
    for (const listener of this.listeners) {
      try {
        listener(current)
      } catch {
        // Listener errors never break the config store.
      }
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }
}

export default DshManagerTeamConfig
