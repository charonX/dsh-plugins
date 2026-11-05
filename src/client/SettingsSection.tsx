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
import type { TranslateProps } from './FloatingButton.tsx'
import { COLORS, inputStyle, primaryButtonStyle } from './tokens.ts'
import { TARGET_LANGUAGES, type EngineState } from '../shared/api.ts'

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
  const [state, setState] = useState<EngineState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [follow, setFollow] = useState(true)
  const [language, setLanguage] = useState('zh-CN')
  const [route, setRoute] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    void readState(abort.signal).then((next) => {
      setState(next)
      setFollow(next.prefs.followDefaultModel)
      setLanguage(next.prefs.targetLanguage)
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
      canDisableThinking: model.canDisableThinking,
    }))) ?? [], [state])

  const save = useCallback(async () => {
    setStatus('saving')
    const [provider, model] = route === '' ? [] : route.split('\u0000')
    try {
      const prefs = await savePrefs({
        targetLanguage: language,
        followDefaultModel: follow,
        ...provider === undefined || model === undefined ? {} : { provider, model },
      })
      setStatus('saved')
      setError(null)
      setState(current => (current === null ? current : { ...current, prefs }))
    } catch (failure: unknown) {
      setStatus('failed')
      setError(describe(failure, t('saveFailed')))
    }
  }, [language, follow, route, t])

  const effective = state?.resolution.selection ?? null
  const effectiveModel = effective === null
    ? undefined
    : state?.catalog
      .find(group => group.id === effective.provider)
      ?.models.find(model => model.id === effective.model)
  const canDisableThinking = effectiveModel?.canDisableThinking
  const efforts = effectiveModel?.efforts ?? []

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

      {state === null && error === null && <span style={{ color: COLORS.tertiary }}>{t('loading')}</span>}
      {error !== null && <span style={{ color: COLORS.error }}>{error}</span>}

      {state !== null && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: COLORS.secondary }}>{t('targetLanguage')}</span>
            <select
              value={language}
              onChange={(event) => { setLanguage(event.target.value); setStatus('idle') }}
              style={{ ...inputStyle, width: 220 }}>
              {TARGET_LANGUAGES.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
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
            <select
              value={route}
              disabled={follow || options.length === 0}
              onChange={(event) => { setRoute(event.target.value); setStatus('idle') }}
              style={{ ...inputStyle, width: '100%', maxWidth: 420 }}>
              {options.length === 0 && <option value="">{t('modelUnavailable')}</option>}
              {options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}{option.canDisableThinking ? '' : ' · thinking'}
                </option>
              ))}
            </select>
            <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('modelHint')}</span>
          </label>

          {effective !== null && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '8px 10px',
              background: COLORS.layer1,
              border: `0.5px solid ${COLORS.border}`,
              borderRadius: COLORS.radiusMd,
            }}>
              <span style={{ color: COLORS.secondary, fontSize: 12 }}>
                {`${t('engine')}: ${effective.provider} / ${effective.model}`}
              </span>
              {canDisableThinking === false
                ? (
                  <>
                    <span style={{ color: COLORS.warn, fontSize: 12 }}>{t('cannotDisableThinking')}</span>
                    <span style={{ color: COLORS.tertiary, fontSize: 12, lineHeight: 1.45 }}>{t('thinkingSlowHint')}</span>
                  </>
                )
                : <span style={{ color: COLORS.tertiary, fontSize: 12 }}>{t('canDisableThinking')}</span>}
              <span style={{ color: COLORS.tertiary, fontSize: 12 }}>
                {`${t('effortsLabel')}: ${efforts.length === 0 ? t('effortsNone') : efforts.join(', ')}`}
              </span>
            </div>
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
    </section>
  )
}
