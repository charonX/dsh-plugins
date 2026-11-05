/**
 * Footer extension area: write one complete route from a snapshot preset.
 *
 * The panel is deliberately dumb about the Host: it receives the catalogue, the
 * route ids the page already knows, and one async writer. Everything it decides
 * (search, conflict refusal, status copy) is derived from those props, which is
 * what makes the render testable without a browser.
 *
 * @module dsh-model-studio/client/PresetPanel
 */

import { useMemo, useState, type ReactNode } from 'react'
import type { Preset, PresetCatalog } from '../shared/preset.ts'
import { compatSummary } from './ops.ts'
import { ExtensionFrame } from './ExtensionFrame.tsx'
import type { Translate } from './locales.ts'
import {
  actionsStyle,
  errorStyle,
  hintStyle,
  inputStyle,
  keyStyle,
  keyValueStyle,
  listStyle,
  noticeStyle,
  primaryButtonStyle,
  quietButtonStyle,
  rowHintStyle,
  rowStyle,
  selectedRowStyle,
  valueStyle,
} from './tokens.ts'

/** What one apply attempt answered. */
export type PresetApplyResult =
  | { readonly kind: 'written' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'readonly' }
  | { readonly kind: 'refused'; readonly message: string }

/** Props of {@link PresetPanel}. */
export interface PresetPanelProps {
  /** Localizer bound to this plugin's namespace. */
  t: Translate
  /** Snapshot catalogue. */
  catalog: PresetCatalog
  /** Route ids the page already knows (shipped catalog routes and stored profiles). */
  knownRouteIds: ReadonlySet<string>
  /** Whether the owning settings document accepts writes. */
  writable: boolean
  /** Set when the provider directory could not be read, so conflicts cannot be checked. */
  unavailable?: boolean
  /** Writer supplied by the seat; performs the settings mutation. */
  onApply(preset: Preset): Promise<PresetApplyResult>
}

/** Rows rendered before the panel asks the user to narrow the search. */
const MAX_ROWS = 30

/**
 * Whether a preset matches the search box.
 * @param preset - candidate preset.
 * @param query - lowercased search text.
 * @returns true when any identifying field contains the query.
 */
function matches(preset: Preset, query: string): boolean {
  if (query.length === 0) return true
  return [preset.id, preset.name, preset.baseURL, preset.apiKeyEnv]
    .some(field => field.toLowerCase().includes(query))
}

/**
 * Render the preset extension area.
 * @param props - catalogue, known routes, and the writer.
 * @returns the footer area.
 */
export function PresetPanel({ t, catalog, knownRouteIds, writable, unavailable = false, onApply }: PresetPanelProps): ReactNode {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ readonly kind: 'info' | 'error'; readonly text: string } | undefined>(undefined)

  const normalized = query.trim().toLowerCase()
  const filtered = useMemo(
    () => catalog.presets.filter(preset => matches(preset, normalized)),
    [catalog.presets, normalized],
  )
  const visible = filtered.slice(0, MAX_ROWS)
  const remaining = filtered.length - visible.length
  const selected = filtered.find(preset => preset.id === selectedId)

  const apply = async (preset: Preset): Promise<void> => {
    if (busy || !writable || unavailable) return
    setBusy(true)
    setStatus(undefined)
    try {
      const result = await onApply(preset)
      setStatus(result.kind === 'written'
        ? { kind: 'info', text: t('presetWritten', { name: preset.name }) }
        : result.kind === 'exists'
          ? { kind: 'error', text: t('presetExists', { id: preset.id }) }
          : result.kind === 'readonly'
            ? { kind: 'error', text: t('presetReadOnly') }
            : { kind: 'error', text: t('presetFailed', { message: result.message }) })
    } catch (failure) {
      setStatus({ kind: 'error', text: t('presetFailed', { message: describe(failure) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ExtensionFrame t={t} title={t('presetsTitle')} surface="raised">
      <p style={hintStyle}>{t('presetsHint')}</p>
      <p style={hintStyle}>
        {t('presetsSnapshot', { snapshot: catalog.snapshot, license: catalog.license })}
        {' · '}
        {t('presetsScope', { count: catalog.presets.length, excluded: catalog.skipped.notOpenAiCompatible })}
      </p>
      {unavailable ? <p style={errorStyle}>{t('presetsUnavailable')}</p> : null}
      {!writable && !unavailable ? <p style={errorStyle}>{t('presetReadOnly')}</p> : null}
      <input
        style={{ ...inputStyle, marginTop: 8 }}
        type="search"
        value={query}
        placeholder={t('presetsSearch')}
        aria-label={t('presetsSearch')}
        onChange={event => setQuery(event.target.value)}
      />
      <div style={listStyle} role="listbox" aria-label={t('presetsTitle')}>
        {visible.length === 0 ? <p style={hintStyle}>{t('presetsEmpty')}</p> : null}
        {visible.map((preset) => {
          const known = knownRouteIds.has(preset.id)
          return (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={preset.id === selectedId}
              style={preset.id === selectedId ? selectedRowStyle : rowStyle}
              onClick={() => setSelectedId(preset.id === selectedId ? undefined : preset.id)}
            >
              <span>
                {preset.name}
                {' · '}
                <span style={{ fontSize: 12 }}>{preset.id}</span>
                {known ? <span style={rowHintStyle}> {t('presetsKnown')}</span> : null}
              </span>
              <span style={rowHintStyle}>{preset.baseURL}</span>
            </button>
          )
        })}
      </div>
      {remaining > 0 ? <p style={hintStyle}>{t('presetsMore', { count: remaining })}</p> : null}
      {selected === undefined ? null : (
        <div style={{ marginTop: 12 }}>
          <dl style={keyValueStyle}>
            <dt style={keyStyle}>{t('presetRoute')}</dt>
            <dd style={valueStyle}>{selected.id}</dd>
            <dt style={keyStyle}>{t('presetEndpoint')}</dt>
            <dd style={valueStyle}>{selected.baseURL}</dd>
            <dt style={keyStyle}>{t('presetProtocol')}</dt>
            <dd style={valueStyle}>{selected.api}</dd>
            <dt style={keyStyle}>{t('presetCredential')}</dt>
            <dd style={valueStyle}>{selected.apiKeyEnv}</dd>
            <dt style={keyStyle}>{t('presetCompat')}</dt>
            <dd style={valueStyle}>
              {compatSummary(selected).length === 0 ? t('presetCompatNone') : compatSummary(selected).join(', ')}
            </dd>
            {selected.doc === undefined ? null : (
              <>
                <dt style={keyStyle}>{t('presetDocs')}</dt>
                <dd style={valueStyle}>{selected.doc}</dd>
              </>
            )}
          </dl>
          <p style={{ ...hintStyle, marginTop: 10 }}>{t('presetModels')}</p>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: valueStyle.color }}>
            {selected.models.map(model => (
              <li key={model.id} style={{ overflowWrap: 'anywhere' }}>
                {model.name}
                {model.contextWindow === undefined ? '' : ` · ctx ${model.contextWindow}`}
                {model.reasoningEfforts === undefined ? '' : ` · ${Object.keys(model.reasoningEfforts).join('/')}`}
              </li>
            ))}
          </ul>
          <div style={actionsStyle}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy || !writable || unavailable || knownRouteIds.has(selected.id)}
              onClick={() => { void apply(selected) }}
            >
              {busy ? t('presetApplying') : t('presetApply')}
            </button>
            <button type="button" style={quietButtonStyle} disabled={busy} onClick={() => setSelectedId(undefined)}>
              {t('presetCancel')}
            </button>
          </div>
        </div>
      )}
      {status === undefined ? null : <p style={status.kind === 'error' ? errorStyle : noticeStyle}>{status.text}</p>}
    </ExtensionFrame>
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
