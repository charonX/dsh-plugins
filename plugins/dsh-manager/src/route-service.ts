/**
 * The route facility: allocation rules backed by the unified team-config YAML
 * store. Rules map a natural-language condition to a pipeline; the Steward
 * matches ticket summaries against the enabled rules at accept time, and
 * nothing matching hands the ticket to a human with a suggestion to add a rule.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { routeRule, type RouteRule } from './route/route-core.ts'
import type {} from './team-config-service.ts'
import { pipelineIdSchema, type PipelineIdInput } from './pipeline/wire-types.ts'
import {
  routeIdSchema,
  routeInputSchema,
  routeUpdateInputSchema,
  type RouteIdInput,
  type RouteInput,
  type RouteRuleView,
  type RouteUpdateInput,
} from './route/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The route API served to the Dsh Manager client. */
    dshManagerRoute: DshManagerRoute
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed route rule does not exist. */
    'dshManager/rule-not-found': { readonly ruleId: string }
    /** The rule references a pipeline that does not exist. */
    'dshManager/rule-pipeline-unknown': { readonly pipelineId: string }
  }
}

/** Route facet configuration. */
export interface RouteConfig {}

export const RouteConfig: z<RouteConfig> = z.object({})

export class DshManagerRoute extends TypertRemoteService {
  /** Host facilities the route reads; the pipeline validates the reference. */
  static inject = ['dshManagerTeamConfig', 'dshManagerPipeline']

  static Config: z<RouteConfig> = RouteConfig

  constructor(ctx: Context, config: RouteConfig) {
    super(ctx, 'dshManagerRoute', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {}

  /** The rules in their stable order: the rules list and the mindmap read this. */
  @Remote
  async ruleList(): Promise<{ readonly rules: readonly RouteRuleView[] }> {
    return { rules: this.list() }
  }

  /** Create one rule; the pipeline must exist. */
  @Remote
  async ruleAdd(rawInput: RouteInput): Promise<{ readonly rule: RouteRuleView }> {
    const input = routeInputSchema.parse(rawInput)
    this.ctx.dshManagerPipeline.require(input.pipelineId)
    const now = Date.now()
    const record = routeRule.parse({
      id: `route-${crypto.randomUUID()}`,
      condition: input.condition,
      pipelineId: input.pipelineId,
      enabled: input.enabled ?? true,
      order: this.list().length,
      createdAt: now,
      updatedAt: now,
    })
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      routes: [...doc.routes, record],
    }))
    return { rule: record }
  }

  /** Edit one rule's facts; the rule must exist. */
  @Remote
  async ruleUpdate(rawInput: RouteUpdateInput): Promise<{ readonly rule: RouteRuleView }> {
    const input = routeUpdateInputSchema.parse(rawInput)
    const current = this.require(input.ruleId)
    if (input.pipelineId !== undefined) this.ctx.dshManagerPipeline.require(input.pipelineId)
    const next = routeRule.parse({
      ...current,
      ...(input.condition === undefined ? {} : { condition: input.condition }),
      ...(input.pipelineId === undefined ? {} : { pipelineId: input.pipelineId }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: Date.now(),
    })
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      routes: doc.routes.map(item => (item.id === next.id ? next : item)),
    }))
    return { rule: next }
  }

  /** Remove one rule. */
  @Remote
  async ruleRemove(rawInput: RouteIdInput): Promise<{ readonly removed: boolean }> {
    const { ruleId } = routeIdSchema.parse(rawInput)
    this.require(ruleId)
    await this.ctx.dshManagerTeamConfig.mutate(doc => ({
      ...doc,
      routes: doc.routes.filter(item => item.id !== ruleId),
    }))
    return { removed: true }
  }

  /** The rules referencing a pipeline, for the pipeline-removal confirmation. */
  @Remote
  async ruleReferencesOfPipeline(rawInput: PipelineIdInput): Promise<{ readonly rules: readonly string[] }> {
    const { pipelineId } = pipelineIdSchema.parse(rawInput)
    return { rules: this.list().filter(rule => rule.pipelineId === pipelineId).map(rule => rule.condition) }
  }

  /** The rules, in their stable order; the Steward's matcher reads this. */
  list(): readonly RouteRule[] {
    return this.ctx.dshManagerTeamConfig.routes()
  }

  /** One rule by id, or a RemoteError the client renders. */
  require(ruleId: string): RouteRule {
    const record = this.ctx.dshManagerTeamConfig.routes().find(item => item.id === ruleId)
    if (record === undefined) {
      throw new RemoteError('dshManager/rule-not-found', `route rule ${ruleId} does not exist`, { ruleId })
    }
    return record
  }
}

export default DshManagerRoute
