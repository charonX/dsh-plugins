/** Unit tests for Flow IR topology layout (entry -> flow -> steps + onFail rework arcs). */
import { describe, expect, test } from 'vitest'
import type { FlowDef } from '../../src/flow/flow-ir.ts'
import { connectedNodeIds, layoutFlowMap, roundedOrthogonalPath } from '../../src/client/route-graph.ts'

describe('route-graph (layoutFlowMap)', () => {
  test('lays out enabled flows with steps and onFail rework edges', () => {
    const flows: FlowDef[] = [
      {
        id: 'f1',
        name: '知识创作',
        enabled: true,
        when: '文章与笔记创作',
        workspaceMode: 'in-place',
        steps: [
          { id: 'research', name: '资料梳理', skills: ['how'], readOnly: true },
          { id: 'draft', name: '撰写正文', skills: [] },
          { id: 'check', name: '质量自检', skills: [], readOnly: true, onFail: 'draft', humanConfirm: true },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'f2',
        name: '停用流程',
        enabled: false,
        when: 'disabled',
        workspaceMode: 'in-place',
        steps: [{ id: 's1', name: 'S1', skills: [] }],
        createdAt: 2,
        updatedAt: 2,
      },
    ]

    const map = layoutFlowMap({
      rootTitle: '收到任务',
      reworkLabel: '失败打回',
      readOnlyLabel: '只读',
      confirmLabel: '确认',
      flows,
    })

    expect(map.nodes.find(n => n.id === 'entry-root')).toBeDefined()
    expect(map.nodes.filter(n => n.kind === 'flow')).toHaveLength(1)
    expect(map.nodes.filter(n => n.kind === 'step')).toHaveLength(3)

    const reworkEdge = map.edges.find(e => e.kind === 'rework')
    expect(reworkEdge).toBeDefined()
    expect(reworkEdge?.from).toBe('step-f1-check')
    expect(reworkEdge?.to).toBe('step-f1-draft')
    expect(roundedOrthogonalPath(reworkEdge!.points)).toContain('Q ')

    const connected = connectedNodeIds('step-f1-check', map.edges)
    expect(connected.has('step-f1-draft')).toBe(true)
  })
})

describe('route-graph edges', () => {
  const flow = (id: string, name: string): FlowDef => ({
    id,
    name,
    enabled: true,
    when: name,
    workspaceMode: 'in-place',
    steps: [{ id: `${id}-s1`, name: 'S1', skills: [] }],
    createdAt: 1,
    updatedAt: 1,
  })

  test('every connector leaves and enters a node on an axis, never diagonally', () => {
    const map = layoutFlowMap({
      rootTitle: '收到任务',
      reworkLabel: '失败打回',
      readOnlyLabel: '只读',
      confirmLabel: '确认',
      flows: [flow('f1', '流程一'), flow('f2', '流程二')],
    })
    const entryEdges = map.edges.filter(e => e.id.startsWith('edge-entry-'))
    expect(entryEdges).toHaveLength(2)
    for (const edge of map.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < edge.points.length; i += 1) {
        const a = edge.points[i - 1]!
        const b = edge.points[i]!
        // An orthogonal connector only changes x or only changes y per segment.
        expect(a.x === b.x || a.y === b.y).toBe(true)
      }
    }
  })
})
