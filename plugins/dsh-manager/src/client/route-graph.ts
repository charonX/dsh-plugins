/**
 * The rule map's layout core: turns the enabled rules and their pipelines
 * into a left-to-right mindmap geometry — the entry node centered on the
 * far left, a column of enabled route rules to its right, each rule's target
 * pipeline (shared pipelines converge cleanly into one band), and the stage
 * chain extending horizontally rightward with arched dashed skip routes above
 * skippable stages. Pure geometry: the renderer draws it, tests assert it,
 * and no graph library is involved.
 */

/** One node kind; the renderer styles each. */
export type RouteMapNodeKind = 'entry' | 'rule' | 'pipeline' | 'stage'

/** One placed node. */
export interface RouteMapNode {
  readonly id: string
  readonly kind: RouteMapNodeKind
  /** The primary line, clamped for display. */
  readonly title: string
  /** The secondary line, when the node carries one. */
  readonly subtitle?: string
  /** The small pill on the node, when one applies (e.g. 可跳过). */
  readonly badge?: string
  /** The unclamped texts, for the renderer's hover tooltip and inspector. */
  readonly fullTitle: string
  /** Domain entity linkage for the inspector and edit shortcut. */
  readonly ruleId?: string
  readonly pipelineId?: string
  readonly memberId?: string
  readonly stageIndex?: number
  readonly skippable?: boolean
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One routed edge: a polyline the renderer draws with an arrowhead. */
export interface RouteMapEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'flow' | 'skip'
  /** The label on the edge, when one applies (e.g. 可跳过). */
  readonly label?: string
  /** The polyline points, in draw order. */
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

/** The whole map's geometry. */
export interface RouteMapLayout {
  readonly nodes: readonly RouteMapNode[]
  readonly edges: readonly RouteMapEdge[]
  readonly width: number
  readonly height: number
}

/** The layout's metrics (left-to-right mindmap). */
const NODE_W = 208
const ENTRY_W = 148
const NODE_H = 62
const ENTRY_GAP_X = 60
const RULE_GAP_X = 60
const STAGE_GAP_X = 52
const ROW_GAP_Y = 20
const BAND_GAP_Y = 40
const MARGIN_X = 24
/** Top margin leaves headroom above stage row 0 for arched `可跳过` bypass routes. */
const MARGIN_TOP = 50
const MARGIN_BOTTOM = 28
const SKIP_ARC_HEIGHT = 28
/** Max characters kept on one node line before the ellipsis. */
const MAX_LINE = 18

/** Clamp one display line to the node's width budget. */
export function clampLine(text: string, max = MAX_LINE): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

/** Layout inputs: the enabled rules, every pipeline they may reference, and the roster. */
export interface RouteMapInput {
  /** The entry node's label (the locale's 收到任务). */
  readonly rootTitle: string
  /** The label on a skippable route (the locale's 可跳过). */
  readonly skipLabel: string
  /** The label for a stage whose member vanished. */
  readonly unknownMember: string
  /** The pipeline node's stage-count line, e.g. `${count} 个环节`. */
  readonly stageCountLabel: (count: number) => string
  readonly rules: readonly { readonly id: string; readonly condition: string; readonly pipelineId: string }[]
  readonly pipelines: readonly { readonly id: string; readonly name: string; readonly stages: readonly { readonly memberId: string; readonly instruction?: string; readonly skippable?: boolean }[] }[]
  readonly memberName: (memberId: string) => string
}

type RuleInput = RouteMapInput['rules'][number]
type PipelineInput = RouteMapInput['pipelines'][number]

/**
 * Lay the map out left-to-right:
 * - Column 0: `entry` centered vertically on the far left
 * - Column 1: enabled `rule` nodes stacked vertically (grouped by target pipeline so bands never cross)
 * - Column 2: `pipeline` node vertically centered per pipeline band
 * - Column 3+: `stage` nodes extending horizontally rightward in one clean row per pipeline
 */
export function layoutRouteMap(input: RouteMapInput): RouteMapLayout {
  const nodes: RouteMapNode[] = []
  const edges: RouteMapEdge[] = []
  const stageMember = (memberId: string): string => {
    const name = input.memberName(memberId)
    return name === '' ? input.unknownMember : name
  }

  // Group rules by target pipeline (preserving first-seen pipeline order) so
  // shared pipelines converge cleanly into one horizontal stage chain without
  // crossing edges between bands.
  const bands: {
    readonly key: string
    readonly pipeline: PipelineInput | undefined
    readonly rules: RuleInput[]
  }[] = []
  const bandByKey = new Map<string, (typeof bands)[number]>()

  for (const rule of input.rules) {
    const pipeline = input.pipelines.find(entry => entry.id === rule.pipelineId)
    const key = pipeline !== undefined ? `pipe:${pipeline.id}` : `missing:${rule.id}`
    let band = bandByKey.get(key)
    if (band === undefined) {
      band = { key, pipeline, rules: [] }
      bandByKey.set(key, band)
      bands.push(band)
    }
    band.rules.push(rule)
  }

  const entryX = MARGIN_X
  const ruleX = entryX + ENTRY_W + ENTRY_GAP_X
  const pipelineX = ruleX + NODE_W + RULE_GAP_X
  const stageStartX = pipelineX + NODE_W + STAGE_GAP_X

  let cursorY = MARGIN_TOP
  let maxStageCount = 0

  for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
    const band = bands[bandIndex]!
    const stages = band.pipeline?.stages ?? []
    maxStageCount = Math.max(maxStageCount, stages.length)

    const bandTop = cursorY
    const bandHeight = band.rules.length * NODE_H + (band.rules.length - 1) * ROW_GAP_Y
    const bandCenterY = bandTop + bandHeight / 2
    const pipelineY = bandCenterY - NODE_H / 2

    const pipelineNodeId = `pipeline-${band.key}`
    const pipelineNode: RouteMapNode = {
      id: pipelineNodeId,
      kind: 'pipeline',
      title: clampLine(band.pipeline?.name ?? '—', 14),
      subtitle: input.stageCountLabel(stages.length),
      fullTitle: band.pipeline?.name ?? '',
      ...(band.pipeline === undefined ? {} : { pipelineId: band.pipeline.id }),
      x: pipelineX,
      y: pipelineY,
      width: NODE_W,
      height: NODE_H,
    }

    const bandRuleNodes: RouteMapNode[] = []
    band.rules.forEach((rule, ruleIdx) => {
      const ruleY = bandTop + ruleIdx * (NODE_H + ROW_GAP_Y)
      const ruleNode: RouteMapNode = {
        id: `rule-${rule.id}`,
        kind: 'rule',
        title: clampLine(rule.condition),
        fullTitle: rule.condition,
        ruleId: rule.id,
        pipelineId: rule.pipelineId,
        x: ruleX,
        y: ruleY,
        width: NODE_W,
        height: NODE_H,
      }
      bandRuleNodes.push(ruleNode)
      nodes.push(ruleNode)
      edges.push({
        id: `edge-pipeline-${rule.id}`,
        from: ruleNode.id,
        to: pipelineNode.id,
        kind: 'flow',
        points: horizontalOrthogonal(
          ruleNode.x + ruleNode.width, ruleNode.y + ruleNode.height / 2,
          pipelineNode.x, pipelineNode.y + pipelineNode.height / 2,
        ),
      })
    })

    nodes.push(pipelineNode)

    // Stage chain flows horizontally to the right from the pipeline node.
    let previous = pipelineNode
    stages.forEach((stage, index) => {
      const stageX = stageStartX + index * (NODE_W + STAGE_GAP_X)
      const stageNode: RouteMapNode = {
        id: `stage-${band.key}-${index}`,
        kind: 'stage',
        title: clampLine(`${index + 1}. ${stageMember(stage.memberId)}`),
        subtitle: clampLine(stage.instruction ?? '', 24),
        ...(stage.skippable === true ? { badge: input.skipLabel } : {}),
        fullTitle: `${index + 1}. ${stageMember(stage.memberId)}`,
        ...(band.pipeline === undefined ? {} : { pipelineId: band.pipeline.id }),
        memberId: stage.memberId,
        stageIndex: index,
        skippable: stage.skippable === true,
        x: stageX,
        y: pipelineY,
        width: NODE_W,
        height: NODE_H,
      }
      nodes.push(stageNode)
      edges.push({
        id: `edge-stage-${band.key}-${index}`,
        from: previous.id,
        to: stageNode.id,
        kind: 'flow',
        points: [
          { x: previous.x + previous.width, y: previous.y + previous.height / 2 },
          { x: stageNode.x, y: stageNode.y + stageNode.height / 2 },
        ],
      })
      if (stage.skippable === true && index < stages.length - 1) {
        const nextStageX = stageStartX + (index + 1) * (NODE_W + STAGE_GAP_X)
        const leaveX = stageNode.x + NODE_W * 0.7
        const landX = nextStageX + NODE_W * 0.3
        const arcY = pipelineY - SKIP_ARC_HEIGHT
        edges.push({
          id: `edge-skip-${band.key}-${index}`,
          from: stageNode.id,
          to: `stage-${band.key}-${index + 1}`,
          kind: 'skip',
          label: input.skipLabel,
          points: [
            { x: leaveX, y: pipelineY },
            { x: leaveX, y: arcY },
            { x: landX, y: arcY },
            { x: landX, y: pipelineY },
          ],
        })
      }
      previous = stageNode
    })

    cursorY += bandHeight + (bandIndex < bands.length - 1 ? BAND_GAP_Y : 0)
  }

  const totalContentHeight = bands.length === 0 ? NODE_H : cursorY - MARGIN_TOP
  const height = MARGIN_TOP + totalContentHeight + MARGIN_BOTTOM
  const width = maxStageCount > 0
    ? stageStartX + maxStageCount * NODE_W + (maxStageCount - 1) * STAGE_GAP_X + MARGIN_X
    : pipelineX + NODE_W + MARGIN_X

  // Entry node sits on the far left, vertically centered across all rule rows.
  const entryY = MARGIN_TOP + totalContentHeight / 2 - NODE_H / 2
  const entryNode: RouteMapNode = {
    id: 'entry',
    kind: 'entry',
    title: clampLine(input.rootTitle, 12),
    fullTitle: input.rootTitle,
    x: entryX,
    y: entryY,
    width: ENTRY_W,
    height: NODE_H,
  }
  nodes.unshift(entryNode)

  // Connect entry to every rule in column 1 (preserving rule order).
  const entryEdges: RouteMapEdge[] = []
  for (const rule of input.rules) {
    const ruleNode = nodes.find(node => node.id === `rule-${rule.id}`)
    if (ruleNode === undefined) continue
    entryEdges.push({
      id: `edge-entry-${rule.id}`,
      from: entryNode.id,
      to: ruleNode.id,
      kind: 'flow',
      points: horizontalOrthogonal(
        entryNode.x + entryNode.width, entryNode.y + entryNode.height / 2,
        ruleNode.x, ruleNode.y + ruleNode.height / 2,
      ),
    })
  }
  edges.unshift(...entryEdges)

  return { nodes, edges, width, height }
}

/** Convert an orthogonal polyline into an Archify-style smooth rounded SVG path (`Q` corners). */
export function roundedOrthogonalPath(points: readonly { readonly x: number; readonly y: number }[], radius = 10): string {
  if (points.length === 0) return ''
  if (points.length <= 2) {
    return points.map((p, index) => `${index === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  }
  const commands: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
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
    if (len1 < 0.5 || len2 < 0.5) {
      commands.push(`L ${curr.x} ${curr.y}`)
      continue
    }
    const r = Math.min(radius, len1 / 2, len2 / 2)
    const enterX = curr.x - (dx1 / len1) * r
    const enterY = curr.y - (dy1 / len1) * r
    const leaveX = curr.x + (dx2 / len2) * r
    const leaveY = curr.y + (dy2 / len2) * r
    commands.push(`L ${enterX} ${enterY} Q ${curr.x} ${curr.y} ${leaveX} ${leaveY}`)
  }
  const last = points.at(-1)!
  commands.push(`L ${last.x} ${last.y}`)
  return commands.join(' ')
}

/** Collect every node id connected upstream and downstream from `selectedId` for Archify-style trace focus. */
export function connectedNodeIds(layout: RouteMapLayout, selectedId: string | undefined): Set<string> {
  if (selectedId === undefined) return new Set()
  const upstream = new Map<string, string[]>()
  const downstream = new Map<string, string[]>()
  for (const edge of layout.edges) {
    const down = downstream.get(edge.from) ?? []
    down.push(edge.to)
    downstream.set(edge.from, down)
    const up = upstream.get(edge.to) ?? []
    up.push(edge.from)
    upstream.set(edge.to, up)
  }
  const result = new Set<string>([selectedId])
  const walk = (start: string, adj: Map<string, string[]>) => {
    const queue = [start]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of adj.get(current) ?? []) {
        if (!result.has(next)) {
          result.add(next)
          queue.push(next)
        }
      }
    }
  }
  walk(selectedId, upstream)
  walk(selectedId, downstream)
  return result
}

/** One orthogonal three-segment route between horizontally arranged nodes. */
function horizontalOrthogonal(x1: number, y1: number, x2: number, y2: number): readonly { x: number; y: number }[] {
  if (Math.abs(y1 - y2) < 0.5) {
    return [{ x: x1, y: y1 }, { x: x2, y: y2 }]
  }
  const midX = (x1 + x2) / 2
  return [
    { x: x1, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: x2, y: y2 },
  ]
}
