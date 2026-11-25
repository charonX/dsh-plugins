/**
 * Prompt configuration UI: view the current translation prompt template,
 * customize instructions, review template variables, and preview rendering.
 *
 * @module dsh-immersive-translate/client/PromptView
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react'
import type { TranslatePrefs } from '../shared/api.ts'
import { DEFAULT_PROMPT_TEMPLATE, renderPrompt } from '../shared/prompt.ts'
import { savePrefs } from './api.ts'
import type { Translate } from './FloatingButton.tsx'
import { COLORS, inputStyle, primaryButtonStyle, quietButtonStyle } from './tokens.ts'

export interface PromptViewProps {
  readonly t: Translate
  readonly targetLanguage: string
  readonly customPrompt?: string
  readonly onSaved?: (prefs: TranslatePrefs) => void
}

export function PromptView({
  t,
  targetLanguage,
  customPrompt,
  onSaved,
}: PromptViewProps): ReactElement {
  const [template, setTemplate] = useState<string>(
    customPrompt && customPrompt.trim() !== '' ? customPrompt : DEFAULT_PROMPT_TEMPLATE
  )
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)

  const isCustom = useMemo(() => {
    return template.trim() !== DEFAULT_PROMPT_TEMPLATE.trim()
  }, [template])

  const preview = useMemo(() => {
    return renderPrompt({
      targetLanguage,
      template,
      nonce: 'preview',
    })
  }, [targetLanguage, template])

  const handleSave = useCallback(async () => {
    setStatus('saving')
    setError(null)
    try {
      const nextCustom = template.trim() === DEFAULT_PROMPT_TEMPLATE.trim() ? undefined : template.trim()
      const updated = await savePrefs({ customPrompt: nextCustom })
      setStatus('saved')
      onSaved?.(updated)
    } catch (err) {
      setStatus('failed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onSaved, template])

  const handleReset = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('promptResetConfirm'))) {
      return
    }
    setTemplate(DEFAULT_PROMPT_TEMPLATE)
    setStatus('saving')
    setError(null)
    try {
      const updated = await savePrefs({ customPrompt: undefined })
      setStatus('saved')
      onSaved?.(updated)
    } catch (err) {
      setStatus('failed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onSaved, t])

  const insertVariable = (variable: string) => {
    setTemplate(current => `${current} ${variable}`)
    setStatus('idle')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: COLORS.text }}>{t('promptTitle')}</h3>
            <span style={{
              padding: '2px 8px',
              borderRadius: COLORS.radiusSm,
              fontSize: 11,
              fontWeight: 500,
              color: isCustom ? COLORS.brand : COLORS.secondary,
              border: `0.5px solid ${isCustom ? COLORS.brand : COLORS.border}`,
              background: COLORS.layer1,
            }}>
              {isCustom ? t('promptUsingCustom') : t('promptUsingDefault')}
            </span>
          </div>
          <p style={{ margin: 0, color: COLORS.secondary, fontSize: 13 }}>{t('promptSubtitle')}</p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            style={{ ...quietButtonStyle, padding: '5px 12px', fontSize: 12 }}
            disabled={!isCustom || status === 'saving'}
            onClick={() => { void handleReset() }}>
            {t('promptResetBtn')}
          </button>
          <button
            type="button"
            style={{ ...primaryButtonStyle, padding: '5px 14px', fontSize: 12 }}
            disabled={status === 'saving'}
            onClick={() => { void handleSave() }}>
            {status === 'saving' ? t('saving') : t('promptSaveBtn')}
          </button>
        </div>
      </header>

      {error !== null && (
        <div style={{ padding: '8px 12px', background: COLORS.layer3, color: COLORS.error, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.border}` }}>
          {error}
        </div>
      )}

      {status === 'saved' && (
        <div style={{ padding: '8px 12px', background: COLORS.layer1, color: COLORS.success, borderRadius: COLORS.radiusSm, border: `0.5px solid ${COLORS.success}` }}>
          {t('promptSaved')}
        </div>
      )}

      {/* Template Editor */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 500, color: COLORS.text, fontSize: 13 }}>{t('promptTemplateLabel')}</span>
          <span style={{ color: COLORS.tertiary, fontSize: 11 }}>{t('promptTemplateHint')}</span>
        </div>
        <textarea
          rows={11}
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value)
            setStatus('idle')
          }}
          style={{
            ...inputStyle,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            resize: 'vertical',
            minHeight: 220,
          }}
        />
      </div>

      {/* Available Variables */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 14px',
        background: COLORS.layer1,
        borderRadius: COLORS.radiusSm,
        border: `0.5px solid ${COLORS.border}`,
        fontSize: 12,
      }}>
        <span style={{ fontWeight: 500, color: COLORS.secondary }}>{t('promptVariablesTitle')}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <VariablePill name="{target}" desc={t('promptVarTarget')} onInsert={insertVariable} />
          <VariablePill name="{targetLanguage}" desc={t('promptVarTargetLang')} onInsert={insertVariable} />
          <VariablePill name="{startMarker}" desc={t('promptVarStart')} onInsert={insertVariable} />
          <VariablePill name="{endMarker}" desc={t('promptVarEnd')} onInsert={insertVariable} />
        </div>
      </div>

      {/* Live Preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontWeight: 500, color: COLORS.secondary, fontSize: 12 }}>{t('promptPreviewTitle')}</span>
        <div style={{
          padding: '10px 14px',
          whiteSpace: 'pre-wrap',
          background: COLORS.layer1,
          border: `0.5px solid ${COLORS.border}`,
          borderRadius: COLORS.radiusSm,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          lineHeight: 1.6,
          color: COLORS.secondary,
          maxHeight: 200,
          overflow: 'auto',
        }}>
          {preview}
        </div>
      </div>
    </div>
  )
}

function VariablePill({
  name,
  desc,
  onInsert,
}: {
  name: string
  desc: string
  onInsert: (val: string) => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => onInsert(name)}
      style={{
        ...quietButtonStyle,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        fontSize: 11,
        cursor: 'pointer',
      }}
      title={`点击插入 ${name}`}>
      <code style={{ color: COLORS.brand, fontWeight: 600 }}>{name}</code>
      <span style={{ color: COLORS.tertiary }}>{desc}</span>
    </button>
  )
}
