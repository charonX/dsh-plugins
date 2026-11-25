/** Pure selection & capability resolver for the Topology Inspector in OrchestrationWorkbench. */
import type { CrewMemberView } from '../crew/wire-types.ts'
import type { PipelineView } from '../pipeline/wire-types.ts'
import type { RouteRuleView } from '../route/wire-types.ts'
import type { RouteMapLayout, RouteMapNode } from './route-graph.ts'

export interface WorkbenchSelection {
  readonly node: RouteMapNode
  readonly rule?: RouteRuleView
  readonly pipeline?: PipelineView
  readonly stage?: PipelineView['stages'][number]
  readonly member?: CrewMemberView
  readonly matchingRules: readonly RouteRuleView[]
  readonly actions: {
    readonly canEditRule: boolean
    readonly canToggleRule: boolean
    readonly canRemoveRule: boolean
    readonly canEditPipeline: boolean
    readonly canRemovePipeline: boolean
  }
}

const NO_ACTIONS: WorkbenchSelection['actions'] = {
  canEditRule: false,
  canToggleRule: false,
  canRemoveRule: false,
  canEditPipeline: false,
  canRemovePipeline: false,
}

/**
 * Derive the resolved domain entities and legal Inspector actions from
 * the current graph layout node and live Crew/Pipeline/Route snapshots.
 * Returns undefined if `selectedId` is unset or vanished (e.g. after hot reload).
 */
export function resolveWorkbenchSelection(input: {
  readonly layout: RouteMapLayout
  readonly selectedId: string | undefined
  readonly rules: readonly RouteRuleView[]
  readonly pipelines: readonly PipelineView[]
  readonly members: readonly CrewMemberView[]
}): WorkbenchSelection | undefined {
  const { layout, selectedId, rules, pipelines, members } = input
  if (selectedId === undefined) return undefined
  const node = layout.nodes.find(entry => entry.id === selectedId)
  if (node === undefined) return undefined

  if (node.kind === 'rule') {
    const rule = node.ruleId === undefined ? undefined : rules.find(r => r.id === node.ruleId)
    if (rule === undefined) return undefined
    const pipeline = pipelines.find(p => p.id === rule.pipelineId)
    return {
      node,
      rule,
      ...(pipeline === undefined ? {} : { pipeline }),
      matchingRules: [rule],
      actions: {
        canEditRule: true,
        canToggleRule: true,
        canRemoveRule: true,
        canEditPipeline: false,
        canRemovePipeline: false,
      },
    }
  }

  if (node.kind === 'pipeline') {
    const pipeline = node.pipelineId === undefined ? undefined : pipelines.find(p => p.id === node.pipelineId)
    const matchingRules = pipeline === undefined ? [] : rules.filter(r => r.pipelineId === pipeline.id)
    return {
      node,
      ...(pipeline === undefined ? {} : { pipeline }),
      matchingRules,
      actions: {
        canEditRule: false,
        canToggleRule: false,
        canRemoveRule: false,
        canEditPipeline: pipeline !== undefined,
        canRemovePipeline: pipeline !== undefined,
      },
    }
  }

  if (node.kind === 'stage') {
    const pipeline = node.pipelineId === undefined ? undefined : pipelines.find(p => p.id === node.pipelineId)
    const stage = pipeline !== undefined && node.stageIndex !== undefined
      ? pipeline.stages[node.stageIndex]
      : undefined
    const member = node.memberId === undefined ? undefined : members.find(m => m.id === node.memberId)
    return {
      node,
      ...(pipeline === undefined ? {} : { pipeline }),
      ...(stage === undefined ? {} : { stage }),
      ...(member === undefined ? {} : { member }),
      matchingRules: [],
      actions: {
        canEditRule: false,
        canToggleRule: false,
        canRemoveRule: false,
        canEditPipeline: pipeline !== undefined,
        canRemovePipeline: false,
      },
    }
  }

  return {
    node,
    matchingRules: [],
    actions: NO_ACTIONS,
  }
}
