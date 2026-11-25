/**
 * The flow core's aggregation: chain resolution over the follow-up links,
 * the accumulated skip reasons, and the markdown mirror's render.
 */
import { describe, expect, test } from 'vitest'
import type { TicketRecord } from '../../src/board-domain.ts'
import { flowChain, flowTimelineOf, renderFlowMarkdown } from '../../src/flow/flow-core.ts'

/** One minimal ticket record with only the fields the chain reads. */
function ticket(id: string, extra: Partial<TicketRecord> & { flow?: TicketRecord['flow'] }): TicketRecord {
  return {
    id,
    title: extra.title ?? `ticket ${id}`,
    threadId: '',
    state: 'todo',
    createdAt: extra.createdAt ?? 0,
    updatedAt: 0,
    ...extra,
  } as TicketRecord
}

const FLOW = { pipelineId: 'pipe-1', pipelineName: '开发线', stageCount: 3 }

describe('flowChain', () => {
  test('a routed root without follow-ups reads as a one-stage chain', () => {
    const records = [ticket('root', { flow: { ...FLOW, stageIndex: 0 } })]
    const chain = flowChain(records, 'root')
    expect(chain?.root.id).toBe('root')
    expect(chain?.stages.map(stage => stage.id)).toEqual(['root'])
  })

  test('a stage ticket resolves its root through the follow-up links', () => {
    const records = [
      ticket('stage-2', { flow: { ...FLOW, stageIndex: 2 }, createdAt: 3, followUpOf: 'stage-1' }),
      ticket('stage-1', { flow: { ...FLOW, stageIndex: 1 }, createdAt: 2, followUpOf: 'root' }),
      ticket('root', { flow: { ...FLOW, stageIndex: 0 }, createdAt: 1 }),
    ]
    const chain = flowChain(records, 'stage-2')
    expect(chain?.root.id).toBe('root')
    expect(chain?.stages.map(stage => stage.id)).toEqual(['root', 'stage-1', 'stage-2'])
  })

  test('follow-ups without a flow annotation (plain follow-up work) stay off the walk', () => {
    const records = [
      ticket('side', { createdAt: 4, followUpOf: 'root' }),
      ticket('stage-1', { flow: { ...FLOW, stageIndex: 1 }, createdAt: 2, followUpOf: 'root' }),
      ticket('root', { flow: { ...FLOW, stageIndex: 0 }, createdAt: 1 }),
    ]
    const chain = flowChain(records, 'side')
    // `side` walks up to the root and still reads the walk…
    expect(chain?.stages.map(stage => stage.id)).toEqual(['root', 'stage-1'])
    // …but the walk's own chain never picks the un-annotated follow-up up.
    const fromRoot = flowChain(records, 'root')
    expect(fromRoot?.stages.map(stage => stage.id)).toEqual(['root', 'stage-1'])
  })

  test('a follow-up whose root walks no pipeline reads as no chain', () => {
    const records = [ticket('plain', { followUpOf: 'root' }), ticket('root', {})]
    expect(flowChain(records, 'plain')).toBeUndefined()
    expect(flowChain([], 'plain')).toBeUndefined()
  })

  test('a corrupted follow-up link does not loop forever', () => {
    const records = [
      ticket('a', { flow: { ...FLOW, stageIndex: 0 }, followUpOf: 'b' }),
      ticket('b', { flow: { ...FLOW, stageIndex: 1 }, followUpOf: 'a' }),
    ]
    const chain = flowChain(records, 'a')
    expect(chain).toBeDefined()
  })
})

describe('flowTimelineOf', () => {
  test('the skipped reasons accumulate across the chain and the pending skip surfaces', () => {
    const records = [
      ticket('root', { flow: { ...FLOW, stageIndex: 0, skipped: [{ stageIndex: 1, reason: 'docs not needed' }] } }),
      ticket('stage-1', { flow: { ...FLOW, stageIndex: 1, skipped: [{ stageIndex: 1, reason: 'docs not needed' }], pendingSkip: { stageIndex: 2, reason: 'review already done' } }, followUpOf: 'root' }),
    ]
    const chain = flowChain(records, 'root')!
    const view = flowTimelineOf(chain)
    expect(view.rootTicketId).toBe('root')
    expect(view.pipelineName).toBe('开发线')
    expect(view.stages.map(stage => stage.stageIndex)).toEqual([0, 1])
    expect(view.skipped).toEqual([{ stageIndex: 1, reason: 'docs not needed' }])
    expect(view.pendingSkip).toEqual({ stageIndex: 2, reason: 'review already done' })
  })

  test('the decorator attaches reports and deliverables per stage', () => {
    const records = [ticket('root', { flow: { ...FLOW, stageIndex: 0 } })]
    const chain = flowChain(records, 'root')!
    const view = flowTimelineOf(chain, stage => stage.id === 'root'
      ? { readyReport: 'the stage work is complete', deliverables: ['stage-note.md'] }
      : {})
    expect(view.stages[0]).toMatchObject({
      ticketId: 'root',
      title: 'ticket root',
      state: 'todo',
      stageIndex: 0,
      readyReport: 'the stage work is complete',
      deliverables: ['stage-note.md'],
    })
  })

  test('resolvePipeline projects live pipeline name and stage count over initial snapshot', () => {
    const records = [
      ticket('root', { flow: { ...FLOW, stageIndex: 0 } }),
      ticket('stage-1', { flow: { ...FLOW, stageIndex: 1 }, followUpOf: 'root' }),
    ]
    const chain = flowChain(records, 'root')!
    const expanded = flowTimelineOf(chain, undefined, () => ({ name: '新流水线', stageCount: 5 }))
    expect(expanded.pipelineName).toBe('新流水线')
    expect(expanded.stageCount).toBe(5)

    // Even if shortened below max seen stage index, stageCount never drops below observed stages.
    const shortened = flowTimelineOf(chain, undefined, () => ({ name: '短线', stageCount: 1 }))
    expect(shortened.stageCount).toBe(2)
  })
})

describe('renderFlowMarkdown', () => {
  test('the mirror shows the walk, the skip reasons, and the deliverables', () => {
    const records = [
      ticket('root', { title: 'Accepted work', state: 'running', flow: { ...FLOW, stageIndex: 0, skipped: [{ stageIndex: 1, reason: 'docs not needed' }] } }),
      ticket('stage-1', { title: 'final check', state: 'ended', flow: { ...FLOW, stageIndex: 2, skipped: [{ stageIndex: 1, reason: 'docs not needed' }] }, followUpOf: 'root' }),
    ]
    const chain = flowChain(records, 'root')!
    const view = flowTimelineOf(chain, stage => stage.id === 'stage-1'
      ? { readyReport: 'the stage work is complete', deliverables: ['stage-note.md'] }
      : {})
    const markdown = renderFlowMarkdown(view)
    expect(markdown).toContain('# 流程进度：开发线')
    expect(markdown).toContain('第 2 环节：docs not needed')
    expect(markdown).toContain('the stage work is complete')
    expect(markdown).toContain('产出物：stage-note.md')
    expect(markdown).toContain('已结束 1')
  })

  test('a pending skip shows as awaiting approval', () => {
    const records = [ticket('root', { flow: { ...FLOW, stageIndex: 0, pendingSkip: { stageIndex: 1, reason: 'docs not needed' } } })]
    const chain = flowChain(records, 'root')!
    const markdown = renderFlowMarkdown(flowTimelineOf(chain))
    expect(markdown).toContain('待审批跳过：第 2 环节')
  })
})
