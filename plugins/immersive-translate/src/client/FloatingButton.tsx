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
import { AuditView } from './AuditView.tsx'
import { CacheView } from './CacheView.tsx'
import { DshSelect } from './DshSelect.tsx'
import { PromptView } from './PromptView.tsx'
import { COLORS, inputStyle, primaryButtonStyle, quietButtonStyle } from './tokens.ts'
import { DEFAULT_SUBMIT_KEY, DEFAULT_TARGET_LANGUAGE, TARGET_LANGUAGES, languageLabel, type EngineState } from '../shared/api.ts'
import { isTranslateShortcut } from '../shared/keys.ts'
import { isAbortError, type PageTranslator } from './pageTranslator.ts'

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
  if (isAbortError(error)) return ''
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
  const [showAuditModal, setShowAuditModal] = useState(false)
  const [auditTab, setAuditTab] = useState<'audit' | 'cache' | 'prompt'>('audit')
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
      if (isAbortError(failure, abort.signal)) return
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
            <DshSelect
              ariaLabel={t('targetLanguage')}
              value={language}
              options={TARGET_LANGUAGES.map(code => ({ value: code, label: languageLabel(code) }))}
              onChange={pickLanguage}
              variant="compact"
              align="end"
              side="top"
              style={{ marginLeft: 'auto' }}
            />
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
            <button
              type="button"
              style={{
                ...quietButtonStyle,
                padding: '2px 8px',
                fontSize: 12,
                marginLeft: 'auto',
              }}
              onClick={() => { setShowAuditModal(true) }}>
              {t('auditQuickEntry')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
            {pageState.running && pageState.total > 0 && (
              <span style={{ color: COLORS.tertiary, fontSize: 11 }}>
                {t('pageProgress', {
                  done: pageState.done,
                  total: pageState.total,
                  batch: Math.min(pageState.batchDone + 1, pageState.batchTotal),
                  totalBatches: pageState.batchTotal,
                })}
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

      {showAuditModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.45)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 10000,
          pointerEvents: 'auto',
        }}>
          <div style={{
            width: 760,
            maxWidth: '92vw',
            maxHeight: '85vh',
            overflow: 'auto',
            background: COLORS.layer2,
            border: `0.5px solid ${COLORS.border}`,
            borderRadius: COLORS.radiusLg,
            boxShadow: COLORS.overlayShadow,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setAuditTab('audit')}
                  style={{
                    ...quietButtonStyle,
                    background: auditTab === 'audit' ? COLORS.layer3 : 'transparent',
                    fontWeight: auditTab === 'audit' ? 600 : 400,
                    border: auditTab === 'audit' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
                  }}>
                  {t('tabAudit')}
                </button>
                <button
                  type="button"
                  onClick={() => setAuditTab('cache')}
                  style={{
                    ...quietButtonStyle,
                    background: auditTab === 'cache' ? COLORS.layer3 : 'transparent',
                    fontWeight: auditTab === 'cache' ? 600 : 400,
                    border: auditTab === 'cache' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
                  }}>
                  {t('tabCache')}
                </button>
                <button
                  type="button"
                  onClick={() => setAuditTab('prompt')}
                  style={{
                    ...quietButtonStyle,
                    background: auditTab === 'prompt' ? COLORS.layer3 : 'transparent',
                    fontWeight: auditTab === 'prompt' ? 600 : 400,
                    border: auditTab === 'prompt' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
                  }}>
                  {t('tabPrompt')}
                </button>
              </div>
              <button
                type="button"
                style={{ ...quietButtonStyle, padding: '4px 10px', fontSize: 12 }}
                onClick={() => setShowAuditModal(false)}>
                {t('closeModal')}
              </button>
            </div>
            {auditTab === 'audit' && <AuditView t={t} />}
            {auditTab === 'cache' && <CacheView t={t} />}
            {auditTab === 'prompt' && state !== null && (
              <PromptView
                t={t}
                targetLanguage={language}
                customPrompt={state.prefs.customPrompt}
                onSaved={(updated) => {
                  setState(curr => curr === null ? curr : { ...curr, prefs: updated })
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
