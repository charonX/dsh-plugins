/**
 * Frame-wide translate control: the floating button plus its small panel.
 *
 * The panel is the manual entry point; it proves the Host engine end to end
 * without touching any other plugin's DOM. It shows only what the reader acts
 * on - the text, the action, and the answer - because a caption for every
 * internal decision (which route, whether thinking was off) turned a two-field
 * form into a diagnostics dump.
 *
 * @module dsh-immersive-translate/client/FloatingButton
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { ApiFailure, readState, savePrefs, translate } from './api.ts'
import { COLORS, inputStyle, primaryButtonStyle, quietButtonStyle } from './tokens.ts'
import { DEFAULT_SUBMIT_KEY, DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGES, languageLabel, type EngineState } from '../shared/api.ts'
import { isTranslateShortcut } from '../shared/keys.ts'
import type { PageTranslator } from './pageTranslator.ts'

/** Localized `t` for the plugin namespace. */
export type Translate = TranslateNS<'immersive-translate'>

/** Props every surface of this plugin receives. */
export interface TranslateProps {
  /** Localized `t` function of the plugin namespace. */
  readonly t: Translate
}

/** Props of the floating panel, which also drives page-wide translation. */
export interface PanelProps extends TranslateProps {
  /** Page-wide translator; one per page, owned by the browser half. */
  readonly page: PageTranslator
}

/** Failure text for an arbitrary throw. */
function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : t('loadFailed')
}

/**
 * Render the floating translate control.
 * @param props - the overlay's owner props plus the injected `t`.
 * @returns the button and, while open, its panel.
 */
export function FloatingButton({ t, page }: PropsRuntime<'shell.overlay'> & PanelProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<EngineState | null>(null)
  const [text, setText] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [reasoned, setReasoned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | undefined>(undefined)
  const pageState = useSyncExternalStore(page.subscribe, page.snapshot, page.snapshot)

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void readState(abort.signal)
      .then(next => { setState(next); setError(null) })
      .catch((failure: unknown) => { if (!abort.signal.aborted) setError(describe(failure, t)) })
    return () => { abort.abort() }
  }, [open, t])

  useEffect(() => () => { request.current?.abort() }, [])

  const run = useCallback(async () => {
    if (busy || text.trim() === '') return
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setBusy(true)
    setError(null)
    setReasoned(false)
    try {
      const answer = await translate({
        items: [{ id: 'sample', text }],
        ...(state === null ? {} : { targetLanguage: state.prefs.targetLanguage }),
      }, abort.signal)
      setResult(answer.results[0]?.text ?? '')
      setReasoned(answer.reasoned)
    } catch (failure: unknown) {
      if (abort.signal.aborted) return
      setError(describe(failure, t))
      setResult(null)
    } finally {
      if (request.current === abort) setBusy(false)
    }
  }, [text, state, t, busy])

  const pickLanguage = useCallback((next: string) => {
    setState(current => (current === null ? current : { ...current, prefs: { ...current.prefs, targetLanguage: next } }))
    void savePrefs({ targetLanguage: next })
      .then((prefs) => { setState(current => (current === null ? current : { ...current, prefs })) })
      .catch((failure: unknown) => { setError(describe(failure, t)) })
  }, [t])

  const language = state?.prefs.targetLanguage ?? DEFAULT_TARGET_LANGUAGE
  const submitKey = state?.prefs.submitKey ?? DEFAULT_SUBMIT_KEY
  const modelReady = state === null || state.resolution.selection !== null

  const togglePage = useCallback(() => {
    if (pageState.active) { page.restore(); return }
    if (state === null) return
    page.start({
      targetLanguage: state.prefs.targetLanguage,
      maxItemsPerBatch: state.limits.maxItemsPerBatch,
      maxCharsPerItem: state.limits.maxCharsPerItem,
    })
  }, [page, pageState.active, state])

  return (
    <div
      data-dsh-translate-ui=""
      style={{
        position: 'absolute',
        right: 20,
        bottom: 96,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
        pointerEvents: 'none',
      }}>
      {open && (
        <section
          aria-label={t('title')}
          style={{
            pointerEvents: 'auto',
            width: 340,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            color: COLORS.text,
            background: COLORS.layer2,
            border: `0.5px solid ${COLORS.border}`,
            borderRadius: COLORS.radiusLg,
            boxShadow: COLORS.overlayShadow,
            fontSize: 13,
          }}>
          <textarea
            autoFocus
            value={text}
            onChange={event => { setText(event.target.value) }}
            onKeyDown={(event) => {
              const native = event.nativeEvent
              const submit = isTranslateShortcut({
                key: event.key,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                repeat: event.repeat,
                isComposing: native.isComposing,
                keyCode: native.keyCode,
              }, submitKey)
              if (!submit) return
              event.preventDefault()
              void run()
            }}
            placeholder={t(submitKey === 'mod-enter' ? 'placeholderMod' : 'placeholderEnter')}
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', minHeight: 88, lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              style={{
                ...primaryButtonStyle,
                opacity: busy || text.trim() === '' ? 0.5 : 1,
                cursor: busy || text.trim() === '' ? 'default' : 'pointer',
              }}
              disabled={busy || text.trim() === ''}
              onClick={() => { void run() }}>
              {busy ? t('translating') : t('translate')}
            </button>
            <select
              aria-label={t('targetLanguage')}
              value={language}
              onChange={(event) => { pickLanguage(event.target.value) }}
              style={{
                ...inputStyle,
                width: 'auto',
                marginLeft: 'auto',
                padding: '4px 6px',
                fontSize: 12,
                color: COLORS.secondary,
                background: 'transparent',
                cursor: 'pointer',
              }}>
              {TARGET_LANGUAGES.map(code => (
                <option key={code} value={code}>{languageLabel(code)}</option>
              ))}
            </select>
          </div>
          {error !== null && (
            <span style={{ color: COLORS.error, fontSize: 12, lineHeight: 1.5 }}>{error}</span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
            <button
              type="button"
              style={{
                ...quietButtonStyle,
                padding: '2px 8px',
                fontSize: 12,
                opacity: state === null ? 0.5 : 1,
              }}
              disabled={state === null}
              onClick={togglePage}>
              {pageState.active ? t('pageRestore') : t('pageTranslate')}
            </button>
            {pageState.running && pageState.total > 0 && (
              <span style={{ color: COLORS.tertiary, fontSize: 11 }}>
                {t('pageProgress', { done: pageState.done, total: pageState.total })}
              </span>
            )}
            {!pageState.running && pageState.active && pageState.translated === 0 && (
              <span style={{ color: COLORS.tertiary, fontSize: 11 }}>{t('pageEmpty')}</span>
            )}
            {pageState.error !== null && (
              <span style={{ color: COLORS.error, fontSize: 11 }}>{pageState.error}</span>
            )}
          </div>
          {error === null && !modelReady && (
            <span style={{ color: COLORS.warn, fontSize: 12 }}>{t('modelUnavailable')}</span>
          )}
          {result !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: COLORS.tertiary, fontSize: 11 }}>{t('result')}</span>
              <div style={{
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                background: COLORS.layer1,
                border: `0.5px solid ${COLORS.border}`,
                borderRadius: COLORS.radiusSm,
                maxHeight: 240,
                overflow: 'auto',
              }}>{result}</div>
              {reasoned && (
                <span style={{ color: COLORS.tertiary, fontSize: 11 }}>{t('thinkingNote')}</span>
              )}
            </div>
          )}
        </section>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t('fabClose') : t('fabOpen')}
        onClick={() => { setOpen(value => !value) }}
        style={{
          ...quietButtonStyle,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          borderRadius: 999,
          boxShadow: COLORS.panelShadow,
          background: open ? COLORS.layer3 : COLORS.layer2,
        }}>
        <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>文</span>
        <span>{t('fabLabel')}</span>
      </button>
    </div>
  )
}
