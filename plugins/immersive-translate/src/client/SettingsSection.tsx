/**
 * Settings page: destination language and the model that translates.
 *
 * The selector lists only routes the Harness already serves; providers and
 * credentials stay in the Harness model settings, so this page writes nothing
 * outside the plugin's own preference file.
 *
 * @module dsh-immersive-translate/client/SettingsSection
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ApiFailure, readState, savePrefs } from './api.ts'
import { AuditView } from './AuditView.tsx'
import { CacheView } from './CacheView.tsx'
import { DshSelect } from './DshSelect.tsx'
import { PromptView } from './PromptView.tsx'
import type { TranslateProps } from './FloatingButton.tsx'
import { COLORS, primaryButtonStyle, quietButtonStyle } from './tokens.ts'
import { SUBMIT_KEYS, TARGET_LANGUAGES, languageLabel, submitKeyOf, type EngineState, type SubmitKey } from '../shared/api.ts'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : fallback
}

/**
 * Render the translation settings section.
 * @param props - the section's owner props plus the injected `t`.
 * @returns the section body.
 */
export function SettingsSection({ t }: PropsRuntime<'settings.section'> & TranslateProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'preferences' | 'prompt' | 'audit' | 'cache'>('preferences')
  const [state, setState] = useState<EngineState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [follow, setFollow] = useState(true)
  const [language, setLanguage] = useState('zh-CN')
  const [submitKey, setSubmitKey] = useState<SubmitKey>('enter')
  const [route, setRoute] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    void readState(abort.signal).then((next) => {
      setState(next)
      setFollow(next.prefs.followDefaultModel)
      setLanguage(next.prefs.targetLanguage)
      setSubmitKey(next.prefs.submitKey)
      setRoute(next.prefs.provider === undefined || next.prefs.model === undefined
        ? ''
        : `${next.prefs.provider}\u0000${next.prefs.model}`)
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) setError(describe(failure, t('loadFailed')))
    })
    return () => { abort.abort() }
  }, [t])

  const options = useMemo(() => state?.catalog
    .flatMap(group => group.models.map(model => ({
      value: `${group.id}\u0000${model.id}`,
      label: `${group.name} · ${model.name}`,
    }))) ?? [], [state])

  const save = useCallback(async () => {
    setStatus('saving')
    const [provider, model] = route === '' ? [] : route.split('\u0000')
    try {
      const prefs = await savePrefs({
        targetLanguage: language,
        followDefaultModel: follow,
        submitKey,
        ...provider === undefined || model === undefined ? {} : { provider, model },
      })
      setStatus('saved')
      setError(null)
      setState(current => (current === null ? current : { ...current, prefs }))
    } catch (failure: unknown) {
      setStatus('failed')
      setError(describe(failure, t('saveFailed')))
    }
  }, [language, follow, route, submitKey, t])

  const effective = state?.resolution.selection ?? null

  return (
    <section style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: 20,
      maxWidth: 720,
      color: COLORS.text,
      background: COLORS.layer2,
      border: `0.5px solid ${COLORS.border}`,
      borderRadius: COLORS.radiusLg,
      boxShadow: COLORS.panelShadow,
      fontSize: 13,
    }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('settingsTitle')}</h2>
        <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('settingsSubtitle')}</p>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, borderBottom: `0.5px solid ${COLORS.border}`, paddingBottom: 8 }}>
        <button
          type="button"
          onClick={() => setActiveTab('preferences')}
          style={{
            ...quietButtonStyle,
            background: activeTab === 'preferences' ? COLORS.layer3 : 'transparent',
            fontWeight: activeTab === 'preferences' ? 600 : 400,
            border: activeTab === 'preferences' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
          }}>
          {t('tabPreferences')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('prompt')}
          style={{
            ...quietButtonStyle,
            background: activeTab === 'prompt' ? COLORS.layer3 : 'transparent',
            fontWeight: activeTab === 'prompt' ? 600 : 400,
            border: activeTab === 'prompt' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
          }}>
          {t('tabPrompt')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('audit')}
          style={{
            ...quietButtonStyle,
            background: activeTab === 'audit' ? COLORS.layer3 : 'transparent',
            fontWeight: activeTab === 'audit' ? 600 : 400,
            border: activeTab === 'audit' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
          }}>
          {t('tabAudit')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('cache')}
          style={{
            ...quietButtonStyle,
            background: activeTab === 'cache' ? COLORS.layer3 : 'transparent',
            fontWeight: activeTab === 'cache' ? 600 : 400,
            border: activeTab === 'cache' ? `0.5px solid ${COLORS.borderStrong}` : 'none',
          }}>
          {t('tabCache')}
        </button>
      </div>

      {activeTab === 'prompt' && state !== null && (
        <PromptView
          t={t}
          targetLanguage={language}
          customPrompt={state.prefs.customPrompt}
          onSaved={(updated) => {
            setState(curr => curr === null ? curr : { ...curr, prefs: updated })
          }}
        />
      )}
      {activeTab === 'audit' && <AuditView t={t} />}
      {activeTab === 'cache' && <CacheView t={t} />}

      {activeTab === 'preferences' && (
        <>
          {state === null && error === null && <span style={{ color: COLORS.tertiary }}>{t('loading')}</span>}
          {error !== null && <span style={{ color: COLORS.error }}>{error}</span>}

          {state !== null && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ color: COLORS.secondary }}>{t('targetLanguage')}</span>
                <DshSelect
                  ariaLabel={t('targetLanguage')}
                  value={language}
                  options={TARGET_LANGUAGES.map(code => ({ value: code, label: languageLabel(code) }))}
                  onChange={(next) => { setLanguage(next); setStatus('idle') }}
                  style={{ width: 220 }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ color: COLORS.secondary }}>{t('submitKey')}</span>
                <DshSelect
                  ariaLabel={t('submitKey')}
                  value={submitKey}
                  options={SUBMIT_KEYS.map(mode => ({
                    value: mode,
                    label: mode === 'mod-enter' ? t('submitKeyMod') : t('submitKeyEnter'),
                  }))}
                  onChange={(next) => { setSubmitKey(submitKeyOf(next) ?? 'enter'); setStatus('idle') }}
                  style={{ width: 260 }}
                />
                <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('submitKeyHint')}</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(event) => { setFollow(event.target.checked); setStatus('idle') }}
                  style={{ marginTop: 2 }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>{t('followDefaultModel')}</span>
                  <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('followDefaultHint')}</span>
                </span>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: follow ? 0.5 : 1 }}>
                <span style={{ color: COLORS.secondary }}>{t('model')}</span>
                <DshSelect
                  ariaLabel={t('model')}
                  value={route}
                  disabled={follow || options.length === 0}
                  placeholder={t('modelUnavailable')}
                  options={options.length === 0 ? [{ value: '', label: t('modelUnavailable') }] : options}
                  onChange={(next) => { setRoute(next); setStatus('idle') }}
                  style={{ width: '100%', maxWidth: 420 }}
                />
                <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('modelHint')}</span>
              </label>

              {effective !== null && (
                <span style={{ color: COLORS.tertiary, fontSize: 12 }}>
                  {`${t('engine')}: ${effective.provider} / ${effective.model}`}
                </span>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={status === 'saving'}
                  onClick={() => { void save() }}>
                  {status === 'saving' ? t('saving') : t('save')}
                </button>
                {status === 'saved' && <span style={{ color: COLORS.secondary, fontSize: 12 }}>{t('saved')}</span>}
                {status === 'failed' && <span style={{ color: COLORS.error, fontSize: 12 }}>{t('saveFailed')}</span>}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
