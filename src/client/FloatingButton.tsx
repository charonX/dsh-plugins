/**
 * Frame-wide translate control: the floating button plus its small panel.
 *
 * The panel is the manual entry point; it proves the Host engine end to end
 * without touching any other plugin's DOM.
 *
 * @module dsh-immersive-translate/client/FloatingButton
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { ApiFailure, readState, translate } from './api.ts'
import { COLORS, inputStyle, primaryButtonStyle, quietButtonStyle } from './tokens.ts'
import type { EngineState } from '../shared/api.ts'

/** Localized `t` for the plugin namespace. */
export type Translate = TranslateNS<'immersive-translate'>

/** Props every surface of this plugin receives. */
export interface TranslateProps {
  /** Localized `t` function of the plugin namespace. */
  readonly t: Translate
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
export function FloatingButton({ t }: PropsRuntime<'shell.overlay'> & TranslateProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<EngineState | null>(null)
  const [text, setText] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | undefined>(undefined)

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
    if (text.trim() === '') { setResult(null); return }
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setBusy(true)
    setError(null)
    try {
      const answer = await translate({
        items: [{ id: 'sample', text }],
        ...(state === null ? {} : { targetLanguage: state.prefs.targetLanguage }),
      }, abort.signal)
      setResult(answer.results[0]?.text ?? '')
    } catch (failure: unknown) {
      if (abort.signal.aborted) return
      setError(describe(failure, t))
      setResult(null)
    } finally {
      if (request.current === abort) setBusy(false)
    }
  }, [text, state, t])

  const selection = state?.resolution.selection ?? null
  const canOff = state === null || selection === null
    ? undefined
    : state.catalog
      .find(entry => entry.id === selection.provider)
      ?.models.find(model => model.id === selection.model)
      ?.canDisableThinking

  return (
    <div style={{
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
            width: 320,
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
          <header style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong style={{ fontSize: 13, fontWeight: 600 }}>{t('title')}</strong>
            <span style={{ color: COLORS.secondary, fontSize: 12 }}>
              {selection === null
                ? t('modelUnavailable')
                : `${t('engine')}: ${selection.provider} / ${selection.model}`}
            </span>
            {canOff === false && (
              <>
                <span style={{ color: COLORS.warn, fontSize: 12 }}>{t('cannotDisableThinking')}</span>
                <span style={{ color: COLORS.tertiary, fontSize: 11, lineHeight: 1.45 }}>{t('thinkingSlowHint')}</span>
              </>
            )}
            {canOff === true && <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('canDisableThinking')}</span>}
          </header>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: COLORS.secondary, fontSize: 12 }}>{t('sampleTitle')}</span>
            <textarea
              value={text}
              onChange={event => { setText(event.target.value) }}
              placeholder={t('samplePlaceholder')}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 64 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => { void run() }}>
              {busy ? t('translating') : t('translate')}
            </button>
            <span style={{ color: COLORS.tertiary, fontSize: 12 }}>
              {state === null ? '' : state.prefs.targetLanguage}
            </span>
          </div>
          {error !== null && <span style={{ color: COLORS.error, fontSize: 12 }}>{error}</span>}
          {result !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: COLORS.secondary, fontSize: 12 }}>{t('result')}</span>
              <div style={{
                padding: 8,
                whiteSpace: 'pre-wrap',
                background: COLORS.layer1,
                border: `0.5px solid ${COLORS.border}`,
                borderRadius: COLORS.radiusSm,
                maxHeight: 220,
                overflow: 'auto',
              }}>{result}</div>
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
