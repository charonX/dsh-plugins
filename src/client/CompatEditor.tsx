/**
 * Provider-card extension area: edit one route's endpoint compatibility.
 *
 * Every field can be left on "auto", which deletes the key and hands the
 * decision back to pi-ai's own detection — that is the only way to undo a
 * snapshot-derived guess, so it is offered per field and for the whole block.
 *
 * @module dsh-model-studio/client/CompatEditor
 */

import { useEffect, useState, type ReactNode } from 'react'
import { THINKING_FORMATS } from '../dialect.ts'
import { ExtensionFrame } from './ExtensionFrame.tsx'
import type { Translate } from './locales.ts'
import { COMPAT_SWITCHES, EMPTY_DRAFT, compatDraftOf, compatOps, type CompatDraft, type PathOp } from './ops.ts'
import {
  actionsStyle,
  errorStyle,
  fieldStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  noticeStyle,
  primaryButtonStyle,
  quietButtonStyle,
  selectStyle,
} from './tokens.ts'

/** Output field spellings pi-ai accepts. */
const MAX_TOKENS_FIELDS: readonly string[] = ['max_tokens', 'max_completion_tokens']

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

  const field = <K extends keyof CompatDraft>(key: K, value: string): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }

  return (
    <ExtensionFrame t={t} title={`${t('compatTitle')} — ${routeName}`} surface="recessed">
      {available ? null : <p style={errorStyle}>{t('compatUnavailable')}</p>}
      <p style={hintStyle}>{t('compatHint')}</p>
      <p style={hintStyle}>{t('compatScope')}</p>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${routeId}-thinkingFormat`}>{t('compatFieldFormat')}</label>
        <select
          id={`${routeId}-thinkingFormat`}
          style={selectStyle}
          value={draft.thinkingFormat}
          disabled={disabled}
          onChange={event => field('thinkingFormat', event.target.value)}
        >
          <option value="">{t('compatAuto')}</option>
          {THINKING_FORMATS.map(format => <option key={format} value={format}>{format}</option>)}
        </select>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${routeId}-maxTokensField`}>{t('compatFieldMaxTokens')}</label>
        <select
          id={`${routeId}-maxTokensField`}
          style={selectStyle}
          value={draft.maxTokensField}
          disabled={disabled}
          onChange={event => field('maxTokensField', event.target.value)}
        >
          <option value="">{t('compatAuto')}</option>
          {MAX_TOKENS_FIELDS.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>

      {COMPAT_SWITCHES.map((key) => (
        <div style={fieldStyle} key={key}>
          <label style={labelStyle} htmlFor={`${routeId}-${key}`}>{switchLabel(t, key)}</label>
          <select
            id={`${routeId}-${key}`}
            style={selectStyle}
            value={draft[key]}
            disabled={disabled}
            onChange={event => field(key, event.target.value)}
          >
            <option value="">{t('compatAuto')}</option>
            <option value="true">{t('compatEnabled')}</option>
            <option value="false">{t('compatDisabled')}</option>
          </select>
        </div>
      ))}

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${routeId}-kwargs`}>{t('compatFieldKwargs')}</label>
        <textarea
          id={`${routeId}-kwargs`}
          style={{ ...inputStyle, minHeight: 64, fontFamily: 'monospace' }}
          value={draft.chatTemplateKwargs}
          disabled={disabled}
          spellCheck={false}
          onChange={event => field('chatTemplateKwargs', event.target.value)}
        />
      </div>

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
 * Localized label for one boolean compat field.
 * @param t - localizer.
 * @param key - field name.
 * @returns the field label.
 */
function switchLabel(t: Translate, key: (typeof COMPAT_SWITCHES)[number]): string {
  switch (key) {
    case 'supportsDeveloperRole': return t('compatFieldDeveloperRole')
    case 'supportsReasoningEffort': return t('compatFieldReasoningEffort')
    case 'supportsThinkingTokenBudget': return t('compatFieldThinkingBudget')
  }
}

/**
 * Render an unexpected failure for the status line.
 * @param failure - thrown value.
 * @returns operator-facing text.
 */
function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
