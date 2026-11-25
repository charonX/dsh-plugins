import { describe, expect, test } from 'vitest'
import { layoutRouteMap } from '../../src/client/route-graph.ts'
import { resolveWorkbenchSelection } from '../../src/client/workbench-model.ts'
import type { CrewMemberView } from '../../src/crew/wire-types.ts'
import type { PipelineView } from '../../src/pipeline/wire-types.ts'
import type { RouteRuleView } from '../../src/route/wire-types.ts'

const members: readonly CrewMemberView[] = [
  { id: 'm1', name: 'Product Wang', role: 'Write spec', enabled: true, createdAt: 1, updatedAt: 1 },
  { id: 'm2', name: 'Dev Li', role: 'Implement code', enabled: true, createdAt: 1, updatedAt: 1 },
]

const pipelines: readonly PipelineView[] = [
  {
    id: 'p1',
    name: 'Dev Flow',
    stages: [
      { memberId: 'm1', instruction: 'Clarify scope', skippable: true, skipLogic: 'Explicit mandate' },
      { memberId: 'm2', instruction: 'Write tests and code', skippable: false },
    ],
    createdAt: 1,
    updatedAt: 1,
  },
]

const rules: readonly RouteRuleView[] = [
  { id: 'r1', condition: 'Feature request', pipelineId: 'p1', enabled: true, order: 0, createdAt: 1, updatedAt: 1 },
]

function buildLayout(activeRules = rules) {
  return layoutRouteMap({
    rootTitle: 'Ticket received',
    skipLabel: 'Skippable',
    unknownMember: 'Unknown',
    stageCountLabel: count => `${count} stages`,
    rules: activeRules,
    pipelines,
    memberName: id => members.find(m => m.id === id)?.name ?? '',
  })
}

describe('resolveWorkbenchSelection', () => {
  test('returns undefined when selectedId is unset or vanished after hot reload', () => {
    const layout = buildLayout()
    expect(resolveWorkbenchSelection({ layout, selectedId: undefined, rules, pipelines, members })).toBeUndefined()
    expect(resolveWorkbenchSelection({ layout: buildLayout([]), selectedId: 'rule-r1', rules: [], pipelines, members })).toBeUndefined()
  })

  test('resolves entry node with read-only actions', () => {
    const layout = buildLayout()
    const selection = resolveWorkbenchSelection({ layout, selectedId: 'entry', rules, pipelines, members })
    expect(selection?.node.kind).toBe('entry')
    expect(selection?.actions).toEqual({
      canEditRule: false,
      canToggleRule: false,
      canRemoveRule: false,
      canEditPipeline: false,
      canRemovePipeline: false,
    })
  })

  test('resolves rule node with rule/pipeline links and full rule actions', () => {
    const layout = buildLayout()
    const selection = resolveWorkbenchSelection({ layout, selectedId: 'rule-r1', rules, pipelines, members })
    expect(selection?.rule?.id).toBe('r1')
    expect(selection?.pipeline?.id).toBe('p1')
    expect(selection?.actions).toEqual({
      canEditRule: true,
      canToggleRule: true,
      canRemoveRule: true,
      canEditPipeline: false,
      canRemovePipeline: false,
    })
  })

  test('resolves pipeline node with matching rules and pipeline actions', () => {
    const layout = buildLayout()
    const selection = resolveWorkbenchSelection({ layout, selectedId: 'pipeline-pipe:p1', rules, pipelines, members })
    expect(selection?.pipeline?.id).toBe('p1')
    expect(selection?.matchingRules.map(r => r.id)).toEqual(['r1'])
    expect(selection?.actions).toEqual({
      canEditRule: false,
      canToggleRule: false,
      canRemoveRule: false,
      canEditPipeline: true,
      canRemovePipeline: true,
    })
  })

  test('resolves stage node with stage, member, and pipeline edit action', () => {
    const layout = buildLayout()
    const selection = resolveWorkbenchSelection({ layout, selectedId: 'stage-pipe:p1-1', rules, pipelines, members })
    expect(selection?.pipeline?.id).toBe('p1')
    expect(selection?.stage?.instruction).toBe('Write tests and code')
    expect(selection?.member?.name).toBe('Dev Li')
    expect(selection?.actions).toEqual({
      canEditRule: false,
      canToggleRule: false,
      canRemoveRule: false,
      canEditPipeline: true,
      canRemovePipeline: false,
    })
  })
})
