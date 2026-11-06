/**
 * Provider-card extension area: edit one route's endpoint compatibility.
 *
 * Only gateway-level switches live here. Per-model capabilities are edited on
 * the model page, which writes `models[i].compat` instead of the route block.
 * Every field can be left on "auto", which deletes the key and hands the
 * decision back to pi-ai's own detection — that is the only way to undo a
 * snapshot-derived guess, so it is offered per field and for the whole block.
 *
 * @module dsh-model-studio/client/CompatEditor
 */

import { useEffect, useState, type ReactNode } from 'react'
import { CompatFields } from './CompatFields.tsx'
import { ExtensionFrame } from './ExtensionFrame.tsx'
import type { Translate } from './locales.ts'
import { EMPTY_DRAFT, compatDraftOf, compatOps, type CompatDraft, type PathOp } from './ops.ts'
import {
  actionsStyle,
  errorStyle,
  hintStyle,
  noticeStyle,
  primaryButtonStyle,
  quietButtonStyle,
} from './tokens.ts'

/** What one save attempt answered. */
export type CompatSaveResult =
  | { readonly kind: 'saved' }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'refused'; readonly message: string }

/** Props of {@link CompatEditor}. */
export interface CompatEditorProps {
  /** Localizer bound to this plugin's namespace. */
  t: Translate
  /** Route id the card shows. */
  routeId: string
  /** Route display name, for the area label. */
  routeName: string
  /** Path to this route's compat block inside the settings namespace. */
  compatPath: readonly string[]
  /** Stored compat object, when one exists. */
  stored: unknown
  /** Whether the settings namespace is served and writable. */
  available: boolean
  /** Whether the owning settings document accepts writes. */
  writable: boolean
  /** Writer supplied by the seat. */
  onSave(ops: PathOp[]): Promise<CompatSaveResult>
}

/**
 * Render the compatibility editor for one route.
 * @param props - route identity, stored values, and the writer.
 * @returns the provider-card area.
 */
export function CompatEditor(props: CompatEditorProps): ReactNode {
  const { t, routeId, routeName, compatPath, stored, available, writable, onSave } = props
  const [draft, setDraft] = useState<CompatDraft>(() => compatDraftOf(stored))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ readonly kind: 'info' | 'error'; readonly text: string } | undefined>(undefined)

  // A different card (or a Host-pushed reload) replaces the draft instead of
  // merging into it, so a stale edit can never be written to another route.
  useEffect(() => {
    setDraft(compatDraftOf(stored))
    setStatus(undefined)
  }, [routeId, stored])

  const disabled = busy || !available || !writable

  const save = async (next: CompatDraft, cleared: boolean): Promise<void> => {
    if (disabled) return
    const parsed = compatOps(compatPath, next)
    if (parsed.error !== undefined) {
      setStatus({ kind: 'error', text: t('compatInvalidKwargs') })
      return
    }
    setBusy(true)
    setStatus(undefined)
    try {
      const result = await onSave(parsed.ops)
      if (result.kind === 'refused') setStatus({ kind: 'error', text: t('compatFailed', { message: result.message }) })
      else setStatus({ kind: 'info', text: cleared ? t('compatCleared') : t('compatSaved') })
    } catch (failure) {
      setStatus({ kind: 'error', text: t('compatFailed', { message: describe(failure) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ExtensionFrame t={t} title={`${t('compatTitle')} — ${routeName}`} surface="recessed">
      {available ? null : <p style={errorStyle}>{t('compatUnavailable')}</p>}
      <p style={hintStyle}>{t('compatHint')}</p>
      <p style={hintStyle}>{t('compatScope')}</p>

      <CompatFields
        t={t}
        idPrefix={routeId}
        draft={draft}
        disabled={disabled}
        onChange={(field, value) => setDraft(current => ({ ...current, [field]: value }))}
      />

      <div style={actionsStyle}>
        <button type="button" style={primaryButtonStyle} disabled={disabled} onClick={() => { void save(draft, false) }}>
          {busy ? t('compatSaving') : t('compatSave')}
        </button>
        <button
          type="button"
          style={quietButtonStyle}
          disabled={disabled}
          onClick={() => { setDraft(EMPTY_DRAFT); void save(EMPTY_DRAFT, true) }}
        >
          {t('compatClear')}
        </button>
      </div>
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
