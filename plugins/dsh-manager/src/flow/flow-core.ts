/**
 * The flow core: aggregate one ticket's pipeline walk out of the tickets'
 * flow annotations, and render the walk's current state as markdown. The
 * chain has no storage of its own — the walk lives in the follow-up links
 * and the per-ticket flow annotations (the team model's 流程记录).
 */
import type { TicketRecord, TicketFlow } from '../board-domain.ts'

/** One ticket that carries a flow annotation. */
export type FlowTicket = TicketRecord & { readonly flow: TicketFlow }

/** One stage of the walk as the timeline sees it. */
export interface FlowStageView {
  readonly ticketId: string
  readonly title: string
  readonly state: TicketRecord['state']
  /** The zero-based stage index in the pipeline. */
  readonly stageIndex: number
  /** The crew member display name for this stage, when known. */
  readonly memberName?: string
  /** The last ready report's message, when a dispatch produced one. */
  readonly readyReport?: string
  /** The presented deliverable paths of this stage's dispatches. */
  readonly deliverables?: readonly string[]
}

/** One walk's aggregated progress. */
export interface FlowTimelineView {
  /** The walk's root: the ticket the steward routed and annotated first. */
  readonly rootTicketId: string
  readonly pipelineId: string
  readonly pipelineName: string
  readonly stageCount: number
  /** The chain's stage tickets, ordered by stage index. */
  readonly stages: readonly FlowStageView[]
  /** The stages the human approved to skip, with the steward's reasons. */
  readonly skipped: readonly { readonly stageIndex: number; readonly reason: string }[]
  /** The skip decision awaiting the human's approval, when one is pending. */
  readonly pendingSkip?: { readonly stageIndex: number; readonly reason: string }
}

/** The resolved chain behind one flow ticket. */
export interface FlowChain {
  readonly root: FlowTicket
  /** The chain's tickets from the root on, each carrying its stage's flow. */
  readonly stages: readonly FlowTicket[]
}

/**
 * Resolve the flow walk one ticket belongs to: the root is the chain head
 * the steward routed (its flow names the pipeline), the stages follow the
 * follow-up links downward and must each carry a flow annotation. A ticket
 * outside any walk reads as no chain.
 */
export function flowChain(records: readonly TicketRecord[], id: string): FlowChain | undefined {
  const byId = new Map(records.map(record => [record.id, record]))
  // Walk up to the chain head; a cycle guard keeps a corrupted link loop bounded.
  let current = byId.get(id)
  const visited = new Set<string>()
  while (current?.followUpOf !== undefined && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = byId.get(current.followUpOf)
    if (parent === undefined) break
    current = parent
  }
  if (current === undefined || current.flow === undefined) return undefined
  const root = current as FlowTicket
  // Follow the walk downward: the only flow-annotated child each ticket minted.
  const stages: FlowTicket[] = [root]
  let cursor: FlowTicket = root
  for (;;) {
    const children = records
      .filter(record => record.followUpOf === cursor.id && record.flow !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt)
    const next = children[0] as FlowTicket | undefined
    if (next === undefined || stages.includes(next)) break
    stages.push(next)
    cursor = next
  }
  return { root, stages }
}

/**
 * Aggregate one chain into its progress view: the stage tickets ordered by
 * index, the accumulated skipped stages, and the pending skip decision.
 * @param chain - the resolved walk.
 * @param decorate - per-stage extras (reports and deliverables), filled by the caller that owns them.
 */
export function flowTimelineOf(
  chain: FlowChain,
  decorate?: (ticket: FlowTicket) => { readyReport?: string; deliverables?: readonly string[] },
  resolvePipeline?: (pipelineId: string) => {
    readonly name: string
    readonly stageCount: number
    readonly stageMemberNames?: readonly (string | undefined)[]
  } | undefined,
): FlowTimelineView {
  const skipped = new Map<number, string>()
  let pendingSkip: FlowTimelineView['pendingSkip']
  for (const stage of chain.stages) {
    for (const entry of stage.flow.skipped ?? []) skipped.set(entry.stageIndex, entry.reason)
    if (stage.flow.pendingSkip !== undefined) pendingSkip = stage.flow.pendingSkip
  }
  const { pipelineId } = chain.root.flow
  const live = resolvePipeline?.(pipelineId)
  const stages = [...chain.stages]
    .sort((left, right) => left.flow.stageIndex - right.flow.stageIndex)
    .map(stage => {
      const extra = decorate?.(stage) ?? {}
      const memberName = live?.stageMemberNames?.[stage.flow.stageIndex]
      return {
        ticketId: stage.id,
        title: stage.title,
        state: stage.state,
        stageIndex: stage.flow.stageIndex,
        ...(memberName === undefined || memberName === '' ? {} : { memberName }),
        ...(extra.readyReport === undefined ? {} : { readyReport: extra.readyReport }),
        ...(extra.deliverables === undefined || extra.deliverables.length === 0 ? {} : { deliverables: extra.deliverables }),
      }
    })
  const pipelineName = live?.name ?? chain.root.flow.pipelineName
  const maxSeenStageCount = stages.reduce((max, stage) => Math.max(max, stage.stageIndex + 1), 1)
  const stageCount = Math.max(live?.stageCount ?? chain.root.flow.stageCount, maxSeenStageCount)
  return {
    rootTicketId: chain.root.id,
    pipelineId,
    pipelineName,
    stageCount,
    stages,
    skipped: [...skipped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([stageIndex, reason]) => ({ stageIndex, reason })),
    ...(pendingSkip === undefined ? {} : { pendingSkip }),
  }
}

/** Render one walk's progress as the markdown mirror's body. */
export function renderFlowMarkdown(view: FlowTimelineView): string {
  const done = view.stages.filter(stage => stage.state === 'ended').length
  const lines: string[] = [
    `# 流程进度：${view.pipelineName}`,
    '',
    `- 流程工单：${view.rootTicketId}`,
    `- 环节：${view.stages.length}/${view.stageCount}（已结束 ${done}）`,
  ]
  if (view.pendingSkip !== undefined) {
    lines.push(`- 待审批跳过：第 ${view.pendingSkip.stageIndex + 1} 环节（${view.pendingSkip.reason}）`)
  }
  if (view.skipped.length > 0) {
    lines.push('', '## 已跳过环节', '')
    for (const entry of view.skipped) {
      lines.push(`- 第 ${entry.stageIndex + 1} 环节：${entry.reason}`)
    }
  }
  lines.push('', '## 环节明细', '', '| # | 工单 | 状态 | 说明 |', '| --- | --- | --- | --- |')
  for (const stage of view.stages) {
    const notes: string[] = []
    if (stage.readyReport !== undefined) notes.push(stage.readyReport)
    if (stage.deliverables !== undefined) notes.push(`产出物：${stage.deliverables.join('、')}`)
    lines.push(`| ${stage.stageIndex + 1} | ${stage.ticketId} ${stage.title} | ${stage.state} | ${notes.join('；') || '-'} |`)
  }
  lines.push('')
  return lines.join('\n')
}
