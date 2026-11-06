import { describe, expect, it } from 'vitest'
import type { Preset } from '../src/shared/preset.ts'
import {
  EMPTY_DRAFT,
  compatDraftOf,
  compatOps,
  compatSummary,
  modelCompatOps,
  presetConflict,
  presetOps,
} from '../src/client/ops.ts'

const preset: Preset = {
  id: 'siliconflow',
  name: 'SiliconFlow',
  api: 'openai-completions',
  baseURL: 'https://api.siliconflow.com/v1',
  apiKeyEnv: 'SILICONFLOW_API_KEY',
  doc: 'https://cloud.siliconflow.com/models',
  compat: { thinkingFormat: 'qwen', supportsThinkingTokenBudget: true, supportsDeveloperRole: false },
  models: [
    {
      id: 'Qwen/Qwen3-8B',
      name: 'Qwen3 8B',
      contextWindow: 32768,
      maxTokens: 8192,
      input: ['text'],
      reasoningEfforts: { off: null, high: 'high' },
      compat: { supportsThinkingTokenBudget: true },
    },
    { id: 'Qwen/Qwen2.5-7B', name: 'Qwen2.5 7B' },
  ],
}

const routePath = ['providers', 'siliconflow'] as const

describe('presetConflict', () => {
  it('refuses a route id the page already knows', () => {
    expect(presetConflict(preset, new Set(['siliconflow']))).toBe('exists')
  })

  it('allows an unknown route id', () => {
    expect(presetConflict(preset, new Set(['deepseek']))).toBeUndefined()
  })
})

describe('presetOps', () => {
  const ops = presetOps(preset, routePath)

  it('labels the route with its display name, protocol, endpoint, and key variable', () => {
    expect(ops).toContainEqual({ op: 'set', path: ['providers', 'siliconflow', 'displayName'], value: 'SiliconFlow' })
    expect(ops).toContainEqual({ op: 'set', path: ['providers', 'siliconflow', 'api'], value: 'openai-completions' })
    expect(ops).toContainEqual({ op: 'set', path: ['providers', 'siliconflow', 'baseURL'], value: 'https://api.siliconflow.com/v1' })
    expect(ops).toContainEqual({ op: 'set', path: ['providers', 'siliconflow', 'apiKeyEnv'], value: 'SILICONFLOW_API_KEY' })
  })

  it('writes every compat field at route level', () => {
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'siliconflow', 'compat', 'thinkingFormat'],
      value: 'qwen',
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'siliconflow', 'compat', 'supportsDeveloperRole'],
      value: false,
    })
  })

  it('writes models with only the fields the preset states', () => {
    const models = ops.find(entry => entry.path.at(-1) === 'models')
    expect(models).toEqual({
      op: 'set',
      path: ['providers', 'siliconflow', 'models'],
      value: [
        {
          id: 'Qwen/Qwen3-8B',
          name: 'Qwen3 8B',
          contextWindow: 32768,
          maxTokens: 8192,
          input: ['text'],
          reasoningEfforts: { off: null, high: 'high' },
          compat: { supportsThinkingTokenBudget: true },
        },
        { id: 'Qwen/Qwen2.5-7B', name: 'Qwen2.5 7B' },
      ],
    })
  })

  it('never writes a credential value', () => {
    expect(ops.every(entry => !entry.path.some(segment => segment.toLowerCase().includes('key') && segment !== 'apiKeyEnv'))).toBe(true)
  })

  it('ignores an absent compat value', () => {
    const sparse: Preset = { ...preset, compat: {} }
    expect(presetOps(sparse, routePath).some(entry => entry.path.includes('compat'))).toBe(false)
  })
})

describe('compatDraftOf', () => {
  it('reads strings, booleans, and kwargs into text fields', () => {
    expect(compatDraftOf({ thinkingFormat: 'qwen', supportsDeveloperRole: false, chatTemplateKwargs: { a: 1 } })).toEqual({
      thinkingFormat: 'qwen',
      maxTokensField: '',
      supportsDeveloperRole: 'false',
      supportsReasoningEffort: '',
      supportsThinkingTokenBudget: '',
      chatTemplateKwargs: '{\n  "a": 1\n}',
    })
  })

  it('treats a missing or malformed block as fully automatic', () => {
    expect(compatDraftOf(undefined)).toEqual(EMPTY_DRAFT)
    expect(compatDraftOf('nonsense')).toEqual(EMPTY_DRAFT)
  })
})

describe('compatOps', () => {
  const compatPath = ['providers', 'siliconflow', 'compat'] as const

  it('clears every field when the draft is empty', () => {
    expect(compatOps(compatPath, EMPTY_DRAFT)).toEqual({
      ops: [
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'thinkingFormat'] },
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'maxTokensField'] },
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'supportsDeveloperRole'] },
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'supportsReasoningEffort'] },
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'supportsThinkingTokenBudget'] },
        { op: 'unset', path: ['providers', 'siliconflow', 'compat', 'chatTemplateKwargs'] },
      ],
    })
  })

  it('writes booleans as booleans and trims text fields', () => {
    const parsed = compatOps(compatPath, {
      ...EMPTY_DRAFT,
      thinkingFormat: ' qwen ',
      supportsDeveloperRole: 'false',
      maxTokensField: 'max_tokens',
    })
    expect(parsed.ops).toContainEqual({ op: 'set', path: [...compatPath, 'thinkingFormat'], value: 'qwen' })
    expect(parsed.ops).toContainEqual({ op: 'set', path: [...compatPath, 'supportsDeveloperRole'], value: false })
    expect(parsed.ops).toContainEqual({ op: 'set', path: [...compatPath, 'maxTokensField'], value: 'max_tokens' })
  })

  it('parses kwargs into an object', () => {
    const parsed = compatOps(compatPath, { ...EMPTY_DRAFT, chatTemplateKwargs: '{"enable_thinking":false}' })
    expect(parsed.ops).toContainEqual({
      op: 'set',
      path: [...compatPath, 'chatTemplateKwargs'],
      value: { enable_thinking: false },
    })
  })

  it('refuses kwargs that are not a JSON object', () => {
    expect(compatOps(compatPath, { ...EMPTY_DRAFT, chatTemplateKwargs: '{oops' })).toEqual({ error: 'invalidKwargs' })
    expect(compatOps(compatPath, { ...EMPTY_DRAFT, chatTemplateKwargs: '[1,2]' })).toEqual({ error: 'invalidKwargs' })
  })
})

describe('modelCompatOps', () => {
  const modelPath = ['providers', 'siliconflow', 'models', '0'] as const

  it('writes a model-level override under models[i].compat', () => {
    const parsed = modelCompatOps(modelPath, { ...EMPTY_DRAFT, supportsThinkingTokenBudget: 'true' })
    expect(parsed.ops).toContainEqual({
      op: 'set',
      path: [...modelPath, 'compat', 'supportsThinkingTokenBudget'],
      value: true,
    })
  })

  it('clears the whole compat block instead of leaving an empty object', () => {
    expect(modelCompatOps(modelPath, EMPTY_DRAFT)).toEqual({
      ops: [{ op: 'unset', path: [...modelPath, 'compat'] }],
    })
  })

  it('keeps the per-field form when only some fields are cleared', () => {
    const parsed = modelCompatOps(modelPath, { ...EMPTY_DRAFT, thinkingFormat: 'qwen' })
    expect(parsed.ops).toContainEqual({ op: 'set', path: [...modelPath, 'compat', 'thinkingFormat'], value: 'qwen' })
    expect(parsed.ops).toContainEqual({ op: 'unset', path: [...modelPath, 'compat', 'supportsDeveloperRole'] })
  })
})

describe('compatSummary', () => {
  it('lists only the fields the preset sets', () => {
    expect(compatSummary(preset)).toEqual([
      'thinkingFormat=qwen',
      'supportsThinkingTokenBudget=true',
      'supportsDeveloperRole=false',
    ])
  })
})
