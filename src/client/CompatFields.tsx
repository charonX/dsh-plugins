/**
 * The compatibility controls, shared by the provider-card editor and the model
 * page so both surfaces edit the same fields with the page's own controls.
 *
 * @module dsh-model-studio/client/CompatFields
 */

import type { ReactNode } from 'react'
import { THINKING_FORMATS } from '../dialect.ts'
import type { Translate } from './locales.ts'
import { COMPAT_SWITCHES, type CompatDraft } from './ops.ts'
import { fieldStyle, inputStyle, labelStyle, selectStyle } from './tokens.ts'

/** Output fields pi-ai accepts. */
const MAX_TOKENS_FIELDS: readonly string[] = ['max_tokens', 'max_completion_tokens']

/** Props of {@link CompatFields}. */
export interface CompatFieldsProps {
  /** Localizer bound to this plugin's namespace. */
  t: Translate
  /** Prefix for control ids, unique per rendered instance. */
  idPrefix: string
  /** Current values; `''` means "leave to auto-detection". */
  draft: CompatDraft
  /** Whether the controls accept input. */
  disabled: boolean
  /** Field change callback. */
  onChange(field: keyof CompatDraft, value: string): void
}

/**
 * Render the compatibility form.
 * @param props - draft, disabled state, and the change callback.
 * @returns the form controls.
 */
export function CompatFields({ t, idPrefix, draft, disabled, onChange }: CompatFieldsProps): ReactNode {
  return (
    <>
      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${idPrefix}-format`}>{t('compatFieldFormat')}</label>
        <select
          id={`${idPrefix}-format`}
          style={selectStyle}
          value={draft.thinkingFormat}
          disabled={disabled}
          onChange={event => onChange('thinkingFormat', event.target.value)}
        >
          <option value="">{t('compatAuto')}</option>
          {THINKING_FORMATS.map(format => <option key={format} value={format}>{format}</option>)}
        </select>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${idPrefix}-maxTokens`}>{t('compatFieldMaxTokens')}</label>
        <select
          id={`${idPrefix}-maxTokens`}
          style={selectStyle}
          value={draft.maxTokensField}
          disabled={disabled}
          onChange={event => onChange('maxTokensField', event.target.value)}
        >
          <option value="">{t('compatAuto')}</option>
          {MAX_TOKENS_FIELDS.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>

      {COMPAT_SWITCHES.map(key => (
        <div style={fieldStyle} key={key}>
          <label style={labelStyle} htmlFor={`${idPrefix}-${key}`}>{switchLabel(t, key)}</label>
          <select
            id={`${idPrefix}-${key}`}
            style={selectStyle}
            value={draft[key]}
            disabled={disabled}
            onChange={event => onChange(key, event.target.value)}
          >
            <option value="">{t('compatAuto')}</option>
            <option value="true">{t('compatEnabled')}</option>
            <option value="false">{t('compatDisabled')}</option>
          </select>
        </div>
      ))}

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${idPrefix}-kwargs`}>{t('compatFieldKwargs')}</label>
        <textarea
          id={`${idPrefix}-kwargs`}
          style={{ ...inputStyle, height: 'auto', minHeight: 64, padding: '6px 10px', fontFamily: 'monospace' }}
          value={draft.chatTemplateKwargs}
          disabled={disabled}
          spellCheck={false}
          onChange={event => onChange('chatTemplateKwargs', event.target.value)}
        />
      </div>
    </>
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
