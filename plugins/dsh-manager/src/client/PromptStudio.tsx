/**
 * Prompt Studio sub-view inside TeamPage:
 * - Left tree: 8 built-in turns, Pipeline/Stage overrides, and read-only Variable Catalog
 * - Right editor: ordered sections (no drag-reorder), source & lock badges,
 *   Restore Inherited / Restore Default, two-step confirmation Save modal
 * - Live Preview panel: workspace project + ticket/sample selector, non-blocking
 *   missing-variable highlight, and YAML clipboard export / validated import
 */
import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TicketView } from '../board-domain.ts'
import type { ProjectRef } from '../mappings/wire-types.ts'
import type { TurnId } from '../prompt/prompt-sections.ts'
import type { PromptOverrideSource } from '../prompt/prompt-resolve.ts'
import type {
  PromptPreviewView,
  PromptRegistryTurnView,
  PromptRegistryView,
  PromptSaveInput,
} from '../team-config/wire-types.ts'
import type { PromptInjected } from './prompt-source.ts'
import type { TeamConfigInjected } from './team-config-source.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './TeamPage.module.css'

export type PromptStudioProps = InjectFace<PromptInjected & TeamConfigInjected> & PropsLocale<'dshManager'>

type TreeSelection =
  | { readonly kind: 'turn'; readonly turnId: TurnId }
  | { readonly kind: 'pipeline'; readonly pipelineId: string }
  | { readonly kind: 'stage'; readonly pipelineId: string; readonly stageIndex: number }
  | { readonly kind: 'variables' }

const SOURCE_TONE: Record<PromptOverrideSource, 'neutral' | 'info' | 'success' | 'warning'> = {
  builtin: 'neutral',
  global: 'info',
  pipeline: 'success',
  stage: 'warning',
}

interface EffectiveSectionRow {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly defaultText: string
  readonly builtinText: string
  readonly inheritedText: string
  readonly variants?: Readonly<Record<string, string>>
  readonly locked: boolean
  readonly effectiveText: string
  readonly effectiveSource: PromptOverrideSource
  readonly currentScopeOverride?: string
  readonly hasParentOverride: boolean
}

function isDraftDirty(row: EffectiveSectionRow, draft: string | null | undefined): boolean {
  if (row.locked || draft === undefined) return false
  if (draft === null) return row.currentScopeOverride !== undefined
  if (row.currentScopeOverride !== undefined) return draft !== row.currentScopeOverride
  return draft !== row.inheritedText
}

function computeEffectiveSections(
  registry: PromptRegistryView,
  selection: Exclude<TreeSelection, { readonly kind: 'variables' }>,
): {
  readonly turn: PromptRegistryTurnView
  readonly scope: 'global' | 'pipeline' | 'stage'
  readonly pipelineId?: string
  readonly pipelineName?: string
  readonly stageIndex?: number
  readonly stageMemberName?: string
  readonly rows: readonly EffectiveSectionRow[]
} | undefined {
  const pipeline = selection.kind === 'turn'
    ? undefined
    : registry.pipelines.find(p => p.id === selection.pipelineId)
  const stage = selection.kind === 'stage'
    ? pipeline?.stages.find(s => s.index === selection.stageIndex)
    : undefined
  const turnId: TurnId = selection.kind === 'turn'
    ? selection.turnId
    : (stage?.memberAgentKind !== undefined && stage.memberAgentKind !== 'builtin' ? 'external-cli' : 'executor')
  const turn = registry.turns.find(t => t.id === turnId)
  if (turn === undefined) return undefined

  const globalMap = registry.globalPrompts?.turns?.[turnId]?.sections ?? {}
  const pipelineMap = pipeline?.prompt?.sections ?? {}
  const stageMap = stage?.prompt?.sections ?? {}

  const scope: 'global' | 'pipeline' | 'stage' = selection.kind === 'turn'
    ? 'global'
    : selection.kind === 'pipeline'
      ? 'pipeline'
      : 'stage'

  const rows: EffectiveSectionRow[] = turn.sections.map((sec) => {
    const builtinText = stage?.mode === 'review' && sec.variants?.review !== undefined
      ? sec.variants.review
      : sec.defaultText

    if (sec.locked) {
      return {
        id: sec.id,
        label: sec.label,
        description: sec.description,
        defaultText: builtinText,
        builtinText,
        inheritedText: builtinText,
        ...(sec.variants === undefined ? {} : { variants: sec.variants }),
        locked: true,
        effectiveText: builtinText,
        effectiveSource: 'builtin',
        hasParentOverride: false,
      }
    }

    const gVal = globalMap[sec.id]
    const pVal = selection.kind === 'turn' ? undefined : pipelineMap[sec.id]
    const sVal = selection.kind === 'stage' ? stageMap[sec.id] : undefined

    const inheritedText = scope === 'global'
      ? builtinText
      : scope === 'pipeline'
        ? (gVal ?? builtinText)
        : (pVal ?? gVal ?? builtinText)

    let effectiveText = builtinText
    let effectiveSource: PromptOverrideSource = 'builtin'
    if (sVal !== undefined) {
      effectiveText = sVal
      effectiveSource = 'stage'
    } else if (pVal !== undefined) {
      effectiveText = pVal
      effectiveSource = 'pipeline'
    } else if (gVal !== undefined) {
      effectiveText = gVal
      effectiveSource = 'global'
    }

    const currentScopeOverride = scope === 'global'
      ? gVal
      : scope === 'pipeline'
        ? pVal
        : sVal

    const hasParentOverride = scope === 'stage'
      ? (pVal !== undefined || gVal !== undefined)
      : scope === 'pipeline'
        ? gVal !== undefined
        : false

    return {
      id: sec.id,
      label: sec.label,
      description: sec.description,
      defaultText: sec.defaultText,
      builtinText,
      inheritedText,
      ...(sec.variants === undefined ? {} : { variants: sec.variants }),
      locked: false,
      effectiveText,
      effectiveSource,
      ...(currentScopeOverride === undefined ? {} : { currentScopeOverride }),
      hasParentOverride,
    }
  })

  return {
    turn,
    scope,
    ...(pipeline === undefined ? {} : { pipelineId: pipeline.id, pipelineName: pipeline.name }),
    ...(stage === undefined ? {} : { stageIndex: stage.index, stageMemberName: stage.memberName }),
    rows,
  }
}

export function PromptStudio({
  usePrompts,
  useTeamConfig,
  onPromptRefresh,
  onPromptSave,
  onPromptImportYaml,
  onPromptPreview,
  onPromptProjects,
  onPromptTickets,
  t,
}: PromptStudioProps) {
  const promptSnap = usePrompts(s => s)
  const teamConfigSnap = useTeamConfig(s => s)
  const registry = promptSnap.registry

  const [selection, setSelection] = useState<TreeSelection>({ kind: 'turn', turnId: 'executor' })
  // Draft values keyed by section id (only present when modified or cleared relative to current scope)
  const [drafts, setDrafts] = useState<Record<string, string | null>>({})
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [copiedYaml, setCopiedYaml] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | undefined>()
  const [exportModalOpen, setExportModalOpen] = useState(false)

  // Preview state
  const [projects, setProjects] = useState<readonly ProjectRef[]>([])
  const [tickets, setTickets] = useState<readonly TicketView[]>([])
  const [previewProjectId, setPreviewProjectId] = useState('')
  const [previewTicketId, setPreviewTicketId] = useState('')
  const [preview, setPreview] = useState<PromptPreviewView | undefined>()
  const [previewLoading, setPreviewLoading] = useState(false)

  // Clear local drafts when switching node
  useEffect(() => {
    setDrafts({})
    setSaveError(undefined)
  }, [selection])

  // Refresh project & ticket choices once mounted
  useEffect(() => {
    let alive = true
    void onPromptProjects().then((list) => {
      if (alive) setProjects(list)
    })
    void onPromptTickets().then((list) => {
      if (alive) setTickets(list)
    })
    return () => { alive = false }
  }, [onPromptProjects, onPromptTickets])

  // If selected pipeline/stage disappeared on hot-reload, fall back to executor turn
  useEffect(() => {
    if (registry === undefined) return
    if (selection.kind === 'pipeline' && !registry.pipelines.some(p => p.id === selection.pipelineId)) {
      setSelection({ kind: 'turn', turnId: 'executor' })
    } else if (selection.kind === 'stage') {
      const pipe = registry.pipelines.find(p => p.id === selection.pipelineId)
      if (pipe === undefined || !pipe.stages.some(s => s.index === selection.stageIndex)) {
        setSelection({ kind: 'turn', turnId: 'executor' })
      }
    }
  }, [registry, selection])

  const effective = useMemo(() => {
    if (registry === undefined || selection.kind === 'variables') return undefined
    return computeEffectiveSections(registry, selection)
  }, [registry, selection])

  // Re-render live preview whenever selection, drafts, project, ticket, or registry revision changes
  useEffect(() => {
    if (effective === undefined) return
    let alive = true
    const draftSections: Record<string, string | null> = {}
    for (const row of effective.rows) {
      if (row.locked) continue
      const d = drafts[row.id]
      if (typeof d === 'string') draftSections[row.id] = d
      else if (d === null && row.currentScopeOverride !== undefined) draftSections[row.id] = null
    }
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      void onPromptPreview({
        turnId: effective.turn.id,
        ...(effective.pipelineId === undefined ? {} : { pipelineId: effective.pipelineId }),
        ...(effective.stageIndex === undefined ? {} : { stageIndex: effective.stageIndex }),
        ...(previewProjectId === '' ? {} : { projectId: previewProjectId }),
        ...(previewTicketId === '' ? {} : { ticketId: previewTicketId }),
        ...(Object.keys(draftSections).length === 0 ? {} : { draftSections }),
      }).then((res) => {
        if (!alive) return
        setPreview(res)
        setPreviewLoading(false)
      }).catch(() => {
        if (alive) setPreviewLoading(false)
      })
    }, 80)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [effective, drafts, previewProjectId, previewTicketId, registry?.status.revision, onPromptPreview])

  if (promptSnap.status === 'loading' && registry === undefined) {
    return <p className={css.emptyInline}>{t('prompt.loading')}</p>
  }

  if (promptSnap.status === 'error' && registry === undefined) {
    return (
      <div className={css.empty}>
        <p>{t('prompt.error')}</p>
        <Button variant="outline" size="sm" onClick={() => { void onPromptRefresh() }}>
          {t('prompt.retry')}
        </Button>
      </div>
    )
  }

  if (registry === undefined) return null

  const liveRevision = teamConfigSnap.configStatus?.revision ?? registry.status.revision
  const staleRevision = liveRevision !== registry.status.revision

  const pendingChanges = Object.entries(drafts)
    .filter(([secId, val]) => {
      const row = effective?.rows.find(r => r.id === secId)
      return row !== undefined && isDraftDirty(row, val)
    })

  const targetSummaryLabel = effective === undefined
    ? ''
    : effective.scope === 'global'
      ? effective.turn.label
      : effective.scope === 'pipeline'
        ? `${effective.pipelineName ?? effective.pipelineId} · ${effective.turn.label}`
        : `${effective.pipelineName ?? effective.pipelineId} #${(effective.stageIndex ?? 0) + 1} (${effective.stageMemberName ?? ''}) · ${effective.turn.label}`

  const buildSaveInput = (): PromptSaveInput | undefined => {
    if (effective === undefined || pendingChanges.length === 0) return undefined
    return {
      scope: effective.scope,
      ...(effective.scope === 'global' ? { turnId: effective.turn.id } : {}),
      ...(effective.pipelineId === undefined ? {} : { pipelineId: effective.pipelineId }),
      ...(effective.stageIndex === undefined ? {} : { stageIndex: effective.stageIndex }),
      sections: Object.fromEntries(pendingChanges),
    }
  }

  const confirmSave = (): void => {
    const input = buildSaveInput()
    if (input === undefined) return
    setSaveError(undefined)
    void onPromptSave(input).then((res) => {
      if (!res.ok) {
        setSaveError(res.error ?? t('prompt.save.failed'))
        return
      }
      setDrafts({})
      setSaveConfirmOpen(false)
    })
  }

  const handleExportYaml = (): void => {
    setCopiedYaml(false)
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
      void navigator.clipboard.writeText(registry.yaml).then(() => {
        setCopiedYaml(true)
      }).catch(() => {
        setExportModalOpen(true)
      })
    } else {
      setExportModalOpen(true)
    }
  }

  const handleImportSubmit = (): void => {
    setImportError(undefined)
    void onPromptImportYaml(importText).then((res) => {
      if (!res.ok) {
        setImportError(res.error ?? t('prompt.import.failed'))
        return
      }
      setImportModalOpen(false)
      setImportText('')
      setDrafts({})
    })
  }

  const displayValueOf = (row: EffectiveSectionRow): string => {
    if (row.locked) return row.builtinText
    const draft = drafts[row.id]
    if (typeof draft === 'string') return draft
    if (draft === null) return row.inheritedText
    return row.effectiveText
  }

  return (
    <div id="dsh-team-prompt" className={css.promptStudio}>
      <div className={css.promptToolbar}>
        <div className={css.promptMeta}>
          <code className={css.detailPath}>{registry.status.filePath}</code>
          <Tag tone="neutral">v{registry.status.revision}</Tag>
          <span className={css.promptSavedAt}>
            {t('prompt.toolbar.savedAt', { time: new Date(registry.status.loadedAt).toLocaleTimeString() })}
          </span>
          {staleRevision
            ? (
              <Button variant="outline" size="sm" onClick={() => { void onPromptRefresh() }}>
                {t('prompt.toolbar.staleRefresh')}
              </Button>
            )
            : null}
        </div>
        <div className={css.promptToolbarActions}>
          <Button variant="outline" size="sm" onClick={handleExportYaml}>
            {copiedYaml ? t('prompt.toolbar.exported') : t('prompt.toolbar.export')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setImportText(registry.yaml)
              setImportError(undefined)
              setImportModalOpen(true)
            }}
          >
            {t('prompt.toolbar.import')}
          </Button>
        </div>
      </div>

      <div className={css.promptGrid}>
        <aside className={css.promptTree} aria-label={t('prompt.tree.label')}>
          <div className={css.promptTreeGroup}>
            <div className={css.promptTreeGroupTitle}>{t('prompt.tree.turns')}</div>
            <ul className={css.promptTreeList}>
              {registry.turns.map((turn) => {
                const active = selection.kind === 'turn' && selection.turnId === turn.id
                const overrideCount = Object.keys(registry.globalPrompts?.turns?.[turn.id]?.sections ?? {}).length
                return (
                  <li key={turn.id}>
                    <button
                      type="button"
                      id={`dsh-prompt-node-turn-${turn.id}`}
                      className={`${css.promptTreeBtn}${active ? ` ${css.promptTreeBtnActive}` : ''}`}
                      onClick={() => { setSelection({ kind: 'turn', turnId: turn.id }) }}
                    >
                      <span>{turn.label}</span>
                      {overrideCount > 0 ? <Tag tone="info">{overrideCount}</Tag> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className={css.promptTreeGroup}>
            <div className={css.promptTreeGroupTitle}>{t('prompt.tree.pipelines')}</div>
            {registry.pipelines.length === 0
              ? <p className={css.emptyInline}>{t('prompt.tree.noPipelines')}</p>
              : (
                <ul className={css.promptTreeList}>
                  {registry.pipelines.map((pipeline) => {
                    const pipeActive = selection.kind === 'pipeline' && selection.pipelineId === pipeline.id
                    const pipeOverrides = Object.keys(pipeline.prompt?.sections ?? {}).length
                    return (
                      <li key={pipeline.id} className={css.promptTreePipeline}>
                        <button
                          type="button"
                          id={`dsh-prompt-node-pipeline-${pipeline.id}`}
                          className={`${css.promptTreeBtn}${pipeActive ? ` ${css.promptTreeBtnActive}` : ''}`}
                          onClick={() => { setSelection({ kind: 'pipeline', pipelineId: pipeline.id }) }}
                        >
                          <span>{pipeline.name}</span>
                          {pipeOverrides > 0 ? <Tag tone="success">{pipeOverrides}</Tag> : null}
                        </button>
                        <ul className={css.promptTreeSubList}>
                          {pipeline.stages.map((st) => {
                            const stageActive = selection.kind === 'stage'
                              && selection.pipelineId === pipeline.id
                              && selection.stageIndex === st.index
                            const stOverrides = Object.keys(st.prompt?.sections ?? {}).length
                            return (
                              <li key={`${pipeline.id}-${st.index}`}>
                                <button
                                  type="button"
                                  id={`dsh-prompt-node-stage-${pipeline.id}-${st.index}`}
                                  className={`${css.promptTreeBtn}${stageActive ? ` ${css.promptTreeBtnActive}` : ''}`}
                                  onClick={() => {
                                    setSelection({ kind: 'stage', pipelineId: pipeline.id, stageIndex: st.index })
                                  }}
                                >
                                  <span>{st.index + 1}. {st.memberName}</span>
                                  {stOverrides > 0 ? <Tag tone="warning">{stOverrides}</Tag> : null}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    )
                  })}
                </ul>
              )}
          </div>

          <div className={css.promptTreeGroup}>
            <div className={css.promptTreeGroupTitle}>{t('prompt.tree.variables')}</div>
            <button
              type="button"
              id="dsh-prompt-node-variables"
              className={`${css.promptTreeBtn}${selection.kind === 'variables' ? ` ${css.promptTreeBtnActive}` : ''}`}
              onClick={() => { setSelection({ kind: 'variables' }) }}
            >
              <span>{t('prompt.variables.catalogTitle')}</span>
              <Tag tone="neutral">{registry.variables.length}</Tag>
            </button>
          </div>
        </aside>

        <div className={css.promptWorkspace}>
          {selection.kind === 'variables'
            ? (
              <section className={css.promptPanel} aria-label={t('prompt.variables.catalogTitle')}>
                <header className={css.promptPanelHeader}>
                  <div>
                    <h3 className={css.panelTitle}>{t('prompt.variables.catalogTitle')}</h3>
                    <p className={css.panelHint}>{t('prompt.variables.catalogHint')}</p>
                  </div>
                </header>
                <div className={css.promptVarsTable}>
                  {registry.variables.map(v => (
                    <div key={v.name} className={css.promptVarRow}>
                      <code className={css.promptVarName}>{`{{${v.name}}}`}</code>
                      <Tag tone="neutral">{v.group}</Tag>
                      <span className={css.promptVarDesc}>{v.description}</span>
                      <span className={css.promptVarSource}>{v.source}</span>
                    </div>
                  ))}
                </div>
              </section>
            )
            : effective !== undefined
              ? (
                <>
                  <section className={css.promptPanel}>
                    <header className={css.promptPanelHeader}>
                      <div>
                        <h3 className={css.panelTitle}>
                          {effective.turn.label}
                          {effective.scope === 'pipeline' ? ` · ${t('prompt.scope.pipeline')}` : ''}
                          {effective.scope === 'stage' && effective.stageIndex !== undefined
                            ? ` · ${t('prompt.scope.stage', { index: effective.stageIndex + 1 })}`
                            : ''}
                        </h3>
                        <p className={css.panelHint}>{effective.turn.description}</p>
                      </div>
                      <div className={css.promptSaveRow}>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={pendingChanges.length === 0 || promptSnap.busy === true}
                          onClick={() => {
                            setSaveError(undefined)
                            setSaveConfirmOpen(true)
                          }}
                        >
                          {t('prompt.save.button', { count: pendingChanges.length })}
                        </Button>
                      </div>
                    </header>

                    {saveError !== undefined
                      ? <p className={css.formError} role="alert">{saveError}</p>
                      : null}

                    {effective.turn.dataBlocks.length > 0
                      ? (
                        <div className={css.promptDataBlocks}>
                          <span className={css.promptDataBlockLabel}>{t('prompt.dataBlocks.title')}</span>
                          {effective.turn.dataBlocks.map(block => (
                            <Tag key={block.id} tone="neutral">{block.label}</Tag>
                          ))}
                        </div>
                      )
                      : null}

                    <ul className={css.promptSectionList}>
                      {effective.rows.map((row, idx) => {
                        const value = displayValueOf(row)
                        const draft = drafts[row.id]
                        const dirty = isDraftDirty(row, draft)
                        const canRestoreInherited = !row.locked
                          && effective.scope !== 'global'
                          && (row.currentScopeOverride !== undefined || typeof draft === 'string')
                        const canRestoreDefault = !row.locked && (
                          row.currentScopeOverride !== undefined
                          || typeof draft === 'string'
                          || (row.hasParentOverride && row.effectiveText !== row.builtinText)
                        )

                        return (
                          <li
                            key={row.id}
                            id={`dsh-prompt-section-${row.id}`}
                            className={css.promptSectionCard}
                            data-locked={row.locked ? 'true' : 'false'}
                          >
                            <div className={css.promptSectionHeader}>
                              <span className={css.stageIndex}>{idx + 1}</span>
                              <strong className={css.promptSectionTitle}>{row.label}</strong>
                              <code className={css.detailPath}>{row.id}</code>
                              <Tag tone={SOURCE_TONE[row.effectiveSource]}>
                                {t(`board.detail.dispatch.prompt.source.${row.effectiveSource}`)}
                              </Tag>
                              {row.locked
                                ? <Tag tone="warning">{t('prompt.section.lockedBadge')}</Tag>
                                : null}
                              {dirty
                                ? <Tag tone="info">{t('prompt.section.modifiedBadge')}</Tag>
                                : null}
                              <div className={css.promptSectionActions}>
                                {canRestoreInherited
                                  ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        setDrafts((prev) => {
                                          const next = { ...prev }
                                          if (row.currentScopeOverride !== undefined) next[row.id] = null
                                          else delete next[row.id]
                                          return next
                                        })
                                      }}
                                    >
                                      {t('prompt.section.restoreInherited')}
                                    </Button>
                                  )
                                  : null}
                                {canRestoreDefault
                                  ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        setDrafts((prev) => {
                                          const next = { ...prev }
                                          if (effective.scope === 'global' || !row.hasParentOverride) {
                                            if (row.currentScopeOverride !== undefined) next[row.id] = null
                                            else delete next[row.id]
                                          } else {
                                            next[row.id] = row.builtinText
                                          }
                                          return next
                                        })
                                      }}
                                    >
                                      {t('prompt.section.restoreDefault')}
                                    </Button>
                                  )
                                  : null}
                              </div>
                            </div>
                            <p className={css.promptSectionDesc}>{row.description}</p>
                            {row.locked
                              ? (
                                <pre
                                  className={css.promptLockedPre}
                                  aria-label={`${row.id} (${t('prompt.section.lockedBadge')})`}
                                >
                                  {row.defaultText}
                                </pre>
                              )
                              : (
                                <textarea
                                  id={`dsh-prompt-input-${row.id}`}
                                  aria-label={`${row.label} (${row.id})`}
                                  className={css.promptTextArea}
                                  value={value}
                                  rows={Math.min(10, Math.max(2, value.split('\n').length))}
                                  onChange={(e) => {
                                    const nextText = e.target.value
                                    setDrafts(prev => ({ ...prev, [row.id]: nextText }))
                                  }}
                                />
                              )}
                          </li>
                        )
                      })}
                    </ul>
                  </section>

                  <section className={css.promptPanel} aria-label={t('prompt.preview.title')}>
                    <header className={css.promptPanelHeader}>
                      <div>
                        <h3 className={css.panelTitle}>{t('prompt.preview.title')}</h3>
                        <p className={css.panelHint}>{t('prompt.preview.hint')}</p>
                      </div>
                      <div className={css.promptPreviewControls}>
                        <DshSelect
                          ariaLabel={t('prompt.preview.project')}
                          value={previewProjectId}
                          onChange={setPreviewProjectId}
                          options={[
                            { value: '', label: t('prompt.preview.sampleProject') },
                            ...projects.map(p => ({ value: p.id, label: p.name })),
                          ]}
                        />
                        <DshSelect
                          ariaLabel={t('prompt.preview.ticket')}
                          value={previewTicketId}
                          onChange={setPreviewTicketId}
                          options={[
                            { value: '', label: t('prompt.preview.sampleTicket') },
                            ...tickets.slice(0, 30).map(tk => ({ value: tk.id, label: `${tk.id} · ${tk.title}` })),
                          ]}
                        />
                      </div>
                    </header>

                    {preview !== undefined && preview.unknownVars.length > 0
                      ? (
                        <div className={css.formError} role="alert">
                          {t('prompt.preview.unknownVars', { vars: preview.unknownVars.join(', ') })}
                        </div>
                      )
                      : null}

                    {preview !== undefined && preview.missingVars.length > 0
                      ? (
                        <div className={css.promptWarnBanner}>
                          {t('prompt.preview.missingVars', { vars: preview.missingVars.join(', ') })}
                        </div>
                      )
                      : null}

                    {preview !== undefined && preview.truncated
                      ? (
                        <div className={css.promptWarnBanner}>
                          {t('board.detail.dispatch.prompt.truncated')}
                        </div>
                      )
                      : null}

                    <pre id="dsh-prompt-preview-output" className={css.promptPreviewPre}>
                      {previewLoading && preview === undefined
                        ? t('prompt.preview.loading')
                        : (preview?.text ?? '')}
                    </pre>
                  </section>
                </>
              )
              : null}
        </div>
      </div>

      <Modal
        open={saveConfirmOpen}
        onClose={() => { setSaveConfirmOpen(false) }}
        title={t('prompt.save.confirmTitle')}
        closeLabel={t('board.detail.close')}
      >
        <div className={css.promptConfirmBody}>
          <p className={css.panelTitle}>{t('prompt.save.confirmTarget', { target: targetSummaryLabel })}</p>
          <p className={css.panelHint}>{t('prompt.save.confirmHint')}</p>
          <p className={css.panelHint}>{t('prompt.save.activePipelinesNote')}</p>
          <ul className={css.promptConfirmList}>
            {pendingChanges.map(([secId, val]) => (
              <li key={secId}>
                <code>{secId}</code> →{' '}
                {val === null
                  ? t('prompt.save.actionClear')
                  : t('prompt.save.actionOverride', { scope: effective?.scope ?? 'global' })}
              </li>
            ))}
          </ul>
          {saveError !== undefined
            ? <p className={css.formError} role="alert">{saveError}</p>
            : null}
          <div className={css.modalFooter}>
            <Button variant="ghost" size="sm" onClick={() => { setSaveConfirmOpen(false) }}>
              {t('crew.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={promptSnap.busy === true}
              onClick={confirmSave}
            >
              {t('prompt.save.confirmSubmit')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={importModalOpen}
        onClose={() => { setImportModalOpen(false) }}
        title={t('prompt.import.title')}
        closeLabel={t('board.detail.close')}
      >
        <div className={css.promptConfirmBody}>
          <p className={css.panelHint}>{t('prompt.import.hint')}</p>
          <textarea
            aria-label={t('prompt.import.title')}
            className={css.promptTextArea}
            rows={12}
            value={importText}
            onChange={(e) => { setImportText(e.target.value) }}
          />
          {importError !== undefined
            ? <p className={css.formError} role="alert">{importError}</p>
            : null}
          <div className={css.modalFooter}>
            <Button variant="ghost" size="sm" onClick={() => { setImportModalOpen(false) }}>
              {t('crew.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={promptSnap.busy === true} onClick={handleImportSubmit}>
              {t('prompt.import.submit')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={exportModalOpen}
        onClose={() => { setExportModalOpen(false) }}
        title={t('prompt.toolbar.export')}
        closeLabel={t('board.detail.close')}
      >
        <div className={css.promptConfirmBody}>
          <pre className={css.promptPreviewPre}>{registry.yaml}</pre>
          <div className={css.modalFooter}>
            <Button variant="primary" size="sm" onClick={() => { setExportModalOpen(false) }}>
              {t('board.detail.close')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
