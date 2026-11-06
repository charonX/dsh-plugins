/**
 * Settings page: per-model overrides over the models the harness already loads.
 *
 * The provider-card editor owns gateway-level switches; this page owns the
 * entries inside one route, writing `models[i].compat` so a single model can
 * disagree with its gateway. It reads the same settings document the official
 * Models page edits, so the rows are exactly what dispatch will use.
 *
 * @module dsh-model-studio/client/ModelOverridesPage
 */

import { useEffect, useState, type ReactNode } from 'react'
import { CompatFields } from './CompatFields.tsx'
import type { CompatSaveResult } from './CompatEditor.tsx'
import type { Translate } from './locales.ts'
import type { ModelEntryView, ModelRouteView } from './model-view.ts'
import { EMPTY_DRAFT, compatDraftOf, modelCompatOps, type CompatDraft, type PathOp } from './ops.ts'
import {
  actionsStyle,
  badgeStyle,
  codeStyle,
  errorStyle,
  fieldStyle,
  groupHeaderStyle,
  groupStyle,
  groupTitleStyle,
  hintStyle,
  labelStyle,
  modelRowStyle,
  modelSummaryStyle,
  noticeStyle,
  pageTitleStyle,
  primaryButtonStyle,
  quietButtonStyle,
} from './tokens.ts'

/** Props of {@link ModelOverridesPage}. */
export interface ModelOverridesPageProps {
  /** Localizer bound to this plugin's namespace. */
  t: Translate
  /** Loaded routes with their declared models. */
  routes: readonly ModelRouteView[]
  /** Whether the provider namespace is served. */
  available: boolean
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Writer supplied by the seat; `path` is the model entry being overridden. */
  onSave(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render the model page.
 * @param props - loaded routes, write capability, and the writer.
 * @returns the settings page body.
 */
export function ModelOverridesPage({ t, routes, available, writable, onSave }: ModelOverridesPageProps): ReactNode {
  return (
    <section>
      <h2 style={pageTitleStyle}>{t('modelsTitle')}</h2>
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
            disabled={!available || !writable}
            onSave={onSave}
          />
        ))}
    </section>
  )
}

/** Props of one route group. */
interface RouteGroupProps {
  t: Translate
  route: ModelRouteView
  disabled: boolean
  onSave(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render one route with its models.
 * @param props - route, write state, and the writer.
 * @returns the route group.
 */
function RouteGroup({ t, route, disabled, onSave }: RouteGroupProps): ReactNode {
  return (
    <div style={groupStyle}>
      <div style={groupHeaderStyle}>
        <h3 style={groupTitleStyle}>{route.name}</h3>
        <span style={codeStyle}>{route.routeId}</span>
        {route.baseURL === undefined ? null : <span style={codeStyle}>{route.baseURL}</span>}
        <span style={badgeStyle}>{t('modelsCount', { count: route.models.length })}</span>
      </div>
      {route.models.map(model => (
        <ModelRow key={model.path.join('\u0000')} t={t} model={model} disabled={disabled} onSave={onSave} />
      ))}
    </div>
  )
}

/** Props of one model row. */
interface ModelRowProps {
  t: Translate
  model: ModelEntryView
  disabled: boolean
  onSave(path: readonly string[], ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render one model entry with its optional override editor.
 * @param props - model, write state, and the writer.
 * @returns the row.
 */
function ModelRow({ t, model, disabled, onSave }: ModelRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CompatDraft>(() => compatDraftOf(model.storedCompat))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ readonly kind: 'info' | 'error'; readonly text: string } | undefined>(undefined)

  // A reloaded document replaces the draft rather than merging stale values.
  useEffect(() => {
    setDraft(compatDraftOf(model.storedCompat))
  }, [model.storedCompat])

  const overridden = Object.values(compatDraftOf(model.storedCompat)).filter(value => value.length > 0)
  const routeKey = `${model.path.join('.')}`

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
    <div style={modelRowStyle}>
      <div style={modelSummaryStyle}>
        <strong style={{ fontSize: 13, fontWeight: 500 }}>{model.name}</strong>
        <span style={codeStyle}>{model.id}</span>
        {model.contextWindow === undefined ? null : <span style={codeStyle}>ctx {model.contextWindow}</span>}
        {model.maxTokens === undefined ? null : <span style={codeStyle}>out {model.maxTokens}</span>}
        <span style={codeStyle}>
          {t('modelsEfforts')}
          {' '}
          {model.levels === undefined ? t('modelsNone') : model.levels.join(' / ')}
        </span>
        {overridden.length === 0
          ? null
          : <span style={badgeStyle}>{t('modelsOverridden', { count: overridden.length })}</span>}
        <button
          type="button"
          style={{ ...quietButtonStyle, marginLeft: 'auto' }}
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
          aria-expanded={open}
          aria-controls={routeKey}
        >
          {open ? t('modelOverrideHide') : t('modelOverrideEdit')}
        </button>
      </div>
      {open
        ? (
          <div id={routeKey} style={fieldStyle}>
            <CompatFields
              t={t}
              idPrefix={routeKey}
              draft={draft}
              disabled={disabled || busy}
              onChange={(field, value) => setDraft(current => ({ ...current, [field]: value }))}
            />
            <div style={actionsStyle}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={disabled || busy}
                onClick={() => { void save(draft, false) }}
              >
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
