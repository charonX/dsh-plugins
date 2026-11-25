/**
 * The pipeline facility: named ordered stage sequences backed by the unified
 * team-config YAML store. Stages reference crew members; the crew facility
 * checks the reference on write, and the crew removal guard reads the
 * references here.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { pipelineRecord, type PipelineRecord, type PipelineStage } from './pipeline/pipeline-core.ts'
import type {} from './team-config-service.ts'
import { crewMemberIdSchema, type CrewMemberIdInput } from './crew/wire-types.ts'
import {
  pipelineIdSchema,
  pipelineInputSchema,
  pipelineStageInputSchema,
  pipelineUpdateInputSchema,
  type PipelineIdInput,
  type PipelineInput,
  type PipelineStageInput,
  type PipelineUpdateInput,
  type PipelineView,
} from './pipeline/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pipeline API served to the Dsh Manager client. */
    dshManagerPipeline: DshManagerPipeline
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed pipeline does not exist. */
    'dshManager/pipeline-not-found': { readonly pipelineId: string }
    /** A stage references a crew member that does not exist. */
    'dshManager/pipeline-member-unknown': { readonly memberId: string }
  }
}

/** Pipeline facet configuration. */
export interface PipelineConfig {}

export const PipelineConfig: z<PipelineConfig> = z.object({})

export class DshManagerPipeline extends TypertRemoteService {
  /** Host facilities the pipeline reads; the crew validates stage references. */
  static inject = ['dshManagerTeamConfig', 'dshManagerCrew']

  static Config: z<PipelineConfig> = PipelineConfig

  constructor(ctx: Context, config: PipelineConfig) {
    super(ctx, 'dshManagerPipeline', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {}

  /** The pipelines, oldest first: the team page's stable list order. */
  @Remote
  async pipelineList(): Promise<{ readonly pipelines: readonly PipelineView[] }> {
    return { pipelines: this.list() }
  }

  /** Create one pipeline from the form facts; every stage must reference a member. */
  @Remote
  async pipelineAdd(rawInput: PipelineInput): Promise<{ readonly pipeline: PipelineView }> {
    const input = pipelineInputSchema.parse(rawInput)
    const stages = input.stages.map(stage => this.materializeStage(stage))
    const now = Date.now()
    const record = pipelineRecord.parse({
      id: `pipe-${crypto.randomUUID()}`,
      name: input.name,
      stages,
      createdAt: now,
      updatedAt: now,
    })
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      pipelines: [...doc.pipelines, record],
    }))
    return { pipeline: record }
  }

  /** Edit one pipeline's facts; the pipeline must exist. */
  @Remote
  async pipelineUpdate(rawInput: PipelineUpdateInput): Promise<{ readonly pipeline: PipelineView }> {
    const input = pipelineUpdateInputSchema.parse(rawInput)
    const current = this.require(input.pipelineId)
    const stages = input.stages === undefined
      ? current.stages
      : input.stages.map(stage => this.materializeStage(stage))
    const next = pipelineRecord.parse({
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      stages,
      updatedAt: Date.now(),
    })
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      pipelines: doc.pipelines.map(item => (item.id === next.id ? next : item)),
    }))
    return { pipeline: next }
  }

  /** Remove one pipeline and prune referencing route rules so the YAML stays consistent. */
  @Remote
  async pipelineRemove(rawInput: PipelineIdInput): Promise<{ readonly removed: boolean }> {
    const { pipelineId } = pipelineIdSchema.parse(rawInput)
    this.require(pipelineId)
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      pipelines: doc.pipelines.filter(item => item.id !== pipelineId),
      routes: doc.routes.filter(rule => rule.pipelineId !== pipelineId),
    }))
    return { removed: true }
  }

  /** The pipelines a crew removal would orphan, for the removal confirmation. */
  @Remote
  async pipelineReferencesOf(rawInput: CrewMemberIdInput): Promise<{ readonly references: readonly string[] }> {
    const { memberId } = crewMemberIdSchema.parse(rawInput)
    return { references: this.referencesOf(memberId) }
  }

  /** The pipelines a crew removal would orphan, as `name (stage N)` strings. */
  referencesOf(memberId: string): readonly string[] {
    return this.list()
      .filter(pipeline => pipeline.stages.some(stage => stage.memberId === memberId))
      .map(pipeline => {
        const index = pipeline.stages.findIndex(stage => stage.memberId === memberId)
        return `${pipeline.name} (stage ${index + 1})`
      })
  }

  /** The pipelines, oldest first; host-internal readers use this. */
  list(): readonly PipelineRecord[] {
    return this.ctx.dshManagerTeamConfig.pipelines()
  }

  /** One pipeline by id, or a RemoteError the client renders. */
  require(pipelineId: string): PipelineRecord {
    const record = this.ctx.dshManagerTeamConfig.pipelines().find(item => item.id === pipelineId)
    if (record === undefined) {
      throw new RemoteError('dshManager/pipeline-not-found', `pipeline ${pipelineId} does not exist`, { pipelineId })
    }
    return record
  }

  /** Materialize one form stage: validate the member reference and fill the defaults. */
  private materializeStage(stage: PipelineStageInput): PipelineStage {
    const parsed = pipelineStageInputSchema.parse(stage)
    // The referenced member must exist; a disabled member may stay referenced
    // but no dispatch will start from it.
    this.ctx.dshManagerCrew.require(parsed.memberId)
    return {
      memberId: parsed.memberId,
      instruction: parsed.instruction ?? '',
      skippable: parsed.skippable ?? false,
      ...(parsed.skipLogic === undefined ? {} : { skipLogic: parsed.skipLogic }),
      ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
    }
  }
}

export default DshManagerPipeline
