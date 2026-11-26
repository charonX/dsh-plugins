/** Simplified Flow IR & Skill-driven orchestration workbench (Topology Graph + List + Playbook Compiler). */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  AGENT_KINDS,
  WORKSPACE_MODES,
  type AgentKind,
  type AgentKindOption,
  type FlowDef,
  type FlowStepInput,
  type PresetId,
  type WorkspaceMode,
} from '../flow/flow-ir.ts'
import type { FlowInjected } from './flow-source.ts'
import { DshSelect } from './DshSelect.tsx'
import {
  clampLine,
  connectedNodeIds,
  layoutFlowMap,
  roundedOrthogonalPath,
  type RouteMapNode,
} from './route-graph.ts'
import css from './TeamPage.module.css'

export type WorkbenchViewMode = 'graph' | 'list'

export type FlowWorkbenchProps = InjectFace<FlowInjected> & PropsLocale<'dshManager'> & {
  readonly onGoSkills?: () => void
}

interface StepForm {
  readonly id: string
  readonly name: string
  readonly skills: readonly string[]
  readonly customSkill: string
  readonly goal: string
  readonly readOnly: boolean
  readonly humanConfirm: boolean
  readonly onFail: string
  readonly agentKind: AgentKind
  readonly agentModel: string
}

interface FlowForm {
  readonly name: string
  readonly when: string
  readonly workspaceMode: WorkspaceMode
  readonly enabled: boolean
  readonly steps: readonly StepForm[]
}

function emptyStep(index: number): StepForm {
  return {
    id: `step-${index + 1}`,
    name: `步骤 ${index + 1}`,
    skills: [],
    customSkill: '',
    goal: '',
    readOnly: false,
    humanConfirm: false,
    onFail: '',
    agentKind: 'builtin',
    agentModel: '',
  }
}

function emptyFlowForm(): FlowForm {
  return {
    name: '',
    when: '',
    workspaceMode: 'in-place',
    enabled: true,
    steps: [emptyStep(0)],
  }
}

function flowToForm(flow: FlowDef): FlowForm {
  return {
    name: flow.name,
    when: flow.when,
    workspaceMode: flow.workspaceMode,
    enabled: flow.enabled,
    steps: flow.steps.map(step => ({
      id: step.id,
      name: step.name,
      skills: [...step.skills],
      customSkill: '',
      goal: step.goal ?? '',
      readOnly: step.readOnly === true,
      humanConfirm: step.humanConfirm === true,
      onFail: step.onFail ?? '',
      agentKind: step.agent?.kind ?? 'builtin',
      agentModel: step.agent?.model ?? '',
    })),
  }
}

function formToSteps(steps: readonly StepForm[]): readonly FlowStepInput[] {
  return steps.map((step, index) => {
    const extra = step.customSkill.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    const skills = [...new Set([...step.skills, ...extra])]
    return {
      id: step.id.trim() || `step-${index + 1}`,
      name: step.name.trim() || `Step ${index + 1}`,
      skills,
      ...(step.goal.trim() === '' ? {} : { goal: step.goal.trim() }),
      ...(step.readOnly ? { readOnly: true } : {}),
      ...(step.humanConfirm ? { humanConfirm: true } : {}),
      ...(step.onFail.trim() === '' ? {} : { onFail: step.onFail.trim() }),
      ...(step.agentKind !== 'builtin' || step.agentModel.trim() !== ''
        ? {
            agent: {
              kind: step.agentKind,
              ...(step.agentModel.trim() === '' ? {} : { model: step.agentModel.trim() }),
            },
          }
        : {}),
    }
  })
}

export function FlowWorkbench(props: FlowWorkbenchProps) {
  const {
    useFlows,
    onFlowAdd,
    onFlowUpdate,
    onFlowRemove,
    onFlowRetry,
    onFlowPresetApply,
    onFlowImportPlaybook,
    onFlowSyncPlaybook,
    onPlaybookCatalogRefresh,
    onAgentKindOptions,
    onTeamConfigExportYaml,
    onTeamConfigImportYaml,
    t,
  } = props

  const snapshot = useFlows(s => s)
  const flows = snapshot.flows ?? []
  const skills = snapshot.skills ?? []
  const playbooks = snapshot.playbooks ?? []

  const [viewMode, setViewMode] = useState<WorkbenchViewMode>('graph')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [zoom, setZoom] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Flow editor modal
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingFlowId, setEditingFlowId] = useState<string | undefined>()
  const [form, setForm] = useState<FlowForm>(emptyFlowForm)
  const [formError, setFormError] = useState<string | undefined>()
  const [agentKinds, setAgentKinds] = useState<readonly AgentKindOption[]>([])

  // Presets modal
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetBusy, setPresetBusy] = useState<PresetId | undefined>()
  const [presetError, setPresetError] = useState<string | undefined>()

  // Playbook import modal
  const [playbookOpen, setPlaybookOpen] = useState(false)
  const [playbookKind, setPlaybookKind] = useState<'skill' | 'file' | 'markdown'>('skill')
  const [playbookRef, setPlaybookRef] = useState('')
  const [playbookContent, setPlaybookContent] = useState('')
  const [playbookUseLlm, setPlaybookUseLlm] = useState(false)
  const [playbookBusy, setPlaybookBusy] = useState(false)
  const [playbookNotice, setPlaybookNotice] = useState<string | undefined>()
  const [playbookError, setPlaybookError] = useState<string | undefined>()

  // YAML export / import modal
  const [yamlOpen, setYamlOpen] = useState(false)
  const [yamlText, setYamlText] = useState('')
  const [yamlError, setYamlError] = useState<string | undefined>()
  const [yamlNotice, setYamlNotice] = useState<string | undefined>()

  useEffect(() => {
    void onAgentKindOptions(false).then(setAgentKinds).catch(() => {})
  }, [onAgentKindOptions])

  if (snapshot.status === 'loading') {
    return <p className={css.empty}>{t('flow.loading')}</p>
  }
  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('flow.error')}</p>
        <Button variant="outline" size="sm" onClick={() => { void onFlowRetry() }}>{t('flow.retry')}</Button>
      </div>
    )
  }

  const map = layoutFlowMap({
    rootTitle: t('route.mindmapRoot'),
    reworkLabel: t('flow.reworkEdge'),
    readOnlyLabel: t('flow.badge.readOnly'),
    confirmLabel: t('flow.badge.confirm'),
    flows,
  })
  const selectedNode = map.nodes.find(n => n.id === selectedNodeId)
  const selectedFlow = selectedNode?.flowId === undefined
    ? undefined
    : flows.find(f => f.id === selectedNode.flowId)
  const selectedStep = selectedFlow !== undefined && selectedNode?.stepIndex !== undefined
    ? selectedFlow.steps[selectedNode.stepIndex]
    : undefined
  const activeConnected = selectedNodeId === undefined ? undefined : connectedNodeIds(selectedNodeId, map.edges)

  const openNewFlow = (): void => {
    setEditingFlowId(undefined)
    setForm(emptyFlowForm())
    setFormError(undefined)
    setEditorOpen(true)
  }

  const openEditFlow = (flow: FlowDef): void => {
    setEditingFlowId(flow.id)
    setForm(flowToForm(flow))
    setFormError(undefined)
    setEditorOpen(true)
  }

  const submitFlow = async (): Promise<void> => {
    if (form.name.trim() === '' || form.when.trim() === '' || form.steps.length === 0) {
      setFormError(t('flow.invalid'))
      return
    }
    const steps = formToSteps(form.steps)
    const res = editingFlowId === undefined
      ? await onFlowAdd({
          name: form.name.trim(),
          when: form.when.trim(),
          workspaceMode: form.workspaceMode,
          enabled: form.enabled,
          steps: [...steps],
        })
      : await onFlowUpdate({
          flowId: editingFlowId,
          name: form.name.trim(),
          when: form.when.trim(),
          workspaceMode: form.workspaceMode,
          enabled: form.enabled,
          steps: [...steps],
        })
    if (!res.ok) {
      setFormError(res.error ?? t('flow.failed'))
      return
    }
    setEditorOpen(false)
    if (res.flow !== undefined) setSelectedNodeId(`flow-${res.flow.id}`)
  }

  const applyPreset = async (presetId: PresetId): Promise<void> => {
    setPresetBusy(presetId)
    setPresetError(undefined)
    try {
      const res = await onFlowPresetApply(presetId)
      if (!res.ok) {
        setPresetError(res.error ?? t('preset.copy.failed'))
        return
      }
      setPresetOpen(false)
      if (res.flow !== undefined) setSelectedNodeId(`flow-${res.flow.id}`)
    } finally {
      setPresetBusy(undefined)
    }
  }

  const submitPlaybookImport = async (): Promise<void> => {
    const trimmedRef = playbookRef.trim() || (playbookKind === 'markdown' ? 'custom-playbook.md' : '')
    if (trimmedRef === '') {
      setPlaybookError(t('flow.playbook.refRequired'))
      return
    }
    if (playbookKind === 'markdown' && playbookContent.trim() === '') {
      setPlaybookError(t('flow.playbook.contentRequired'))
      return
    }
    setPlaybookBusy(true)
    setPlaybookError(undefined)
    try {
      const res = await onFlowImportPlaybook({
        kind: playbookKind,
        ref: trimmedRef,
        ...(playbookKind === 'markdown' ? { content: playbookContent } : {}),
        useLlm: playbookUseLlm,
      })
      if (!res.ok || res.flow === undefined) {
        setPlaybookError(res.error ?? t('flow.playbook.failed'))
        return
      }
      setPlaybookNotice(t('flow.playbook.compiled', { name: res.flow.name, method: res.method ?? 'markdown' }))
      setPlaybookOpen(false)
      setSelectedNodeId(`flow-${res.flow.id}`)
    } finally {
      setPlaybookBusy(false)
    }
  }

  const openYamlModal = async (): Promise<void> => {
    setYamlError(undefined)
    setYamlNotice(undefined)
    const exported = await onTeamConfigExportYaml()
    setYamlText(exported ?? '')
    setYamlOpen(true)
  }

  const importYaml = async (): Promise<void> => {
    setYamlError(undefined)
    const res = await onTeamConfigImportYaml(yamlText)
    if (!res.ok) {
      setYamlError(res.error ?? t('prompt.import.failed'))
      return
    }
    setYamlNotice(t('flow.yaml.imported'))
    setYamlOpen(false)
  }

  const renderInspectorBody = (node: RouteMapNode) => {
    if (node.kind === 'entry') {
      return (
        <div className={css.inspectorBody}>
          <Tag tone="neutral">{t('route.map.badge.entry')}</Tag>
          <h4 className={css.inspectorTitle}>{node.fullTitle}</h4>
          <p className={css.inspectorMeta}>{t('flow.entryHint')}</p>
        </div>
      )
    }
    if (selectedFlow === undefined) return null
    if (node.kind === 'flow') {
      return (
        <div className={css.inspectorBody}>
          <div className={css.inspectorBadges}>
            <Tag tone="info">{selectedFlow.workspaceMode}</Tag>
            {selectedFlow.source !== undefined
              ? <Tag tone="success">{t('flow.source.cached', { hash: selectedFlow.source.hash.slice(0, 7) })}</Tag>
              : null}
          </div>
          <h4 className={css.inspectorTitle}>{selectedFlow.name}</h4>
          <p className={css.inspectorMeta}><strong>{t('flow.whenLabel')}:</strong> {selectedFlow.when}</p>
          {selectedFlow.source !== undefined
            ? <p className={css.inspectorMeta}><strong>{t('flow.sourceLabel')}:</strong> <code>{selectedFlow.source.ref}</code></p>
            : null}
          <div className={css.inspectorActions}>
            <Button variant="outline" size="sm" onClick={() => { openEditFlow(selectedFlow) }}>{t('flow.edit')}</Button>
            {selectedFlow.source !== undefined
              ? (
                <Button variant="outline" size="sm" onClick={() => { void onFlowSyncPlaybook(selectedFlow.id) }}>
                  {t('flow.source.sync')}
                </Button>
              )
              : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void onFlowUpdate({ flowId: selectedFlow.id, enabled: !selectedFlow.enabled }) }}
            >
              {selectedFlow.enabled ? t('route.disable') : t('route.enable')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { void onFlowRemove(selectedFlow.id); setSelectedNodeId(undefined) }}>
              {t('flow.remove')}
            </Button>
          </div>
        </div>
      )
    }
    if (selectedStep !== undefined) {
      return (
        <div className={css.inspectorBody}>
          <div className={css.inspectorBadges}>
            <Tag tone="neutral">{t('flow.stepIndex', { n: (node.stepIndex ?? 0) + 1 })}</Tag>
            {selectedStep.readOnly ? <Tag tone="warning">{t('flow.badge.readOnly')}</Tag> : null}
            {selectedStep.humanConfirm ? <Tag tone="info">{t('flow.badge.confirm')}</Tag> : null}
          </div>
          <h4 className={css.inspectorTitle}>{selectedStep.name}</h4>
          {selectedStep.skills.length > 0
            ? (
              <div className={css.skillChips}>
                {selectedStep.skills.map(sk => <Tag key={sk} tone="info">/{sk}</Tag>)}
              </div>
            )
            : <p className={css.inspectorMeta}>{t('flow.noStepSkills')}</p>}
          {selectedStep.goal !== undefined && selectedStep.goal !== ''
            ? <p className={css.inspectorMeta}>{selectedStep.goal}</p>
            : null}
          {selectedStep.onFail !== undefined
            ? <p className={css.inspectorMeta}><strong>{t('flow.onFailLabel')}:</strong> <code>{selectedStep.onFail}</code></p>
            : null}
          {selectedStep.agent !== undefined
            ? <p className={css.inspectorMeta}><strong>{t('crew.agentKind')}:</strong> {selectedStep.agent.kind}{selectedStep.agent.model ? ` · ${selectedStep.agent.model}` : ''}</p>
            : null}
          <div className={css.inspectorActions}>
            <Button variant="outline" size="sm" onClick={() => { openEditFlow(selectedFlow) }}>{t('flow.edit')}</Button>
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <section id="dsh-team-flows" className={css.workbenchRoot} aria-label={t('team.section.orchestration')}>
      <div className={css.workbenchHeader}>
        <SegmentedControl<WorkbenchViewMode>
          id="dsh-team-workbench-mode"
          value={viewMode}
          onChange={setViewMode}
          label={t('team.section.orchestration')}
          options={[
            { value: 'graph', label: t('team.workbench.graph') },
            { value: 'list', label: t('team.workbench.list') },
          ]}
        />
        <div className={css.workbenchActions}>
          <Button variant="primary" size="sm" onClick={openNewFlow}>{t('flow.add.open')}</Button>
          <Button variant="outline" size="sm" onClick={() => {
            setPlaybookError(undefined)
            setPlaybookRef(skills[0]?.name ?? '')
            setPlaybookKind(skills.length > 0 ? 'skill' : 'file')
            setPlaybookOpen(true)
          }}>
            {t('flow.playbook.open')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            setPresetError(undefined)
            setPresetOpen(true)
            void onPlaybookCatalogRefresh()
          }}>
            {t('preset.open')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { void openYamlModal() }}>
            {t('flow.yaml.open')}
          </Button>
        </div>
      </div>

      {playbookNotice !== undefined ? <p className={css.noticeText}>{playbookNotice}</p> : null}
      {snapshot.actionError !== undefined ? <p className={css.errorText}>{snapshot.actionError}</p> : null}

      {viewMode === 'graph'
        ? (
          <div className={css.mindmap}>
            <div className={css.archHeader}>
              <div className={css.archTitleGroup}>
                <span className={css.archSubtitle}>{t('flow.map.subtitle')}</span>
              </div>
              <div className={css.archToolbar}>
                <Button variant="ghost" size="sm" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.1).toFixed(2)))}>-</Button>
                <span className={css.zoomPercent}>{Math.round(zoom * 100)}%</span>
                <Button variant="ghost" size="sm" onClick={() => setZoom(z => Math.min(1.5, +(z + 0.1).toFixed(2)))}>+</Button>
                <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>{t('route.map.fit')}</Button>
                <Button variant="outline" size="sm" onClick={() => setSidebarOpen(v => !v)}>{t('route.map.sidebarToggle')}</Button>
              </div>
            </div>

            {flows.filter(f => f.enabled).length === 0
              ? (
                <div className={css.emptyBox}>
                  <p className={css.empty}>{t('flow.empty')}</p>
                  <p className={css.archSubtitle}>{t('flow.emptyFallbackHint')}</p>
                </div>
              )
              : (
                <div className={css.archWorkspace}>
                  <div className={css.mindmapScroll}>
                    <div
                      className={css.mindmapCanvas}
                      style={{ width: map.width * zoom, height: map.height * zoom }}
                    >
                      <div
                        className={css.mindmapStage}
                        style={{ width: map.width, height: map.height, transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                      >
                        <svg className={css.mindmapSvg} width={map.width} height={map.height}>
                          <defs>
                            <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                              <path d="M 0 1 L 8 5 L 0 9 z" fill="currentColor" />
                            </marker>
                          </defs>
                          {map.edges.map((edge) => {
                            const isRework = edge.kind === 'rework'
                            const dimmed = activeConnected !== undefined && (!activeConnected.has(edge.from) || !activeConnected.has(edge.to))
                            const lastPt = edge.points.at(-1)
                            const prevPt = edge.points.at(-2)
                            return (
                              <g key={edge.id} className={dimmed ? css.edgeDimmed : undefined}>
                                <path
                                  d={roundedOrthogonalPath(edge.points)}
                                  className={isRework ? css.edgeRework : css.edgeFlow}
                                  fill="none"
                                  markerEnd="url(#flow-arrow)"
                                />
                                {isRework && prevPt !== undefined && lastPt !== undefined
                                  ? (
                                    <text
                                      x={(prevPt.x + lastPt.x) / 2}
                                      y={prevPt.y - 4}
                                      textAnchor="middle"
                                      className={css.edgeLabel}
                                    >
                                      {edge.label}
                                    </text>
                                  )
                                  : null}
                              </g>
                            )
                          })}
                        </svg>
                        {map.nodes.map((node) => {
                          const selected = node.id === selectedNodeId
                          const dimmed = activeConnected !== undefined && !activeConnected.has(node.id)
                          return (
                            <button
                              key={node.id}
                              type="button"
                              className={[
                                css.mapNode,
                                css[`mapNode_${node.kind}`] ?? '',
                                selected ? css.mapNodeSelected : '',
                                dimmed ? css.mapNodeDimmed : '',
                              ].join(' ')}
                              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                              title={node.fullTitle}
                              onClick={() => setSelectedNodeId(node.id)}
                            >
                              <div className={css.mapNodeHead}>
                                <strong className={css.mapNodeTitle}>{node.title}</strong>
                                {node.badge !== undefined ? <span className={css.mapNodeBadge}>{node.badge}</span> : null}
                              </div>
                              {node.subtitle !== undefined
                                ? <span className={css.mapNodeSub}>{node.subtitle}</span>
                                : null}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                  {sidebarOpen
                    ? (
                      <aside className={css.archSidebar}>
                        <div className={css.inspectorHeader}>
                          <strong>{t('route.map.inspector')}</strong>
                          {selectedNode !== undefined
                            ? <Button variant="ghost" size="sm" onClick={() => setSelectedNodeId(undefined)}>{t('route.map.clearSelection')}</Button>
                            : null}
                        </div>
                        {selectedNode !== undefined
                          ? renderInspectorBody(selectedNode)
                          : <p className={css.inspectorHint}>{t('flow.inspectorHint')}</p>}
                      </aside>
                    )
                    : null}
                </div>
              )}
          </div>
        )
        : (
          <div className={css.flowList}>
            {flows.length === 0
              ? <p className={css.empty}>{t('flow.empty')}</p>
              : flows.map(flow => (
                <article key={flow.id} className={css.flowCard}>
                  <div className={css.flowCardHeader}>
                    <div className={css.flowCardTitleGroup}>
                      <strong>{flow.name}</strong>
                      <Tag tone={flow.enabled ? 'success' : 'neutral'}>
                        {flow.enabled ? t('route.enabled') : t('route.disabled')}
                      </Tag>
                      <Tag tone="info">{flow.workspaceMode}</Tag>
                      {flow.source !== undefined
                        ? <Tag tone="neutral">{t('flow.source.cached', { hash: flow.source.hash.slice(0, 7) })}</Tag>
                        : null}
                    </div>
                    <div className={css.flowCardActions}>
                      <Button variant="outline" size="sm" onClick={() => { openEditFlow(flow) }}>{t('flow.edit')}</Button>
                      {flow.source !== undefined
                        ? <Button variant="outline" size="sm" onClick={() => { void onFlowSyncPlaybook(flow.id) }}>{t('flow.source.sync')}</Button>
                        : null}
                      <Button variant="outline" size="sm" onClick={() => { void onFlowUpdate({ flowId: flow.id, enabled: !flow.enabled }) }}>
                        {flow.enabled ? t('route.disable') : t('route.enable')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { void onFlowRemove(flow.id) }}>{t('flow.remove')}</Button>
                    </div>
                  </div>
                  <p className={css.flowWhen}>{flow.when}</p>
                  <ol className={css.flowStepStrip}>
                    {flow.steps.map((step, idx) => (
                      <li key={step.id} className={css.flowStepChip}>
                        <span>{idx + 1}. {step.name}</span>
                        {step.skills.map(sk => <Tag key={sk} tone="info">/{sk}</Tag>)}
                        {step.readOnly ? <Tag tone="warning">{t('flow.badge.readOnly')}</Tag> : null}
                        {step.onFail !== undefined ? <Tag tone="neutral">{t('flow.onFailShort', { target: step.onFail })}</Tag> : null}
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
          </div>
        )}

      {/* Flow Editor Modal */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingFlowId === undefined ? t('flow.add.title') : t('flow.edit.title')}
        closeLabel={t('flow.cancel')}
        className={css.flowEditorModal ?? ''}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)}>{t('flow.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void submitFlow() }}>{t('flow.save')}</Button>
          </>
        )}
      >
        <div className={css.modalBody}>
          <label className={css.field}>
            <span>{t('flow.name')}</span>
            <input
              className={css.input}
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder={t('flow.namePlaceholder')}
            />
          </label>
          <label className={css.field}>
            <span>{t('flow.whenLabel')}</span>
            <textarea
              className={css.textarea}
              rows={2}
              value={form.when}
              onChange={e => setForm(prev => ({ ...prev, when: e.target.value }))}
              placeholder={t('flow.whenPlaceholder')}
            />
          </label>
          <div className={css.rowSplit}>
            <div className={css.field}>
              <span>{t('flow.workspaceModeLabel')}</span>
              <DshSelect
                value={form.workspaceMode}
                onChange={value => setForm(prev => ({ ...prev, workspaceMode: value as WorkspaceMode }))}
                options={WORKSPACE_MODES.map(mode => ({
                  value: mode,
                  label: t(`flow.workspaceMode.${mode}`),
                }))}
              />
            </div>
            <label className={css.checkboxField}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
              />
              <span>{t('route.enabled')}</span>
            </label>
          </div>

          <div className={css.stepsHeader}>
            <strong>{t('flow.stepsTitle')}</strong>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setForm(prev => ({ ...prev, steps: [...prev.steps, emptyStep(prev.steps.length)] }))}
            >
              {t('flow.stepAdd')}
            </Button>
          </div>

          <div className={css.stepsEditorList}>
            {form.steps.map((step, sIdx) => {
              const toggleSkill = (name: string): void => {
                setForm(prev => ({
                  ...prev,
                  steps: prev.steps.map((item, idx) => {
                    if (idx !== sIdx) return item
                    const has = item.skills.includes(name)
                    return {
                      ...item,
                      skills: has ? item.skills.filter(s => s !== name) : [...item.skills, name],
                    }
                  }),
                }))
              }
              const updateStep = (patch: Partial<StepForm>): void => {
                setForm(prev => ({
                  ...prev,
                  steps: prev.steps.map((item, idx) => (idx === sIdx ? { ...item, ...patch } : item)),
                }))
              }
              return (
                <div key={`${step.id}-${sIdx}`} className={css.stepEditorCard}>
                  <div className={css.stepEditorHead}>
                    <strong>{t('flow.stepIndex', { n: sIdx + 1 })}</strong>
                    {form.steps.length > 1
                      ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setForm(prev => ({
                            ...prev,
                            steps: prev.steps.filter((_, idx) => idx !== sIdx),
                          }))}
                        >
                          {t('flow.remove')}
                        </Button>
                      )
                      : null}
                  </div>
                  <div className={css.rowSplit}>
                    <label className={css.field}>
                      <span>{t('flow.stepName')}</span>
                      <input
                        className={css.input}
                        value={step.name}
                        onChange={e => updateStep({ name: e.target.value })}
                      />
                    </label>
                    <label className={css.field}>
                      <span>{t('flow.stepId')}</span>
                      <input
                        className={css.input}
                        value={step.id}
                        onChange={e => updateStep({ id: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className={css.field}>
                    <span>{t('flow.stepSkills')}</span>
                    {skills.length > 0
                      ? (
                        <div className={css.skillPicker}>
                          {skills.map(sk => {
                            const active = step.skills.includes(sk.name)
                            return (
                              <button
                                key={sk.name}
                                type="button"
                                className={active ? css.skillPillActive : css.skillPill}
                                onClick={() => toggleSkill(sk.name)}
                                title={sk.description || sk.path}
                              >
                                /{sk.name}
                              </button>
                            )
                          })}
                        </div>
                      )
                      : null}
                    <input
                      className={css.input}
                      value={step.customSkill}
                      onChange={e => updateStep({ customSkill: e.target.value })}
                      placeholder={t('flow.stepCustomSkillPlaceholder')}
                    />
                  </div>
                  <label className={css.field}>
                    <span>{t('flow.stepGoal')}</span>
                    <textarea
                      className={css.textarea}
                      rows={2}
                      value={step.goal}
                      onChange={e => updateStep({ goal: e.target.value })}
                      placeholder={t('flow.stepGoalPlaceholder')}
                    />
                  </label>
                  <div className={css.rowSplit}>
                    <label className={css.checkboxField}>
                      <input
                        type="checkbox"
                        checked={step.readOnly}
                        onChange={e => updateStep({ readOnly: e.target.checked })}
                      />
                      <span>{t('flow.badge.readOnly')}</span>
                    </label>
                    <label className={css.checkboxField}>
                      <input
                        type="checkbox"
                        checked={step.humanConfirm}
                        onChange={e => updateStep({ humanConfirm: e.target.checked })}
                      />
                      <span>{t('flow.badge.confirm')}</span>
                    </label>
                  </div>
                  <div className={css.rowSplit}>
                    <div className={css.field}>
                      <span>{t('flow.onFailLabel')}</span>
                      <DshSelect
                        value={step.onFail}
                        onChange={value => updateStep({ onFail: value })}
                        options={[
                          { value: '', label: t('flow.onFail.none') },
                          { value: 'self', label: t('flow.onFail.self') },
                          ...form.steps
                            .filter((_, idx) => idx !== sIdx)
                            .map((other, idx) => ({
                              value: other.id,
                              label: clampLine(`${idx + 1}. ${other.name} (${other.id})`, 28),
                            })),
                        ]}
                      />
                    </div>
                    <div className={css.field}>
                      <span>{t('flow.stepAgent')}</span>
                      <DshSelect
                        value={step.agentKind}
                        onChange={value => updateStep({ agentKind: value as AgentKind })}
                        options={AGENT_KINDS.map((kind) => {
                          const opt = agentKinds.find(k => k.kind === kind)
                          const base = t(`crew.agentKind.${kind}`)
                          return {
                            value: kind,
                            label: opt !== undefined && !opt.available ? t('crew.agentKind.notFoundOption', { name: base }) : base,
                          }
                        })}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {formError !== undefined ? <p className={css.errorText}>{formError}</p> : null}
        </div>
      </Modal>

      {/* Playbook Compiler Modal */}
      <Modal
        open={playbookOpen}
        onClose={() => setPlaybookOpen(false)}
        title={t('flow.playbook.title')}
        closeLabel={t('flow.cancel')}
      >
        <div className={css.modalBody}>
          <p className={css.archSubtitle}>{t('flow.playbook.hint')}</p>
          <SegmentedControl<'skill' | 'file' | 'markdown'>
            id="dsh-playbook-kind"
            value={playbookKind}
            onChange={setPlaybookKind}
            label={t('flow.playbook.title')}
            options={[
              { value: 'skill', label: t('flow.playbook.kind.skill') },
              { value: 'file', label: t('flow.playbook.kind.file') },
              { value: 'markdown', label: t('flow.playbook.kind.markdown') },
            ]}
          />
          {playbookKind === 'skill' && skills.length > 0
            ? (
              <div className={css.field}>
                <span>{t('flow.playbook.selectSkill')}</span>
                <DshSelect
                  value={playbookRef}
                  onChange={setPlaybookRef}
                  options={skills.map(s => ({ value: s.name, label: `${s.name} (${s.path})` }))}
                />
              </div>
            )
            : (
              <label className={css.field}>
                <span>{playbookKind === 'file' ? t('flow.playbook.filePath') : t('flow.playbook.refName')}</span>
                <input
                  className={css.input}
                  value={playbookRef}
                  onChange={e => setPlaybookRef(e.target.value)}
                  placeholder={playbookKind === 'file' ? '/path/to/playbook.md' : 'knowledge-playbook'}
                />
              </label>
            )}
          {playbookKind === 'markdown'
            ? (
              <label className={css.field}>
                <span>{t('flow.playbook.markdownBody')}</span>
                <textarea
                  className={css.textarea}
                  rows={8}
                  value={playbookContent}
                  onChange={e => setPlaybookContent(e.target.value)}
                  placeholder={t('flow.playbook.markdownPlaceholder')}
                />
              </label>
            )
            : null}
          <label className={css.checkboxField}>
            <input
              type="checkbox"
              checked={playbookUseLlm}
              onChange={e => setPlaybookUseLlm(e.target.checked)}
            />
            <span>{t('flow.playbook.useLlm')}</span>
          </label>
          {playbookError !== undefined ? <p className={css.errorText}>{playbookError}</p> : null}
          <div className={css.modalActions}>
            <Button variant="ghost" size="sm" onClick={() => setPlaybookOpen(false)}>{t('flow.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={playbookBusy} onClick={() => { void submitPlaybookImport() }}>
              {playbookBusy ? t('flow.playbook.compiling') : t('flow.playbook.submit')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Presets / Discovered Playbooks Modal */}
      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={t('preset.modal.title')}
        closeLabel={t('flow.cancel')}
      >
        <div className={css.modalBody}>
          <div className={css.stepsHeader}>
            <p className={css.archSubtitle}>{t('preset.modal.hint')}</p>
            <Button variant="ghost" size="sm" onClick={() => { void onPlaybookCatalogRefresh() }}>
              {t('skills.refresh')}
            </Button>
          </div>
          {presetError !== undefined ? <p className={css.errorText}>{presetError}</p> : null}
          {playbooks.length === 0
            ? <p className={css.empty}>{t('preset.empty')}</p>
            : (
              <div className={css.presetList}>
                {playbooks.map(preset => (
                  <div key={preset.id} className={css.presetCard}>
                    <div className={css.presetHead}>
                      <strong>{preset.name}</strong>
                      <div className={css.inspectorBadges}>
                        <Tag tone={preset.source === 'workspace' ? 'success' : 'neutral'}>
                          {t(preset.source === 'workspace' ? 'preset.source.workspace' : 'preset.source.builtin')}
                        </Tag>
                        <Tag tone="info">{preset.workspaceMode}</Tag>
                        <Tag tone="neutral">#{preset.hash.slice(0, 7)}</Tag>
                      </div>
                    </div>
                    <p className={css.archSubtitle}>{preset.when}</p>
                    <p className={css.archSubtitle}><code>{preset.path}</code></p>
                    <div className={css.presetActions}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={presetBusy !== undefined}
                        onClick={() => { void applyPreset(preset.id) }}
                      >
                        {presetBusy === preset.id ? t('preset.copying') : t('preset.copy')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </Modal>

      {/* YAML Export/Import Modal */}
      <Modal
        open={yamlOpen}
        onClose={() => setYamlOpen(false)}
        title={t('flow.yaml.title')}
        closeLabel={t('flow.cancel')}
      >
        <div className={css.modalBody}>
          <p className={css.archSubtitle}>{t('flow.yaml.hint')}</p>
          <textarea
            className={css.textarea}
            rows={12}
            value={yamlText}
            onChange={e => setYamlText(e.target.value)}
          />
          {yamlError !== undefined ? <p className={css.errorText}>{yamlError}</p> : null}
          {yamlNotice !== undefined ? <p className={css.noticeText}>{yamlNotice}</p> : null}
          <div className={css.modalActions}>
            <Button variant="ghost" size="sm" onClick={() => setYamlOpen(false)}>{t('flow.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void importYaml() }}>{t('prompt.import.submit')}</Button>
          </div>
        </div>
      </Modal>
    </section>
  )
}
