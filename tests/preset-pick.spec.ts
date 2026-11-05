import { describe, expect, it } from 'vitest'
import {
  buildPreset,
  compatOf,
  controlClass,
  effortsOf,
  isDetectedEndpoint,
  isOpenAiCompatible,
  optionsOf,
  pickModels,
  presetModelOf,
  type ModelsDevModel,
  type ModelsDevProvider,
  type ModelsDevReasoningOption,
} from '../src/preset-pick.ts'
import { profileOf } from '../src/dialect.ts'

const toggle: ModelsDevReasoningOption[] = [{ type: 'toggle' }]
const effort = (...values: string[]): ModelsDevReasoningOption[] => [{ type: 'effort', values }]
const budget: ModelsDevReasoningOption[] = [{ type: 'budget_tokens', min: 128, max: 32768 }]

/** One model's profile through the same normalisation the generator uses. */
const profileOfOptions = (options?: readonly ModelsDevReasoningOption[]) => profileOf(optionsOf(options))

function model(id: string, extra: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return { id, name: id, tool_call: true, reasoning: true, last_updated: '2026-01-01', ...extra }
}

function provider(extra: Partial<ModelsDevProvider> = {}): ModelsDevProvider {
  return {
    id: 'gateway',
    name: 'Gateway',
    api: 'https://api.gateway.example/v1',
    env: ['GATEWAY_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    models: {
      'model-a': model('model-a', { reasoning_options: toggle }),
      'model-b': model('model-b', { reasoning_options: toggle, last_updated: '2025-01-01' }),
    },
    ...extra,
  }
}

describe('isOpenAiCompatible', () => {
  it('accepts the openai-compatible SDK family', () => {
    expect(isOpenAiCompatible(provider())).toBe(true)
  })

  it('accepts the openai SDK family only on a /v1 base', () => {
    expect(isOpenAiCompatible(provider({ npm: '@ai-sdk/openai', api: 'https://x.example/v1' }))).toBe(true)
    expect(isOpenAiCompatible(provider({ npm: '@ai-sdk/openai', api: 'https://x.example/responses' }))).toBe(false)
  })

  it('refuses another protocol or a missing endpoint', () => {
    expect(isOpenAiCompatible(provider({ npm: '@ai-sdk/anthropic' }))).toBe(false)
    expect(isOpenAiCompatible(provider({ api: undefined }))).toBe(false)
  })
})

describe('isDetectedEndpoint', () => {
  it('recognises the endpoints pi-ai already classifies', () => {
    expect(isDetectedEndpoint('https://open.bigmodel.cn/api/paas/v4')).toBe(true)
    expect(isDetectedEndpoint('https://api.deepseek.com')).toBe(true)
    expect(isDetectedEndpoint('https://api.together.xyz/v1')).toBe(true)
  })

  it('leaves unknown gateways to the snapshot', () => {
    expect(isDetectedEndpoint('https://api.siliconflow.com/v1')).toBe(false)
    // A lookalike host must not be mistaken for an x.ai endpoint.
    expect(isDetectedEndpoint('https://api.ofox.ai/v1')).toBe(false)
  })
})

describe('controlClass', () => {
  it('treats toggle and budget as switch shapes', () => {
    expect(controlClass(profileOfOptions(toggle))).toBe('switch')
    expect(controlClass(profileOfOptions(budget))).toBe('switch')
    expect(controlClass(profileOfOptions([...toggle, ...budget]))).toBe('switch')
  })

  it('keeps effort separate and empty as none', () => {
    expect(controlClass(profileOfOptions(effort('low', 'high')))).toBe('effort')
    expect(controlClass(profileOfOptions(undefined))).toBe('none')
  })
})

describe('pickModels', () => {
  it('keeps only models that match the dominant reasoning shape', () => {
    const picked = pickModels(provider({
      models: {
        'switch-a': model('switch-a', { reasoning_options: toggle }),
        'switch-b': model('switch-b', { reasoning_options: toggle }),
        'effort-a': model('effort-a', { reasoning_options: effort('low'), last_updated: '2026-12-31' }),
      },
    }))
    expect(picked.map(entry => entry.id)).not.toContain('effort-a')
  })

  it('prefers tool calling, then reasoning, then recency, capped at three', () => {
    const picked = pickModels(provider({
      models: {
        old: model('old', { reasoning_options: toggle, last_updated: '2020-01-01' }),
        new: model('new', { reasoning_options: toggle, last_updated: '2026-06-01' }),
        noTools: model('noTools', { reasoning_options: toggle, tool_call: false, last_updated: '2027-01-01' }),
        plain: model('plain', { last_updated: '2027-02-01' }),
        extra: model('extra', { reasoning_options: toggle }),
      },
    }))
    expect(picked.map(entry => entry.id)).toEqual(['new', 'extra', 'old'])
  })

  it('falls back to every ranked model when nothing documents reasoning', () => {
    const picked = pickModels(provider({
      models: { plain: model('plain'), other: model('other', { tool_call: false }) },
    }))
    expect(picked.map(entry => entry.id)).toEqual(['plain', 'other'])
  })
})

describe('effortsOf', () => {
  it('starts with an empty off and keeps documented levels in order', () => {
    expect(effortsOf(profileOfOptions(effort('high', 'low', 'none')))).toEqual({ off: null, low: 'low', high: 'high' })
  })

  it('names one nominal level for a switch-only model', () => {
    expect(effortsOf(profileOfOptions(toggle))).toEqual({ off: null, high: 'high' })
  })

  it('declares nothing for a model without reasoning', () => {
    expect(effortsOf(profileOfOptions(undefined))).toBeUndefined()
  })
})

describe('compatOf', () => {
  it('declares a switch dialect for a switch-shaped gateway', () => {
    expect(compatOf(profileOfOptions(toggle), false)).toEqual({ thinkingFormat: 'qwen' })
  })

  it('prefers the switch family even when an effort ladder is documented too', () => {
    expect(compatOf(profileOfOptions([...toggle, ...effort('low')]), false)).toEqual({ thinkingFormat: 'qwen' })
  })

  it('adds the budget flag for a documented budget', () => {
    expect(compatOf(profileOfOptions(budget), false)).toEqual({ thinkingFormat: 'qwen', supportsThinkingTokenBudget: true })
  })

  it('never overrides an endpoint pi-ai already classifies', () => {
    expect(compatOf(profileOfOptions(toggle), true)).toEqual({})
  })

  it('writes nothing for an effort-only gateway', () => {
    expect(compatOf(profileOfOptions(effort('low', 'high')), false)).toEqual({})
  })
})

describe('presetModelOf', () => {
  it('keeps only adapter modalities and omits unusable limits', () => {
    expect(presetModelOf(model('m', {
      reasoning_options: toggle,
      limit: { context: 0, output: 4096 },
      modalities: { input: ['text', 'video', 'image'] },
    }))).toEqual({
      id: 'm',
      name: 'm',
      maxTokens: 4096,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, high: 'high' },
    })
  })
})

describe('buildPreset', () => {
  it('writes a complete route with the developer-role switch neutralised', () => {
    const preset = buildPreset(provider())
    expect(preset).toMatchObject({
      id: 'gateway',
      api: 'openai-completions',
      baseURL: 'https://api.gateway.example/v1',
      apiKeyEnv: 'GATEWAY_API_KEY',
      compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false },
    })
    expect(preset?.models).toHaveLength(2)
  })

  it('leaves the role switch alone when nothing declares reasoning', () => {
    const preset = buildPreset(provider({ models: { plain: model('plain', { reasoning: false }) } }))
    expect(preset?.compat).toEqual({})
  })

  it('does not pin a dialect on an endpoint pi-ai already knows', () => {
    const preset = buildPreset(provider({ api: 'https://open.bigmodel.cn/api/paas/v4' }))
    expect(preset?.compat).toEqual({ supportsDeveloperRole: false })
  })

  it('refuses what cannot be configured safely', () => {
    expect(buildPreset(provider({ env: undefined }))).toBeUndefined()
    expect(buildPreset(provider({ env: ['not a ref'] }))).toBeUndefined()
    expect(buildPreset(provider({ id: 'Bad Id' }))).toBeUndefined()
    expect(buildPreset(provider({ api: 'ftp://example' }))).toBeUndefined()
    expect(buildPreset(provider({ models: {} }))).toBeUndefined()
  })
})
