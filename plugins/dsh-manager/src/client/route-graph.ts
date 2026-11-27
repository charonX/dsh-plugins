/**
 * Pure Flow IR topology layout: lays out `entry` ("收到任务") on the far left,
 * enabled `flow` cards (`when` + `workspaceMode`) in column 1, and each flow's
 * ordered `step` cards (`skills[]`, `readOnly`, `humanConfirm`) extending rightward,
 * with arched `onFail` rework feedback edges below the step chain.
 */
import type { FlowDef } from '../flow/flow-ir.ts'

export type RouteMapNodeKind = 'entry' | 'flow' | 'step'

export interface RouteMapNode {
  readonly id: string
  readonly kind: RouteMapNodeKind
  readonly title: string
  readonly subtitle?: string
  readonly badge?: string
  readonly fullTitle: string
  readonly flowId?: string
  readonly stepId?: string
  readonly stepIndex?: number
  readonly readOnly?: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface RouteMapEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'flow' | 'rework'
  readonly label?: string
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

export interface RouteMapLayout {
  readonly nodes: readonly RouteMapNode[]
  readonly edges: readonly RouteMapEdge[]
  readonly width: number
  readonly height: number
}

const NODE_W = 212
const ENTRY_W = 148
const NODE_H = 66
const ENTRY_GAP_X = 56
const STAGE_GAP_X = 48
const BAND_GAP_Y = 52
const MARGIN_X = 24
const MARGIN_TOP = 32
const MARGIN_BOTTOM = 44
const REWORK_ARC_HEIGHT = 28
const MAX_LINE = 18

export function clampLine(text: string, max = MAX_LINE): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

export interface FlowMapInput {
  readonly rootTitle: string
  readonly reworkLabel: string
  readonly readOnlyLabel: string
  readonly confirmLabel: string
  readonly flows: readonly FlowDef[]
}

/** Build left-to-right flow topology coordinates for all enabled flows. */
export function layoutFlowMap(input: FlowMapInput): RouteMapLayout {
  const nodes: RouteMapNode[] = []
  const edges: RouteMapEdge[] = []
  const enabledFlows = input.flows.filter(flow => flow.enabled)

  const entryX = MARGIN_X
  const flowX = entryX + ENTRY_W + ENTRY_GAP_X
  const stepStartX = flowX + NODE_W + STAGE_GAP_X

  let cursorY = MARGIN_TOP
  let maxStepCount = 0

  for (let flowIdx = 0; flowIdx < enabledFlows.length; flowIdx += 1) {
    const flow = enabledFlows[flowIdx]!
    const hasReworkArc = flow.steps.some(step => step.onFail !== undefined)
    const rowY = cursorY
    maxStepCount = Math.max(maxStepCount, flow.steps.length)

    const flowNodeId = `flow-${flow.id}`
    nodes.push({
      id: flowNodeId,
      kind: 'flow',
      title: clampLine(flow.name, 16),
      subtitle: clampLine(flow.when, 22),
      badge: flow.workspaceMode,
      fullTitle: `${flow.name}: ${flow.when}`,
      flowId: flow.id,
      x: flowX,
      y: rowY,
      width: NODE_W,
      height: NODE_H,
    })

    const stepNodeIdsByStepId = new Map<string, string>()
    let prevNodeId = flowNodeId
    let prevX = flowX

    for (let sIdx = 0; sIdx < flow.steps.length; sIdx += 1) {
      const step = flow.steps[sIdx]!
      const stepNodeId = `step-${flow.id}-${step.id}`
      stepNodeIdsByStepId.set(step.id, stepNodeId)
      const stepX = stepStartX + sIdx * (NODE_W + STAGE_GAP_X)
      const badges = [
        step.readOnly ? input.readOnlyLabel : undefined,
        step.humanConfirm ? input.confirmLabel : undefined,
      ].filter((v): v is string => v !== undefined)
      const subtitleSource = step.skills.length > 0
        ? step.skills.map(s => `/${s}`).join(' ')
        : (step.goal ?? '')
      nodes.push({
        id: stepNodeId,
        kind: 'step',
        title: `${sIdx + 1}. ${clampLine(step.name, 14)}`,
        ...(subtitleSource === '' ? {} : { subtitle: clampLine(subtitleSource, 22) }),
        ...(badges.length === 0 ? {} : { badge: badges.join(' · ') }),
        fullTitle: `${step.name}${step.goal ? ` — ${step.goal}` : ''}`,
        flowId: flow.id,
        stepId: step.id,
        stepIndex: sIdx,
        ...(step.readOnly === true ? { readOnly: true } : {}),
        x: stepX,
        y: rowY,
        width: NODE_W,
        height: NODE_H,
      })

      edges.push({
        id: `edge-${prevNodeId}-${stepNodeId}`,
        from: prevNodeId,
        to: stepNodeId,
        kind: 'flow',
        points: [
          { x: prevX + NODE_W, y: rowY + NODE_H / 2 },
          { x: stepX, y: rowY + NODE_H / 2 },
        ],
      })
      prevNodeId = stepNodeId
      prevX = stepX
    }

    // Add `onFail` rework feedback arcs beneath the step row.
    for (let sIdx = 0; sIdx < flow.steps.length; sIdx += 1) {
      const step = flow.steps[sIdx]!
      if (step.onFail === undefined) continue
      const targetId = step.onFail === 'self' ? step.id : step.onFail
      const fromNodeId = stepNodeIdsByStepId.get(step.id)
      const toNodeId = stepNodeIdsByStepId.get(targetId)
      const fromNode = nodes.find(n => n.id === fromNodeId)
      const toNode = nodes.find(n => n.id === toNodeId)
      if (fromNode === undefined || toNode === undefined) continue
      const arcY = rowY + NODE_H + REWORK_ARC_HEIGHT
      const fromX = fromNode.x + NODE_W * 0.45
      const toX = toNode.x + NODE_W * 0.55
      edges.push({
        id: `rework-${flow.id}-${step.id}-${targetId}`,
        from: fromNode.id,
        to: toNode.id,
        kind: 'rework',
        label: input.reworkLabel,
        points: [
          { x: fromX, y: rowY + NODE_H },
          { x: fromX, y: arcY },
          { x: toX, y: arcY },
          { x: toX, y: rowY + NODE_H },
        ],
      })
    }

    cursorY += NODE_H + BAND_GAP_Y + (hasReworkArc ? REWORK_ARC_HEIGHT : 0)
  }

  const flowNodes = nodes.filter(node => node.kind === 'flow')
  const entryCenterY = flowNodes.length > 0
    ? (flowNodes[0]!.y + flowNodes.at(-1)!.y + NODE_H) / 2
    : MARGIN_TOP + NODE_H / 2
  const entryY = entryCenterY - NODE_H / 2
  const entryNodeId = 'entry-root'
  nodes.unshift({
    id: entryNodeId,
    kind: 'entry',
    title: input.rootTitle,
    fullTitle: input.rootTitle,
    x: entryX,
    y: entryY,
    width: ENTRY_W,
    height: NODE_H,
  })

  const entryRight = entryX + ENTRY_W
  const entryMidY = entryY + NODE_H / 2
  for (const flowNode of flowNodes) {
    const flowMidY = flowNode.y + NODE_H / 2
    // Leave the entry horizontally, drop between the columns, then enter the
    // flow row horizontally: a diagonal straight line reads as a stray stroke.
    const elbowX = entryRight + Math.max(24, (flowNode.x - entryRight) / 2)
    edges.push({
      id: `edge-entry-${flowNode.id}`,
      from: entryNodeId,
      to: flowNode.id,
      kind: 'flow',
      points: [
        { x: entryRight, y: entryMidY },
        { x: elbowX, y: entryMidY },
        { x: elbowX, y: flowMidY },
        { x: flowNode.x, y: flowMidY },
      ],
    })
  }

  const maxX = maxStepCount > 0
    ? stepStartX + maxStepCount * NODE_W + (maxStepCount - 1) * STAGE_GAP_X
    : flowX + NODE_W
  const width = Math.max(480, maxX + MARGIN_X)
  const height = Math.max(NODE_H + MARGIN_TOP + MARGIN_BOTTOM, cursorY - BAND_GAP_Y + MARGIN_BOTTOM)

  return { nodes, edges, width, height }
}

/** Orthogonal polyline SVG path with rounded corners. */
export function roundedOrthogonalPath(
  points: readonly { readonly x: number; readonly y: number }[],
  radius = 8,
): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  if (points.length === 2) return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`
  const parts: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!
    const curr = points[i]!
    const next = points[i + 1]!
    const dx1 = curr.x - prev.x
    const dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x
    const dy2 = next.y - curr.y
    const len1 = Math.hypot(dx1, dy1)
    const len2 = Math.hypot(dx2, dy2)
    if (len1 === 0 || len2 === 0) {
      parts.push(`L ${curr.x} ${curr.y}`)
      continue
    }
    const r = Math.min(radius, len1 / 2, len2 / 2)
    const startX = curr.x - (dx1 / len1) * r
    const startY = curr.y - (dy1 / len1) * r
    const endX = curr.x + (dx2 / len2) * r
    const endY = curr.y + (dy2 / len2) * r
    parts.push(`L ${startX} ${startY} Q ${curr.x} ${curr.y} ${endX} ${endY}`)
  }
  const last = points.at(-1)!
  parts.push(`L ${last.x} ${last.y}`)
  return parts.join(' ')
}

/** Return connected node ids for hover/selection highlighting. */
export function connectedNodeIds(nodeId: string, edges: readonly RouteMapEdge[]): ReadonlySet<string> {
  const connected = new Set<string>([nodeId])
  for (const edge of edges) {
    if (edge.from === nodeId) connected.add(edge.to)
    if (edge.to === nodeId) connected.add(edge.from)
  }
  return connected
}
