/** Orchestration Workbench: Topology canvas with interactive Inspector and List cards sharing one Modal controller. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentKindOption, CrewMemberView } from '../crew/wire-types.ts'
import type { PipelineStageInput, PipelineView } from '../pipeline/wire-types.ts'
import type { RouteRuleView } from '../route/wire-types.ts'
import type { CrewInjected, CrewSnapshot } from './crew-source.ts'
import type { PipelineInjected, PipelineSnapshot } from './pipeline-source.ts'
import type { RouteInjected, RouteSnapshot } from './route-source.ts'
import {
  clampLine,
  connectedNodeIds,
  layoutRouteMap,
  roundedOrthogonalPath,
  type RouteMapNode,
} from './route-graph.ts'
import { resolveWorkbenchSelection } from './workbench-model.ts'
import { DshSelect } from './DshSelect.tsx'
import { SlashInput, type SlashCommandGroup } from './SlashInput.tsx'
import css from './TeamPage.module.css'

export type WorkbenchViewMode = 'graph' | 'list'

export type OrchestrationWorkbenchProps = InjectFace<CrewInjected & PipelineInjected & RouteInjected>
  & PropsLocale<'dshManager'>

interface RuleForm {
  readonly condition: string
  readonly pipelineId: string
}

interface StageForm {
  readonly memberId: string
  readonly instruction: string
  readonly skippable: boolean
  readonly skipLogic: string
  readonly mode?: 'execute' | 'review'
}

interface PipelineForm {
  readonly name: string
  readonly stages: readonly StageForm[]
}

const EMPTY_RULE_FORM: RuleForm = { condition: '', pipelineId: '' }
const EMPTY_STAGE: StageForm = { memberId: '', instruction: '', skippable: false, skipLogic: '' }
const EMPTY_PIPELINE_FORM: PipelineForm = { name: '', stages: [{ ...EMPTY_STAGE }] }

function stageValid(stage: StageForm): boolean {
  return stage.memberId !== ''
}

/** Unified Route & Pipeline workbench with Topology/List switching and shared editor modals. */
export function OrchestrationWorkbench(props: OrchestrationWorkbenchProps) {
  const {
    useRoute,
    usePipeline,
    useCrew,
    onRuleAdd,
    onRuleUpdate,
    onRuleRemove,
    onRouteRetry,
    onPipelineAdd,
    onPipelineUpdate,
    onPipelineRemove,
    onRuleReferencesOfPipeline,
    onPipelineRetry,
    onAgentKindOptions,
    t,
  } = props

  const routeData = useRoute(s => s)
  const pipelineData = usePipeline(s => s)
  const crewData = useCrew(s => s)

  const [viewMode, setViewMode] = useState<WorkbenchViewMode>('graph')
  const [selectedId, setSelectedId] = useState<string | undefined>()

  // Shared Rule Modal controller
  const [ruleEditingId, setRuleEditingId] = useState<string | undefined>()
  const [ruleForm, setRuleForm] = useState<RuleForm>(EMPTY_RULE_FORM)
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [ruleSubmitFailed, setRuleSubmitFailed] = useState(false)

  // Shared Pipeline Modal controller
  const [pipelineEditingId, setPipelineEditingId] = useState<string | undefined>()
  const [pipelineForm, setPipelineForm] = useState<PipelineForm>(EMPTY_PIPELINE_FORM)
  const [pipelineModalOpen, setPipelineModalOpen] = useState(false)
  const [kindOptions, setKindOptions] = useState<readonly AgentKindOption[]>([])
  const [pipelineSubmitFailed, setPipelineSubmitFailed] = useState(false)

  // Shared 2-step pipeline delete confirmation
  const [pendingPipelineRemove, setPendingPipelineRemove] = useState<{ id: string; rules: readonly string[] }>()

  const rules = routeData.rules ?? []
  const pipelines = pipelineData.pipelines ?? []
  const members = crewData.members ?? []

  // Clear stale pipeline delete confirmation if the pipeline disappeared (e.g. hot reload).
  useEffect(() => {
    if (pendingPipelineRemove !== undefined && !pipelines.some(p => p.id === pendingPipelineRemove.id)) {
      setPendingPipelineRemove(undefined)
    }
  }, [pipelines, pendingPipelineRemove])

  const openRuleAdd = (prefillPipelineId = ''): void => {
    setRuleEditingId(undefined)
    setRuleSubmitFailed(false)
    setRuleForm({ condition: '', pipelineId: prefillPipelineId })
    setRuleModalOpen(true)
  }

  const openRuleEdit = (rule: RouteRuleView): void => {
    setRuleEditingId(rule.id)
    setRuleSubmitFailed(false)
    setRuleForm({ condition: rule.condition, pipelineId: rule.pipelineId })
    setRuleModalOpen(true)
  }

  const closeRuleModal = (): void => {
    setRuleEditingId(undefined)
    setRuleForm(EMPTY_RULE_FORM)
    setRuleSubmitFailed(false)
    setRuleModalOpen(false)
  }

  const submitRule = (): void => {
    const valid = ruleForm.condition.trim() !== '' && ruleForm.pipelineId !== ''
    if (!valid || routeData.busy === true) return
    const saved = ruleEditingId !== undefined
      ? onRuleUpdate({ ruleId: ruleEditingId, condition: ruleForm.condition.trim(), pipelineId: ruleForm.pipelineId })
      : onRuleAdd({ condition: ruleForm.condition.trim(), pipelineId: ruleForm.pipelineId })
    void saved.then((savedRule) => {
      if (savedRule === undefined) {
        setRuleSubmitFailed(true)
        return
      }
      closeRuleModal()
    })
  }

  const loadStageKinds = (): void => {
    if (typeof onAgentKindOptions !== 'function') return
    void onAgentKindOptions(false).then(setKindOptions).catch(() => {})
  }

  const openPipelineAdd = (): void => {
    setPipelineEditingId(undefined)
    setPipelineSubmitFailed(false)
    setPipelineForm({ name: '', stages: [{ ...EMPTY_STAGE }] })
    setPipelineModalOpen(true)
    loadStageKinds()
  }

  const openPipelineEdit = (pipeline: PipelineView): void => {
    setPipelineEditingId(pipeline.id)
    setPipelineSubmitFailed(false)
    setPipelineForm({
      name: pipeline.name,
      stages: pipeline.stages.map(stage => ({
        memberId: stage.memberId,
        instruction: stage.instruction ?? '',
        skippable: stage.skippable ?? false,
        skipLogic: stage.skipLogic ?? '',
        ...(stage.mode === undefined ? {} : { mode: stage.mode }),
      })),
    })
    setPipelineModalOpen(true)
    loadStageKinds()
  }

  const closePipelineModal = (): void => {
    setPipelineEditingId(undefined)
    setPipelineForm(EMPTY_PIPELINE_FORM)
    setPipelineSubmitFailed(false)
    setPipelineModalOpen(false)
  }

  const submitPipeline = (): void => {
    const valid = pipelineForm.name.trim() !== ''
      && pipelineForm.stages.length > 0
      && pipelineForm.stages.every(stageValid)
    if (!valid || pipelineData.busy === true) return
    const stages: PipelineStageInput[] = pipelineForm.stages.map(stage => ({
      memberId: stage.memberId,
      ...(stage.instruction.trim() === '' ? {} : { instruction: stage.instruction.trim() }),
      skippable: stage.skippable,
      ...(stage.skippable && stage.skipLogic.trim() !== '' ? { skipLogic: stage.skipLogic.trim() } : {}),
      ...(stage.mode === undefined ? {} : { mode: stage.mode }),
    }))
    const saved = pipelineEditingId !== undefined
      ? onPipelineUpdate({
        pipelineId: pipelineEditingId,
        ...(pipelineForm.name.trim() === '' ? {} : { name: pipelineForm.name.trim() }),
        stages,
      })
      : onPipelineAdd({ name: pipelineForm.name.trim(), stages })
    void saved.then((savedPipeline) => {
      if (savedPipeline === undefined) {
        setPipelineSubmitFailed(true)
        return
      }
      closePipelineModal()
    })
  }

  const toggleRuleEnabled = (rule: RouteRuleView): void => {
    const nextEnabled = !rule.enabled
    if (!nextEnabled && selectedId === `rule-${rule.id}`) {
      setSelectedId(undefined)
    }
    void onRuleUpdate({ ruleId: rule.id, enabled: nextEnabled })
  }

  const removeRule = (ruleId: string): void => {
    if (selectedId === `rule-${ruleId}`) {
      setSelectedId(undefined)
    }
    void onRuleRemove(ruleId)
  }

  const requestPipelineRemove = (pipeline: PipelineView): void => {
    if (pendingPipelineRemove?.id === pipeline.id) {
      setPendingPipelineRemove(undefined)
      if (selectedId === `pipeline-pipe:${pipeline.id}`) {
        setSelectedId(undefined)
      }
      void onPipelineRemove(pipeline.id)
      return
    }
    void onRuleReferencesOfPipeline(pipeline.id).then((refs) => {
      if (refs.length > 0) {
        setPendingPipelineRemove({ id: pipeline.id, rules: refs })
        return
      }
      if (selectedId === `pipeline-pipe:${pipeline.id}`) {
        setSelectedId(undefined)
      }
      void onPipelineRemove(pipeline.id)
    })
  }

  const ruleFormValid = ruleForm.condition.trim() !== '' && ruleForm.pipelineId !== ''
  const pipelineFormValid = pipelineForm.name.trim() !== ''
    && pipelineForm.stages.length > 0
    && pipelineForm.stages.every(stageValid)

  return (
    <div className={css.workbenchRoot}>
      <div className={css.workbenchHeader}>
        <SegmentedControl<WorkbenchViewMode>
          id="dsh-team-workbench-mode"
          value={viewMode}
          onChange={setViewMode}
          label={t('team.view.workbench')}
          options={[
            { value: 'graph', label: t('team.workbench.graph') },
            { value: 'list', label: t('team.workbench.list') },
          ]}
        />
        {viewMode === 'graph'
          ? (
            <div className={css.workbenchActions}>
              <Button variant="primary" size="sm" onClick={() => { openRuleAdd() }}>
                {t('route.add.open')}
              </Button>
              <Button variant="outline" size="sm" onClick={openPipelineAdd}>
                {t('pipeline.add.open')}
              </Button>
            </div>
          )
          : null}
      </div>

      <div
        id={`dsh-team-workbench-mode-${viewMode}-panel`}
        role="tabpanel"
        aria-labelledby={`dsh-team-workbench-mode-${viewMode}`}
      >
        {viewMode === 'graph'
          ? (
            <TopologyView
              routeData={routeData}
              pipelineData={pipelineData}
              crewData={crewData}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRuleAddOpen={openRuleAdd}
              onRuleEdit={openRuleEdit}
              onRuleToggle={toggleRuleEnabled}
              onRuleRemove={removeRule}
              onPipelineAddOpen={openPipelineAdd}
              onPipelineEdit={openPipelineEdit}
              onPipelineRemove={requestPipelineRemove}
              pendingPipelineRemove={pendingPipelineRemove}
              onRouteRetry={onRouteRetry}
              onPipelineRetry={onPipelineRetry}
              t={t}
            />
          )
          : (
            <div id="dsh-team-orchestration" className={css.orchestrationGrid}>
              <section className={css.panelSection} aria-label={t('route.section')}>
                <RuleListSection
                  routeData={routeData}
                  pipelines={pipelines}
                  onAdd={() => { openRuleAdd() }}
                  onEdit={openRuleEdit}
                  onToggle={toggleRuleEnabled}
                  onRemove={removeRule}
                  onRetry={onRouteRetry}
                  t={t}
                />
              </section>
              <section className={css.panelSection} aria-label={t('pipeline.section')}>
                <PipelineListSection
                  pipelineData={pipelineData}
                  members={members}
                  pendingRemove={pendingPipelineRemove}
                  onAdd={openPipelineAdd}
                  onEdit={openPipelineEdit}
                  onRemove={requestPipelineRemove}
                  onRetry={onPipelineRetry}
                  t={t}
                />
              </section>
            </div>
          )}
      </div>

      {/* Shared Rule Modal */}
      <Modal
        open={ruleModalOpen}
        onClose={closeRuleModal}
        title={ruleEditingId !== undefined ? t('route.editing') : t('route.add.title')}
        closeLabel={t('route.cancel')}
      >
        <label className={css.field}>
          <span>{t('route.condition')}</span>
          <textarea
            className={css.textArea}
            value={ruleForm.condition}
            placeholder={t('route.conditionPlaceholder')}
            onChange={event => setRuleForm({ ...ruleForm, condition: event.target.value })}
          />
        </label>
        <label className={css.field}>
          <span>{t('route.pipeline')}</span>
          <DshSelect
            value={ruleForm.pipelineId}
            options={[
              { value: '', label: t('route.pipelineChoose') },
              ...pipelines.map(entry => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={next => setRuleForm({ ...ruleForm, pipelineId: next })}
          />
        </label>
        {!ruleFormValid ? <p className={css.invalid}>{t('route.invalid')}</p> : null}
        {ruleSubmitFailed && (routeData.actionError === undefined || routeData.actionError === '')
          ? <p className={css.invalid}>{t('route.failed')}</p>
          : null}
        {routeData.actionError !== undefined && routeData.actionError !== ''
          ? <p className={css.invalid}>{routeData.actionError}</p>
          : null}
        <footer className={css.modalFooter}>
          <Button variant="outline" size="sm" onClick={closeRuleModal}>{t('route.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!ruleFormValid || routeData.busy === true} onClick={submitRule}>
            {ruleEditingId !== undefined ? t('route.save') : t('route.add.submit')}
          </Button>
        </footer>
      </Modal>

      {/* Shared Pipeline Modal */}
      <PipelineEditorModal
        open={pipelineModalOpen}
        editing={pipelineEditingId !== undefined}
        form={pipelineForm}
        setForm={setPipelineForm}
        valid={pipelineFormValid}
        busy={pipelineData.busy === true}
        submitFailed={pipelineSubmitFailed}
        actionError={pipelineData.actionError}
        members={members}
        kindOptions={kindOptions}
        onClose={closePipelineModal}
        onSubmit={submitPipeline}
        t={t}
      />
    </div>
  )
}

function TopologyView({
  routeData,
  pipelineData,
  crewData,
  selectedId,
  onSelect,
  onRuleAddOpen,
  onRuleEdit,
  onRuleToggle,
  onRuleRemove,
  onPipelineAddOpen,
  onPipelineEdit,
  onPipelineRemove,
  pendingPipelineRemove,
  onRouteRetry,
  onPipelineRetry,
  t,
}: {
  routeData: RouteSnapshot
  pipelineData: PipelineSnapshot
  crewData: CrewSnapshot
  selectedId: string | undefined
  onSelect: (next: string | undefined | ((prev: string | undefined) => string | undefined)) => void
  onRuleAddOpen: (pipelineId?: string) => void
  onRuleEdit: (rule: RouteRuleView) => void
  onRuleToggle: (rule: RouteRuleView) => void
  onRuleRemove: (ruleId: string) => void
  onPipelineAddOpen: () => void
  onPipelineEdit: (pipeline: PipelineView) => void
  onPipelineRemove: (pipeline: PipelineView) => void
  pendingPipelineRemove: { id: string; rules: readonly string[] } | undefined
  onRouteRetry: () => void
  onPipelineRetry: () => void
  t: TranslateNS<'dshManager'>
}) {
  const [zoom, setZoom] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  if (routeData.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('route.error')}</p>
        <Button variant="outline" size="sm" onClick={onRouteRetry}>{t('route.retry')}</Button>
      </div>
    )
  }
  if (pipelineData.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('pipeline.error')}</p>
        <Button variant="outline" size="sm" onClick={onPipelineRetry}>{t('pipeline.retry')}</Button>
      </div>
    )
  }
  if (routeData.status === 'loading' || pipelineData.status === 'loading' || crewData.status === 'loading') {
    return <div className={css.empty}>{t('route.loading')}</div>
  }

  const allRules = routeData.rules ?? []
  const enabledRules = allRules.filter(rule => rule.enabled)
  const disabledCount = allRules.length - enabledRules.length
  const pipelines = pipelineData.pipelines ?? []
  const members = crewData.members ?? []

  const layout = layoutRouteMap({
    rootTitle: t('route.mindmapRoot'),
    skipLabel: t('pipeline.skippable'),
    unknownMember: t('route.pipelineUnknown'),
    stageCountLabel: count => t('route.mindmapStageCount', { count }),
    rules: enabledRules,
    pipelines,
    memberName: memberId => members.find(member => member.id === memberId)?.name ?? '',
  })

  const selection = resolveWorkbenchSelection({
    layout,
    selectedId,
    rules: enabledRules,
    pipelines,
    members,
  })
  const selectedNode = selection?.node
  const activeChain = connectedNodeIds(layout, selectedNode?.id)
  const hasSelection = selectedNode !== undefined

  const kindLabel = (node: RouteMapNode): string => {
    if (node.kind === 'entry') return t('route.map.kind.entry')
    if (node.kind === 'rule') return t('route.map.kind.rule')
    if (node.kind === 'pipeline') return t('route.map.kind.pipeline')
    return t('route.map.kind.stage', { n: (node.stageIndex ?? 0) + 1 })
  }

  return (
    <section className={css.mindmap} aria-label={t('route.mindmap')}>
      <header className={css.archHeader}>
        <div className={css.archTitleGroup}>
          <h2 className={css.sectionTitle}>{t('route.mindmap')}</h2>
          <Tag tone="neutral">{layout.nodes.length}</Tag>
          <span className={css.archSubtitle}>{t('route.map.subtitle')}</span>
        </div>
        {enabledRules.length > 0
          ? (
            <div className={css.archToolbar}>
              <Button variant="outline" size="sm" aria-label={t('route.map.zoomOut')}
                disabled={zoom <= 0.6} onClick={() => { setZoom(z => Math.max(0.6, Math.round((z - 0.15) * 100) / 100)) }}>
                −
              </Button>
              <span className={css.zoomPercent}>{Math.round(zoom * 100)}%</span>
              <Button variant="outline" size="sm" aria-label={t('route.map.zoomIn')}
                disabled={zoom >= 1.5} onClick={() => { setZoom(z => Math.min(1.5, Math.round((z + 0.15) * 100) / 100)) }}>
                +
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setZoom(1); onSelect(undefined) }}>
                {t('route.map.fit')}
              </Button>
              <Button variant={sidebarOpen ? 'primary' : 'outline'} size="sm"
                onClick={() => { setSidebarOpen(open => !open) }}>
                {t('route.map.sidebarToggle')}
              </Button>
            </div>
          )
          : null}
      </header>

      {enabledRules.length === 0
        ? (
          <div className={css.panelSection}>
            <p className={css.emptyInline}>{t('route.mindmapEmpty')}</p>
            {disabledCount > 0
              ? <p className={css.inspectorMuted}>{t('route.mindmapEmptyDisabledHint', { count: disabledCount })}</p>
              : null}
          </div>
        )
        : (
          <div className={css.archWorkbench} data-sidebar-open={sidebarOpen}>
            <div className={css.mapViewport} onClick={() => { onSelect(undefined) }}>
              <div className={css.mapCanvasInner}>
                <svg
                  className={css.mapSvg}
                  width={Math.round(layout.width * zoom)}
                  height={Math.round(layout.height * zoom)}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label={t('route.mindmap')}
                >
                  <defs>
                    <marker id="dsh-map-arrow-flow" viewBox="0 0 10 10" refX="8.5" refY="5"
                      markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                      <path d="M 0 1 L 9 5 L 0 9 z" className={css.mapArrowFlow} />
                    </marker>
                    <marker id="dsh-map-arrow-flow-active" viewBox="0 0 10 10" refX="8.5" refY="5"
                      markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                      <path d="M 0 1 L 9 5 L 0 9 z" className={css.mapArrowFlowActive} />
                    </marker>
                    <marker id="dsh-map-arrow-skip" viewBox="0 0 10 10" refX="8.5" refY="5"
                      markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                      <path d="M 0 1 L 9 5 L 0 9 z" className={css.mapArrowSkip} />
                    </marker>
                  </defs>
                  {layout.edges.map((edge) => {
                    const edgeActive = hasSelection && activeChain.has(edge.from) && activeChain.has(edge.to)
                    const dimmed = hasSelection && !edgeActive
                    const marker = edge.kind === 'skip'
                      ? 'url(#dsh-map-arrow-skip)'
                      : edgeActive ? 'url(#dsh-map-arrow-flow-active)' : 'url(#dsh-map-arrow-flow)'
                    const midX = edge.points.length >= 3 ? (edge.points[1]!.x + edge.points[2]!.x) / 2 : 0
                    const midY = edge.points.length >= 3 ? (edge.points[1]!.y + edge.points[2]!.y) / 2 : 0
                    return (
                      <g
                        key={edge.id}
                        className={css.mapEdge}
                        data-edge-kind={edge.kind}
                        data-highlighted={edgeActive || undefined}
                        data-dimmed={dimmed || undefined}
                      >
                        <path
                          d={roundedOrthogonalPath(edge.points, 10)}
                          className={css.mapEdgePath}
                          markerEnd={marker}
                        />
                        {edge.label !== undefined && edge.points.length >= 3
                          ? (
                            <g transform={`translate(${midX}, ${midY})`}>
                              <rect x="-22" y="-9" width="44" height="18" rx="9" className={css.mapEdgePillBg} />
                              <text className={css.mapEdgeLabel} x="0" y="0.5">{edge.label}</text>
                            </g>
                          )
                          : null}
                      </g>
                    )
                  })}
                  {layout.nodes.map((node) => {
                    const selected = selectedNode?.id === node.id
                    const dimmed = hasSelection && !activeChain.has(node.id)
                    const cornerLabel = node.badge ?? (
                      node.kind === 'entry'
                        ? t('route.map.badge.entry')
                        : node.kind === 'rule'
                          ? t('route.map.badge.rule')
                          : node.kind === 'stage' && node.skippable !== true
                            ? t('route.map.badge.required')
                            : undefined
                    )
                    return (
                      <g
                        key={node.id}
                        className={css.mapNode}
                        data-node-kind={node.kind}
                        data-skippable={node.skippable === true ? 'true' : undefined}
                        data-selected={selected || undefined}
                        data-dimmed={dimmed || undefined}
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelect(current => (current === node.id ? undefined : node.id))
                        }}
                      >
                        <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="10" className={css.mapNodeCard} />
                        <text className={css.mapNodeKindText} x={node.x + 12} y={node.y + 15}>
                          {kindLabel(node)}
                        </text>
                        {cornerLabel !== undefined
                          ? (
                            <g className={css.mapNodeBadge} data-badge-kind={node.kind}>
                              <rect x={node.x + node.width - 54} y={node.y + 6} width="46" height="15" rx="7.5" />
                              <text x={node.x + node.width - 31} y={node.y + 14}>{clampLine(cornerLabel, 7)}</text>
                            </g>
                          )
                          : null}
                        <text
                          className={css.mapNodeTitle}
                          x={node.x + 12}
                          y={node.y + (node.subtitle === undefined ? 40 : 35)}
                        >
                          {node.title}
                        </text>
                        {node.subtitle !== undefined
                          ? (
                            <text className={css.mapNodeSubtitle} x={node.x + 12} y={node.y + 51}>
                              {node.subtitle}
                            </text>
                          )
                          : null}
                        <title>{node.fullTitle}</title>
                      </g>
                    )
                  })}
                </svg>
              </div>
            </div>

            {sidebarOpen
              ? (
                <aside className={css.archSidebar} aria-label={t('route.map.inspector')}>
                  <div className={css.inspectorBlock}>
                    <div className={css.inspectorHeader}>
                      <span className={css.indexHeader}>{t('route.map.inspector')}</span>
                      {selectedNode !== undefined
                        ? (
                          <Button variant="ghost" size="sm" onClick={() => { onSelect(undefined) }}>
                            {t('route.map.clearSelection')}
                          </Button>
                        )
                        : null}
                    </div>
                    {selection === undefined
                      ? (
                        <>
                          <p className={css.inspectorMuted}>{t('route.map.selectHint')}</p>
                          <div className={css.inspectorActions}>
                            <Button variant="outline" size="sm" onClick={() => { onRuleAddOpen() }}>{t('route.add.open')}</Button>
                            <Button variant="outline" size="sm" onClick={onPipelineAddOpen}>{t('pipeline.add.open')}</Button>
                          </div>
                        </>
                      )
                      : (
                        <>
                          <div className={css.cardHeader}>
                            <Tag tone={
                              selection.node.kind === 'entry' ? 'info'
                                : selection.node.kind === 'rule' ? 'warning'
                                  : selection.node.kind === 'pipeline' ? 'success'
                                    : 'neutral'
                            }>
                              {kindLabel(selection.node)}
                            </Tag>
                            {selection.node.skippable === true
                              ? <Tag tone="warning">{t('pipeline.skippable')}</Tag>
                              : null}
                          </div>
                          <h3 className={css.inspectorTitle}>{selection.node.fullTitle}</h3>
                          {selection.node.kind === 'entry'
                            ? (
                              <div className={css.inspectorActions}>
                                <Button variant="outline" size="sm" onClick={() => { onRuleAddOpen() }}>{t('route.add.open')}</Button>
                                <Button variant="outline" size="sm" onClick={onPipelineAddOpen}>{t('pipeline.add.open')}</Button>
                              </div>
                            )
                            : null}
                          {selection.node.kind === 'rule' && selection.pipeline !== undefined
                            ? (
                              <>
                                <span className={css.inspectorFieldLabel}>{t('route.map.targetPipeline')}</span>
                                <p className={css.inspectorText}>{selection.pipeline.name}（{t('pipeline.stageCount', { count: selection.pipeline.stages.length })}）</p>
                              </>
                            )
                            : null}
                          {selection.node.kind === 'rule' && selection.rule !== undefined
                            ? (
                              <div className={css.inspectorActions}>
                                <Button variant="outline" size="sm" disabled={routeData.busy === true}
                                  onClick={() => { onRuleEdit(selection.rule!) }}>
                                  {t('route.edit')}
                                </Button>
                                <Button variant="outline" size="sm" disabled={routeData.busy === true}
                                  onClick={() => { onRuleToggle(selection.rule!) }}>
                                  {selection.rule.enabled ? t('route.disable') : t('route.enable')}
                                </Button>
                                <Button variant="ghost" size="sm" disabled={routeData.busy === true}
                                  onClick={() => { onRuleRemove(selection.rule!.id) }}>
                                  {t('route.remove')}
                                </Button>
                              </div>
                            )
                            : null}
                          {selection.node.kind === 'pipeline' && selection.matchingRules.length > 0
                            ? (
                              <>
                                <span className={css.inspectorFieldLabel}>{t('route.condition')}</span>
                                {selection.matchingRules.map(rule => (
                                  <p key={rule.id} className={css.inspectorText}>• {rule.condition}</p>
                                ))}
                              </>
                            )
                            : null}
                          {selection.node.kind === 'pipeline' && selection.pipeline !== undefined
                            ? (
                              <>
                                <div className={css.inspectorActions}>
                                  <Button variant="outline" size="sm" disabled={pipelineData.busy === true}
                                    onClick={() => { onPipelineEdit(selection.pipeline!) }}>
                                    {t('pipeline.edit')}
                                  </Button>
                                  <Button variant="outline" size="sm"
                                    onClick={() => { onRuleAddOpen(selection.pipeline!.id) }}>
                                    {t('route.add.open')}
                                  </Button>
                                  <Button variant="ghost" size="sm" disabled={pipelineData.busy === true}
                                    onClick={() => { onPipelineRemove(selection.pipeline!) }}>
                                    {t('pipeline.remove')}
                                  </Button>
                                </div>
                                {pendingPipelineRemove?.id === selection.pipeline.id
                                  ? (
                                    <p className={css.invalid}>
                                      {t('pipeline.removeReferenced', { rules: pendingPipelineRemove.rules.join('、') })}
                                    </p>
                                  )
                                  : null}
                              </>
                            )
                            : null}
                          {selection.node.kind === 'stage' && selection.member !== undefined
                            ? (
                              <>
                                <span className={css.inspectorFieldLabel}>{t('route.map.duty')}</span>
                                <p className={css.inspectorText}>{selection.member.role}</p>
                              </>
                            )
                            : null}
                          {selection.node.kind === 'stage' && selection.stage !== undefined && selection.stage.instruction !== ''
                            ? (
                              <>
                                <span className={css.inspectorFieldLabel}>{t('route.map.instruction')}</span>
                                <p className={css.inspectorText}>{selection.stage.instruction}</p>
                              </>
                            )
                            : null}
                          {selection.node.kind === 'stage' && selection.stage?.skippable && selection.stage.skipLogic !== undefined && selection.stage.skipLogic !== ''
                            ? (
                              <>
                                <span className={css.inspectorFieldLabel}>{t('route.map.skipLogic')}</span>
                                <p className={css.inspectorText}>{selection.stage.skipLogic}</p>
                              </>
                            )
                            : null}
                          {selection.node.kind === 'stage' && selection.pipeline !== undefined
                            ? (
                              <div className={css.inspectorActions}>
                                <Button variant="outline" size="sm" disabled={pipelineData.busy === true}
                                  onClick={() => { onPipelineEdit(selection.pipeline!) }}>
                                  {t('route.map.editPipeline')}
                                </Button>
                              </div>
                            )
                            : null}
                        </>
                      )}
                  </div>

                  <div className={css.indexBlock}>
                    <div className={css.indexHeader}>
                      <span>{t('route.map.nodeIndex')}</span>
                      <Tag tone="neutral">{layout.nodes.length}</Tag>
                    </div>
                    <ul className={css.indexList}>
                      {layout.nodes.map(node => (
                        <li key={node.id}>
                          <button
                            type="button"
                            className={css.indexItem}
                            data-selected={selectedNode?.id === node.id || undefined}
                            onClick={() => { onSelect(current => (current === node.id ? undefined : node.id)) }}
                          >
                            <span className={css.indexDot} data-kind={node.kind} />
                            <span className={css.indexLabel}>{node.fullTitle}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>
              )
              : null}
          </div>
        )}
      {layout.nodes.some(n => n.id === 'entry') && enabledRules.length > 0
        ? (
          <p className={css.mapLegend}>
            <span className={css.mapLegendFlow}>{t('route.mindmapLegendFlow')}</span>
            <span className={css.mapLegendSkip}>{t('pipeline.skippable')}</span>
          </p>
        )
        : null}
    </section>
  )
}

function RuleListSection({
  routeData,
  pipelines,
  onAdd,
  onEdit,
  onToggle,
  onRemove,
  onRetry,
  t,
}: {
  routeData: RouteSnapshot
  pipelines: readonly PipelineView[]
  onAdd: () => void
  onEdit: (rule: RouteRuleView) => void
  onToggle: (rule: RouteRuleView) => void
  onRemove: (ruleId: string) => void
  onRetry: () => void
  t: TranslateNS<'dshManager'>
}) {
  if (routeData.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('route.error')}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{t('route.retry')}</Button>
      </div>
    )
  }
  if (routeData.status === 'loading') {
    return <div className={css.empty}>{t('route.loading')}</div>
  }
  const rules = routeData.rules ?? []
  const pipelineName = (pipelineId: string): string =>
    pipelines.find(entry => entry.id === pipelineId)?.name ?? t('route.pipelineUnknown')

  return (
    <>
      <header className={css.sectionHeader}>
        <div className={css.sectionTitleGroup}>
          <h2 className={css.sectionTitle}>{t('route.section')}</h2>
          <Tag tone="neutral">{rules.length}</Tag>
        </div>
        <Button variant="primary" size="sm" onClick={onAdd}>
          {t('route.add.open')}
        </Button>
      </header>
      {rules.length === 0 ? <p className={css.emptyInline}>{t('route.empty')}</p> : null}
      <ul className={css.cards}>
        {rules.map(rule => (
          <li key={rule.id} className={css.card}>
            <header className={css.cardHeader}>
              <Tag tone={rule.enabled ? 'success' : 'warning'}>
                {rule.enabled ? t('route.enabled') : t('route.disabled')}
              </Tag>
              <span className={css.routeTarget}>→ {pipelineName(rule.pipelineId)}</span>
            </header>
            <p className={css.roleText}>{rule.condition}</p>
            <footer className={css.cardActions}>
              <Button variant="outline" size="sm" disabled={routeData.busy === true}
                onClick={() => { onEdit(rule) }}>
                {t('route.edit')}
              </Button>
              <Button variant="outline" size="sm" disabled={routeData.busy === true}
                onClick={() => { onToggle(rule) }}>
                {rule.enabled ? t('route.disable') : t('route.enable')}
              </Button>
              <Button variant="ghost" size="sm" disabled={routeData.busy === true}
                onClick={() => { onRemove(rule.id) }}>
                {t('route.remove')}
              </Button>
            </footer>
          </li>
        ))}
      </ul>
      {routeData.busy === true ? <p className={css.busy}>{t('route.busy')}</p> : null}
      {routeData.actionError !== undefined && routeData.actionError !== ''
        ? <p className={css.invalid}>{routeData.actionError}</p>
        : null}
    </>
  )
}

function PipelineListSection({
  pipelineData,
  members,
  pendingRemove,
  onAdd,
  onEdit,
  onRemove,
  onRetry,
  t,
}: {
  pipelineData: PipelineSnapshot
  members: readonly CrewMemberView[]
  pendingRemove: { id: string; rules: readonly string[] } | undefined
  onAdd: () => void
  onEdit: (pipeline: PipelineView) => void
  onRemove: (pipeline: PipelineView) => void
  onRetry: () => void
  t: TranslateNS<'dshManager'>
}) {
  if (pipelineData.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('pipeline.error')}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{t('pipeline.retry')}</Button>
      </div>
    )
  }
  if (pipelineData.status === 'loading') {
    return <div className={css.empty}>{t('pipeline.loading')}</div>
  }
  const pipelines = pipelineData.pipelines ?? []
  const memberName = (memberId: string): string =>
    members.find(member => member.id === memberId)?.name ?? t('pipeline.memberUnknown')

  return (
    <>
      <header className={css.sectionHeader}>
        <div className={css.sectionTitleGroup}>
          <h2 className={css.sectionTitle}>{t('pipeline.section')}</h2>
          <Tag tone="neutral">{pipelines.length}</Tag>
        </div>
        <Button variant="primary" size="sm" onClick={onAdd}>
          {t('pipeline.add.open')}
        </Button>
      </header>
      {pipelines.length === 0 ? <p className={css.emptyInline}>{t('pipeline.empty')}</p> : null}
      <ul className={css.cards}>
        {pipelines.map(pipeline => (
          <li key={pipeline.id} className={css.card}>
            <header className={css.cardHeader}>
              <strong>{pipeline.name}</strong>
              <Tag tone="info">{t('pipeline.stageCount', { count: pipeline.stages.length })}</Tag>
            </header>
            <ol className={css.stageList}>
              {pipeline.stages.map((stage, index) => (
                <li key={index} className={css.stageItem}>
                  <div className={css.stageItemTop}>
                    <span className={css.stageIndex}>{index + 1}</span>
                    <span>{memberName(stage.memberId)}</span>
                    {stage.skippable ? <Tag tone="warning">{t('pipeline.skippable')}</Tag> : null}
                  </div>
                  {stage.instruction !== undefined && stage.instruction !== ''
                    ? <span className={css.stageInstruction}>{stage.instruction}</span>
                    : null}
                </li>
              ))}
            </ol>
            <footer className={css.cardActions}>
              <Button variant="outline" size="sm" disabled={pipelineData.busy === true}
                onClick={() => { onEdit(pipeline) }}>
                {t('pipeline.edit')}
              </Button>
              <Button variant="ghost" size="sm" disabled={pipelineData.busy === true}
                onClick={() => { onRemove(pipeline) }}>
                {t('pipeline.remove')}
              </Button>
            </footer>
            {pendingRemove?.id === pipeline.id
              ? <p className={css.invalid}>{t('pipeline.removeReferenced', { rules: pendingRemove.rules.join('、') })}</p>
              : null}
          </li>
        ))}
      </ul>
      {pipelineData.busy === true ? <p className={css.busy}>{t('pipeline.busy')}</p> : null}
      {pipelineData.actionError !== undefined && pipelineData.actionError !== ''
        ? <p className={css.invalid}>{pipelineData.actionError}</p>
        : null}
    </>
  )
}

function PipelineEditorModal({
  open,
  editing,
  form,
  setForm,
  valid,
  busy,
  submitFailed,
  actionError,
  members,
  kindOptions,
  onClose,
  onSubmit,
  t,
}: {
  open: boolean
  editing: boolean
  form: PipelineForm
  setForm: (next: PipelineForm | ((prev: PipelineForm) => PipelineForm)) => void
  valid: boolean
  busy: boolean
  submitFailed: boolean
  actionError: string | undefined
  members: readonly CrewMemberView[]
  kindOptions: readonly AgentKindOption[]
  onClose: () => void
  onSubmit: () => void
  t: TranslateNS<'dshManager'>
}) {
  const patchStage = (index: number, patch: Partial<StageForm>): void => {
    setForm(currentForm => ({
      ...currentForm,
      stages: currentForm.stages.map((stage, at) => at === index ? { ...stage, ...patch } : stage),
    }))
  }
  const moveStage = (index: number, delta: -1 | 1): void => {
    setForm(currentForm => {
      const target = index + delta
      if (target < 0 || target >= currentForm.stages.length) return currentForm
      const stages = [...currentForm.stages]
      const [moved] = stages.splice(index, 1)
      stages.splice(target, 0, moved!)
      return { ...currentForm, stages }
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('pipeline.editing') : t('pipeline.add.title')}
      closeLabel={t('pipeline.cancel')}
    >
      <label className={css.field}>
        <span>{t('pipeline.name')}</span>
        <input className={css.input} value={form.name} placeholder={t('pipeline.namePlaceholder')}
          onChange={event => setForm({ ...form, name: event.target.value })} />
      </label>
      {form.stages.map((stage, index) => {
        const stageMember = members.find(member => member.id === stage.memberId)
        const stageKindOption = stageMember?.agentKind === undefined
          ? undefined
          : kindOptions.find(entry => entry.kind === stageMember.agentKind)
        const stageCommandGroups: readonly SlashCommandGroup[] = (
          stageKindOption !== undefined
          && stageKindOption.available
          && (stageKindOption.slashCommands?.length ?? 0) > 0
        )
          ? [{
            agentId: stageKindOption.kind,
            agentLabel: stageKindOption.kind,
            commands: stageKindOption.slashCommands ?? [],
          }]
          : []
        return (
          <div key={index} className={css.stageEditor}>
            <header className={css.stageEditorHeader}>
              <strong>{t('pipeline.stageN', { n: index + 1 })}</strong>
              <Button variant="outline" size="sm" disabled={index === 0}
                onClick={() => { moveStage(index, -1) }}>
                ↑
              </Button>
              <Button variant="outline" size="sm" disabled={index === form.stages.length - 1}
                onClick={() => { moveStage(index, 1) }}>
                ↓
              </Button>
              <Button variant="ghost" size="sm" disabled={form.stages.length === 1}
                onClick={() => { setForm(currentForm => ({ ...currentForm, stages: currentForm.stages.filter((_, at) => at !== index) })) }}>
                {t('pipeline.remove')}
              </Button>
            </header>
            <label className={css.field}>
              <span>{t('pipeline.member')}</span>
              <DshSelect
                value={stage.memberId}
                options={[
                  { value: '', label: t('pipeline.memberChoose') },
                  ...members.map(member => ({ value: member.id, label: member.name })),
                ]}
                onChange={next => patchStage(index, { memberId: next })}
              />
            </label>
            <label className={css.field}>
              <span>{t('pipeline.instruction')}</span>
              <SlashInput
                as="textarea"
                className={css.textArea}
                value={stage.instruction}
                groups={stageCommandGroups}
                placeholder={t('pipeline.instructionPlaceholder')}
                onChange={next => patchStage(index, { instruction: next })}
              />
            </label>
            <label className={css.field}>
              <span>
                <input type="checkbox" checked={stage.skippable}
                  onChange={event => patchStage(index, { skippable: event.target.checked })} />
                {' '}
                {t('pipeline.skippable')}
              </span>
            </label>
            {stage.skippable
              ? (
                <label className={css.field}>
                  <span>{t('pipeline.skipLogic')}</span>
                  <textarea className={css.textArea} value={stage.skipLogic}
                    placeholder={t('pipeline.skipLogicPlaceholder')}
                    onChange={event => patchStage(index, { skipLogic: event.target.value })} />
                </label>
              )
              : null}
          </div>
        )
      })}
      <Button variant="outline" size="sm"
        onClick={() => { setForm(currentForm => ({ ...currentForm, stages: [...currentForm.stages, { ...EMPTY_STAGE }] })) }}>
        {t('pipeline.stageAdd')}
      </Button>
      {!valid ? <p className={css.invalid}>{t('pipeline.invalid')}</p> : null}
      {submitFailed && (actionError === undefined || actionError === '')
        ? <p className={css.invalid}>{t('pipeline.failed')}</p>
        : null}
      {actionError !== undefined && actionError !== ''
        ? <p className={css.invalid}>{actionError}</p>
        : null}
      <footer className={css.modalFooter}>
        <Button variant="outline" size="sm" onClick={onClose}>{t('pipeline.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={!valid || busy} onClick={onSubmit}>
          {editing ? t('pipeline.save') : t('pipeline.add.submit')}
        </Button>
      </footer>
    </Modal>
  )
}
