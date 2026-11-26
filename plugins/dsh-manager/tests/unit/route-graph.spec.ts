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
