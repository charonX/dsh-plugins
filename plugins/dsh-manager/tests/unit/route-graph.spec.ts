/**
 * The rule map layout core: left-to-right mindmap construction — entry on the
 * far left, enabled rules stacked in column 1, shared pipelines converged in
 * column 2, horizontal stage chains extending rightward, and arched dashed
 * skip routes above skippable stages.
 */
import { describe, expect, test } from 'vitest'
import { clampLine, connectedNodeIds, layoutRouteMap, roundedOrthogonalPath, type RouteMapInput } from '../../src/client/route-graph.ts'

/** One two-stage catalog: a skippable first stage followed by a required stage. */
function input(overrides: Partial<RouteMapInput> = {}): RouteMapInput {
  return {
    rootTitle: '收到任务',
    skipLabel: '可跳过',
    unknownMember: '未知队员',
    stageCountLabel: count => `${count} 个环节`,
    rules: [
      { id: 'r1', condition: '开发类任务，需要改代码', pipelineId: 'p1' },
    ],
    pipelines: [
      {
        id: 'p1',
        name: '开发线',
        stages: [
          { memberId: 'm1', instruction: 'draft the note', skippable: true },
          { memberId: 'm2' },
        ],
      },
    ],
    memberName: memberId => (memberId === 'm1' ? '产品小王' : '全栈小李'),
    ...overrides,
  }
}

describe('layoutRouteMap', () => {
  test('one rule lays out entry → rule → pipeline → horizontal stage chain left to right', () => {
    const layout = layoutRouteMap(input())
    const kinds = layout.nodes.map(node => node.kind)
    expect(kinds).toEqual(['entry', 'rule', 'pipeline', 'stage', 'stage'])
    const entry = layout.nodes.find(node => node.kind === 'entry')!
    const rule = layout.nodes.find(node => node.kind === 'rule')!
    expect(rule.title).toBe('开发类任务，需要改代码')
    const pipeline = layout.nodes.find(node => node.kind === 'pipeline')!
    expect(pipeline.subtitle).toBe('2 个环节')
    const stage1 = layout.nodes.find(node => node.id === 'stage-pipe:p1-0')!
    expect(stage1.title).toBe('1. 产品小王')
    expect(stage1.badge).toBe('可跳过')
    const stage2 = layout.nodes.find(node => node.id === 'stage-pipe:p1-1')!
    expect(stage2.badge).toBeUndefined()
    // Left-to-right columns: entry < rule < pipeline < stage1 < stage2, while stages share one horizontal row.
    expect(entry.x).toBeLessThan(rule.x)
    expect(rule.x).toBeLessThan(pipeline.x)
    expect(pipeline.x).toBeLessThan(stage1.x)
    expect(stage2.x).toBeGreaterThan(stage1.x)
    expect(stage2.y).toBe(stage1.y)
  })

  test('the entry node centers vertically on the left and fans out to stacked rules converging into shared pipelines', () => {
    const manyRules = input({
      rules: [
        { id: 'r1', condition: 'first', pipelineId: 'p1' },
        { id: 'r2', condition: 'second', pipelineId: 'p1' },
        { id: 'r3', condition: 'third', pipelineId: 'p1' },
      ],
    })
    const layout = layoutRouteMap(manyRules)
    const entry = layout.nodes.find(node => node.kind === 'entry')!
    const entryCenterY = entry.y + entry.height / 2
    const rules = layout.nodes.filter(node => node.kind === 'rule')
    expect(rules.map(rule => rule.title)).toEqual(['first', 'second', 'third'])
    // Rules stack vertically in one column; the middle rule aligns with the entry vertical center.
    expect(rules[0]!.x).toBe(rules[1]!.x)
    expect(rules[1]!.x).toBe(rules[2]!.x)
    expect(rules[0]!.y).toBeLessThan(rules[1]!.y)
    expect(rules[1]!.y).toBeLessThan(rules[2]!.y)
    expect(Math.abs(entryCenterY - (rules[1]!.y + rules[1]!.height / 2))).toBeLessThan(1)
    // All 3 rules converge into the single shared pipeline node.
    expect(layout.nodes.filter(node => node.kind === 'pipeline')).toHaveLength(1)
    const entryEdges = layout.edges.filter(edge => edge.from === 'entry')
    expect(entryEdges).toHaveLength(3)
    expect(entryEdges.map(edge => edge.to)).toEqual(['rule-r1', 'rule-r2', 'rule-r3'])
  })

  test('a skippable stage that is not last carries the arched dashed bypass route above the stage row', () => {
    const layout = layoutRouteMap(input())
    const skipEdges = layout.edges.filter(edge => edge.kind === 'skip')
    expect(skipEdges).toHaveLength(1)
    expect(skipEdges[0]!.from).toBe('stage-pipe:p1-0')
    expect(skipEdges[0]!.to).toBe('stage-pipe:p1-1')
    expect(skipEdges[0]!.label).toBe('可跳过')
    const stage1 = layout.nodes.find(node => node.id === 'stage-pipe:p1-0')!
    const points = skipEdges[0]!.points
    // Bypass rises above the stage card's top edge and stays inside positive y coordinates.
    expect(points[0]!.y).toBe(stage1.y)
    expect(points[1]!.y).toBeLessThan(stage1.y)
    expect(points[1]!.y).toBeGreaterThan(0)
    const lastSkippable = layoutRouteMap(input({
      pipelines: [{ id: 'p1', name: '开发线', stages: [{ memberId: 'm1' }, { memberId: 'm1', skippable: true }] }],
    }))
    expect(lastSkippable.edges.filter(edge => edge.kind === 'skip')).toHaveLength(0)
  })

  test('a rule whose pipeline vanished degrades to an empty pipeline node', () => {
    const layout = layoutRouteMap(input({
      rules: [{ id: 'r1', condition: 'orphan', pipelineId: 'gone' }],
      pipelines: [],
    }))
    const pipeline = layout.nodes.find(node => node.kind === 'pipeline')!
    expect(pipeline.title).toBe('—')
    expect(pipeline.subtitle).toBe('0 个环节')
    expect(layout.nodes.filter(node => node.kind === 'stage')).toHaveLength(0)
  })

  test('an unknown member falls back to the unknown label and long lines clamp', () => {
    const layout = layoutRouteMap(input({
      pipelines: [{ id: 'p1', name: '开发线', stages: [{ memberId: 'ghost', instruction: 'x'.repeat(60) }] }],
      memberName: () => '',
    }))
    const stage = layout.nodes.find(node => node.kind === 'stage')!
    expect(stage.title).toBe('1. 未知队员')
    expect(stage.subtitle).toMatch(/…$/)
    expect(clampLine('abc')).toBe('abc')
    expect(clampLine('一二三四五六七八九十一二三四五六七八九十一二三')).toHaveLength(18)
    expect(clampLine('  a   b  ')).toBe('a b')
  })

  test('roundedOrthogonalPath generates smooth quadratic corners and connectedNodeIds traces across separate pipeline bands', () => {
    const path = roundedOrthogonalPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 100 },
    ], 10)
    expect(path).toContain('Q 50 0')
    expect(path).toContain('Q 50 100')

    const twoPipelines = input({
      rules: [
        { id: 'r1', condition: 'first', pipelineId: 'p1' },
        { id: 'r2', condition: 'second', pipelineId: 'p2' },
      ],
      pipelines: [
        { id: 'p1', name: '开发线', stages: [{ memberId: 'm1' }] },
        { id: 'p2', name: '调研线', stages: [{ memberId: 'm2' }] },
      ],
    })
    const layout = layoutRouteMap(twoPipelines)
    const traced = connectedNodeIds(layout, 'rule-r1')
    expect(traced.has('entry')).toBe(true)
    expect(traced.has('rule-r1')).toBe(true)
    expect(traced.has('pipeline-pipe:p1')).toBe(true)
    expect(traced.has('stage-pipe:p1-0')).toBe(true)
    expect(traced.has('rule-r2')).toBe(false)
    expect(traced.has('pipeline-pipe:p2')).toBe(false)
  })
})
