/**
 * The compatibility controls, shared by the provider-card editor and the model
 * page so both surfaces edit the same fields with the page's own controls.
 *
 * @module dsh-model-studio/client/CompatFields
 */

import type { ReactNode } from 'react'
import { THINKING_FORMATS } from '../dialect.ts'
import { DshSelect } from './DshSelect.tsx'
import type { Translate } from './locales.ts'
import { COMPAT_SWITCHES, type CompatDraft } from './ops.ts'
import { fieldStyle, inputStyle, labelStyle } from './tokens.ts'

/** Output fields pi-ai accepts. */
const MAX_TOKENS_FIELDS: readonly string[] = ['max_tokens', 'max_completion_tokens']

/**
 * Known `chat_template_kwargs` shapes.
 *
 * The `$var` placeholders are pi-ai's vocabulary (`thinking.enabled`,
 * `thinking.effort`, `thinking.budget`), not arbitrary strings: a value saying
 * which placeholder it mirrors is resolved from the request's thinking state at
 * dispatch time, and `omitWhenOff` leaves the key out entirely when thinking is
 * off. These four cover the templates gateways publish most often.
 */
const KWARGS_PRESETS: readonly { readonly id: string; readonly json: string }[] = [
  {
    id: 'enable_thinking',
    json: '{\n  "enable_thinking": {\n    "$var": "thinking.enabled",\n    "omitWhenOff": true\n  }\n}',
  },
  {
    id: 'thinking',
    json: '{\n  "thinking": {\n    "$var": "thinking.enabled",\n    "omitWhenOff": true\n  }\n}',
  },
  {
    id: 'enable_thinking+preserve_thinking',
    json: '{\n  "enable_thinking": {\n    "$var": "thinking.enabled",\n    "omitWhenOff": true\n  },\n  "preserve_thinking": true\n}',
  },
  {
    id: 'thinking_budget',
    json: '{\n  "thinking_budget": {\n    "$var": "thinking.budget"\n  }\n}',
  },
]

/**
 * Which preset a kwargs text currently equals.
 * @param text - textarea content.
 * @returns the matching preset id, or `''` for hand-written content.
 */
function kwargsPresetOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  for (const preset of KWARGS_PRESETS) {
    try {
      if (JSON.stringify(JSON.parse(trimmed)) === JSON.stringify(JSON.parse(preset.json))) return preset.id
    } catch {
      return ''
    }
  }
  return ''
}

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
        <DshSelect
          id={`${idPrefix}-format`}
          value={draft.thinkingFormat}
          disabled={disabled}
          options={[
            { value: '', label: t('compatAuto') },
            ...THINKING_FORMATS.map(format => ({ value: format, label: format })),
          ]}
          onChange={value => onChange('thinkingFormat', value)}
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${idPrefix}-maxTokens`}>{t('compatFieldMaxTokens')}</label>
        <DshSelect
          id={`${idPrefix}-maxTokens`}
          value={draft.maxTokensField}
          disabled={disabled}
          options={[
            { value: '', label: t('compatAuto') },
            ...MAX_TOKENS_FIELDS.map(name => ({ value: name, label: name })),
          ]}
          onChange={value => onChange('maxTokensField', value)}
        />
      </div>

      {COMPAT_SWITCHES.map(key => (
        <div style={fieldStyle} key={key}>
          <label style={labelStyle} htmlFor={`${idPrefix}-${key}`}>{switchLabel(t, key)}</label>
          <DshSelect
            id={`${idPrefix}-${key}`}
            value={draft[key]}
            disabled={disabled}
            options={[
              { value: '', label: t('compatAuto') },
              { value: 'true', label: t('compatEnabled') },
              { value: 'false', label: t('compatDisabled') },
            ]}
            onChange={value => onChange(key, value)}
          />
        </div>
      ))}

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor={`${idPrefix}-kwargs-preset`}>{t('compatKwargsPreset')}</label>
        <DshSelect
          id={`${idPrefix}-kwargs-preset`}
          value={kwargsPresetOf(draft.chatTemplateKwargs)}
          disabled={disabled}
          options={[
            { value: '', label: t('compatKwargsCustom') },
            ...KWARGS_PRESETS.map(preset => ({ value: preset.id, label: preset.id })),
          ]}
          onChange={value => {
            const preset = KWARGS_PRESETS.find(candidate => candidate.id === value)
            if (preset !== undefined) onChange('chatTemplateKwargs', preset.json)
          }}
        />
        <p style={{ ...labelStyle, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #6b7280)' }}>
          {t('compatKwargsHint')}
        </p>
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
