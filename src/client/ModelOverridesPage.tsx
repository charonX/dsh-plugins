/**
 * The plugin's settings page: everything this plugin edits, in one place.
 *
 * Nothing is injected into the official Models page any more. This page owns:
 * adding a route from a snapshot preset, the gateway-level compat block of each
 * route, and the per-model overrides inside it. Rows come from the settings
 * describe mirror, so what is listed is what dispatch uses.
 *
 * @module dsh-model-studio/client/ModelOverridesPage
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { Preset, PresetCatalog } from '../shared/preset.ts'
import { CompatFields } from './CompatFields.tsx'
import type { Translate } from './locales.ts'
import type { ModelEntryView, ModelRouteView } from './model-view.ts'
import { EMPTY_DRAFT, compatDraftOf, compatOps, modelCompatOps, type CompatDraft, type PathOp } from './ops.ts'
import { PresetDialog } from './PresetDialog.tsx'
import type { CompatSaveResult, PresetApplyResult } from './results.ts'
import {
  actionsStyle,
  badgeStyle,
  codeStyle,
  errorStyle,
  firstModelRowStyle,
  groupHeaderStyle,
  groupStyle,
  groupTitleStyle,
  hintStyle,
  metaStyle,
  modelListStyle,
  modelNameStyle,
  modelRowStyle,
  modelSummaryStyle,
  noticeStyle,
  overridePanelStyle,
  pageTitleStyle,
  primaryButtonStyle,
  quietButtonStyle,
  rowActionStyle,
} from './tokens.ts'

/** Props of {@link ModelOverridesPage}. */
export interface ModelOverridesPageProps {
  /** Localizer bound to this plugin's namespace. */
  t: Translate
  /** Loaded routes with their declared models. */
  routes: readonly ModelRouteView[]
  /** Whether a provider namespace is served. */
  available: boolean
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Snapshot catalogue offered by the preset dialog. */
  catalog: PresetCatalog
  /** Route ids the page already knows, for the preset conflict check. */
  knownRouteIds: ReadonlySet<string>
  /** Set when the provider directory could not be read. */
  presetsUnavailable?: boolean
  /** Writer for model-level overrides. */
  onSaveModel(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
  /** Writer for a route's gateway-level compat block. */
  onSaveRoute(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
  /** Writer for a whole preset. */
  onApplyPreset(preset: Preset): Promise<PresetApplyResult>
}

/**
 * Render the model-studio page.
 * @param props - loaded routes, write capability, catalogue, and writers.
 * @returns the settings page body.
 */
export function ModelOverridesPage(props: ModelOverridesPageProps): ReactNode {
  const { t, routes, available, writable, catalog, knownRouteIds, presetsUnavailable = false } = props
  const [presetOpen, setPresetOpen] = useState(false)
  const disabled = !available || !writable

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={pageTitleStyle}>{t('modelsTitle')}</h2>
        <button
          type="button"
          style={{ ...quietButtonStyle, marginLeft: 'auto' }}
          disabled={disabled}
          onClick={() => setPresetOpen(true)}
        >
          {t('presetsTrigger')}
        </button>
      </div>
      <p style={hintStyle}>{t('modelsHint')}</p>
      {!available ? <p style={errorStyle}>{t('modelsUnavailable')}</p> : null}
      {available && !writable ? <p style={errorStyle}>{t('modelsReadOnly')}</p> : null}
      {routes.length === 0
        ? <p style={hintStyle}>{t('modelsEmpty')}</p>
        : routes.map(route => (
          <RouteGroup
            key={route.routeId}
            t={t}
            route={route}
            disabled={disabled}
            onSaveModel={props.onSaveModel}
            onSaveRoute={props.onSaveRoute}
          />
        ))}
      {presetOpen
        ? (
          <PresetDialog
            t={t}
            catalog={catalog}
            knownRouteIds={knownRouteIds}
            writable={writable}
            unavailable={presetsUnavailable}
            onApply={props.onApplyPreset}
            onClose={() => setPresetOpen(false)}
          />
        )
        : null}
    </section>
  )
}

/** Props of one route group. */
interface RouteGroupProps {
  t: Translate
  route: ModelRouteView
  disabled: boolean
  onSaveModel(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
  onSaveRoute(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render one route: its gateway-level compat block and its models.
 * @param props - route, write state, and the writers.
 * @returns the route group.
 */
function RouteGroup({ t, route, disabled, onSaveModel, onSaveRoute }: RouteGroupProps): ReactNode {
  return (
    <div style={groupStyle}>
      <div style={groupHeaderStyle}>
        <h3 style={groupTitleStyle}>{route.name}</h3>
        {route.routeId === route.name ? null : <span style={codeStyle}>{route.routeId}</span>}
        <span style={badgeStyle}>{t('modelsCount', { count: route.models.length })}</span>
        {route.baseURL === undefined ? null : <span style={{ ...codeStyle, marginLeft: 'auto' }}>{route.baseURL}</span>}
      </div>
      <RouteCompat t={t} route={route} disabled={disabled} onSave={onSaveRoute} />
      <div style={modelListStyle}>
        {route.models.map((model, position) => (
          <ModelRow
            key={model.path.join('\u0000')}
            t={t}
            model={model}
            first={position === 0}
            disabled={disabled}
            onSave={onSaveModel}
          />
        ))}
      </div>
    </div>
  )
}

/** Props of the route-level compat disclosure. */
interface RouteCompatProps {
  t: Translate
  route: ModelRouteView
  disabled: boolean
  onSave(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render one route's gateway-level compat block behind a disclosure.
 * @param props - route, write state, and the writer.
 * @returns the disclosure.
 */
function RouteCompat({ t, route, disabled, onSave }: RouteCompatProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CompatDraft>(() => compatDraftOf(route.storedCompat))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ readonly kind: 'info' | 'error'; readonly text: string } | undefined>(undefined)

  useEffect(() => {
    setDraft(compatDraftOf(route.storedCompat))
  }, [route.storedCompat])

  const save = async (next: CompatDraft, cleared: boolean): Promise<void> => {
    if (disabled || busy) return
    const parsed = compatOps([...route.path, 'compat'], next)
    if (parsed.error !== undefined) {
      setStatus({ kind: 'error', text: t('compatInvalidKwargs') })
      return
    }
    setBusy(true)
    setStatus(undefined)
    try {
      const result = await onSave(route.path, parsed.ops)
      if (result.kind === 'refused') setStatus({ kind: 'error', text: t('compatFailed', { message: result.message }) })
      else setStatus({ kind: 'info', text: cleared ? t('compatCleared') : t('compatSaved') })
    } catch (failure) {
      setStatus({ kind: 'error', text: t('compatFailed', { message: describe(failure) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        style={{ ...quietButtonStyle, marginLeft: 0 }}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        {open ? t('routeCompatHide') : t('routeCompatEdit')}
      </button>
      {open
        ? (
          <div style={{ ...overridePanelStyle, marginTop: 10 }}>
            <p style={hintStyle}>{t('compatHint')}</p>
            <p style={hintStyle}>{t('compatScope')}</p>
            <CompatFields
              t={t}
              idPrefix={`route-${route.routeId}`}
              draft={draft}
              disabled={disabled || busy}
              onChange={(field, value) => setDraft(current => ({ ...current, [field]: value }))}
            />
            <div style={actionsStyle}>
              <button type="button" style={primaryButtonStyle} disabled={disabled || busy} onClick={() => { void save(draft, false) }}>
                {busy ? t('compatSaving') : t('compatSave')}
              </button>
              <button
                type="button"
                style={quietButtonStyle}
                disabled={disabled || busy}
                onClick={() => { setDraft(EMPTY_DRAFT); void save(EMPTY_DRAFT, true) }}
              >
                {t('compatClear')}
              </button>
            </div>
            {status === undefined ? null : <p style={status.kind === 'error' ? errorStyle : noticeStyle}>{status.text}</p>}
          </div>
        )
        : null}
    </div>
  )
}

/** Props of one model row. */
interface ModelRowProps {
  t: Translate
  model: ModelEntryView
  /** Whether this is the first row of its group (no leading rule). */
  first: boolean
  disabled: boolean
  onSave(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render one model entry with its optional override editor.
 * @param props - model, write state, and the writer.
 * @returns the row.
 */
function ModelRow({ t, model, first, disabled, onSave }: ModelRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CompatDraft>(() => compatDraftOf(model.storedCompat))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ readonly kind: 'info' | 'error'; readonly text: string } | undefined>(undefined)

  // A reloaded document replaces the draft rather than merging stale values.
  useEffect(() => {
    setDraft(compatDraftOf(model.storedCompat))
  }, [model.storedCompat])

  const overridden = Object.values(compatDraftOf(model.storedCompat)).filter(value => value.length > 0)
  const rowKey = `${model.path.join('.')}`

  const save = async (next: CompatDraft, cleared: boolean): Promise<void> => {
    if (disabled || busy) return
    const parsed = modelCompatOps(model.path, next)
    if (parsed.error !== undefined) {
      setStatus({ kind: 'error', text: t('compatInvalidKwargs') })
      return
    }
    setBusy(true)
    setStatus(undefined)
    try {
      const result = await onSave(model.path, parsed.ops)
      if (result.kind === 'refused') setStatus({ kind: 'error', text: t('compatFailed', { message: result.message }) })
      else setStatus({ kind: 'info', text: cleared ? t('compatCleared') : t('compatSaved') })
    } catch (failure) {
      setStatus({ kind: 'error', text: t('compatFailed', { message: describe(failure) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={first ? firstModelRowStyle : modelRowStyle}>
      <div style={modelSummaryStyle}>
        <span style={modelNameStyle}>{model.name}</span>
        {model.id === model.name ? null : <span style={codeStyle}>{model.id}</span>}
        {model.contextWindow === undefined ? null : <span style={metaStyle}>ctx {model.contextWindow}</span>}
        {model.maxTokens === undefined ? null : <span style={metaStyle}>out {model.maxTokens}</span>}
        <span style={metaStyle}>
          {t('modelsEfforts')}
          {' '}
          {model.levels === undefined ? t('modelsNone') : model.levels.join(' / ')}
        </span>
        {overridden.length === 0
          ? null
          : <span style={badgeStyle}>{t('modelsOverridden', { count: overridden.length })}</span>}
        <button
          type="button"
          style={rowActionStyle}
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
          aria-expanded={open}
          aria-controls={rowKey}
        >
          {open ? t('modelOverrideHide') : t('modelOverrideEdit')}
        </button>
      </div>
      {open
        ? (
          <div id={rowKey} style={overridePanelStyle}>
            <CompatFields
              t={t}
              idPrefix={rowKey}
              draft={draft}
              disabled={disabled || busy}
              onChange={(field, value) => setDraft(current => ({ ...current, [field]: value }))}
            />
            <div style={actionsStyle}>
              <button type="button" style={primaryButtonStyle} disabled={disabled || busy} onClick={() => { void save(draft, false) }}>
                {busy ? t('compatSaving') : t('compatSave')}
              </button>
              <button
                type="button"
                style={quietButtonStyle}
                disabled={disabled || busy}
                onClick={() => { setDraft(EMPTY_DRAFT); void save(EMPTY_DRAFT, true) }}
              >
                {t('compatClear')}
              </button>
            </div>
          </div>
        )
        : null}
      {status === undefined ? null : <p style={status.kind === 'error' ? errorStyle : noticeStyle}>{status.text}</p>}
    </div>
  )
}

/**
 * Render an unexpected failure for the status line.
 * @param failure - thrown value.
 * @returns operator-facing text.
 */
function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
