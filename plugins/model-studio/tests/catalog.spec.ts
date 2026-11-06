import { describe, expect, it } from 'vitest'
import { PRESETS } from '../src/data/presets.generated.ts'
import { isDetectedEndpoint } from '../src/preset-pick.ts'

const ROUTE_ID = /^[a-z0-9][a-z0-9._-]*$/u
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

describe('generated catalogue', () => {
  it('carries provenance', () => {
    expect(PRESETS.source).toContain('models.dev')
    expect(PRESETS.license).toBe('MIT')
    expect(PRESETS.snapshot.length).toBeGreaterThan(0)
    expect(PRESETS.skipped.notOpenAiCompatible).toBeGreaterThanOrEqual(0)
  })

  it('never repeats a route id and keeps ids addressable', () => {
    const ids = PRESETS.presets.map(preset => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(ROUTE_ID)
  })

  it('only declares routes this plugin can actually serve', () => {
    for (const preset of PRESETS.presets) {
      expect(preset.api).toBe('openai-completions')
      expect(preset.baseURL).toMatch(/^https?:\/\//u)
      expect(preset.apiKeyEnv).toMatch(CREDENTIAL_REF)
      expect(preset.name.length).toBeGreaterThan(0)
    }
  })

  it('writes between one and three representative models', () => {
    for (const preset of PRESETS.presets) {
      expect(preset.models.length).toBeGreaterThan(0)
      expect(preset.models.length).toBeLessThanOrEqual(3)
      for (const model of preset.models) expect(model.id.length).toBeGreaterThan(0)
    }
  })

  it('declares reasoning ladders that always start with an empty off', () => {
    for (const preset of PRESETS.presets) {
      for (const model of preset.models) {
        const efforts = model.reasoningEfforts
        if (efforts === undefined) continue
        expect(Object.keys(efforts)[0]).toBe('off')
        expect(efforts['off']).toBeNull()
        // A declared ladder must offer at least one selectable level.
        expect(Object.keys(efforts).length).toBeGreaterThan(1)
      }
    }
  })

  it('neutralises the developer role exactly when a model declares reasoning', () => {
    for (const preset of PRESETS.presets) {
      const declares = preset.models.some(model => model.reasoningEfforts !== undefined)
      expect(preset.compat.supportsDeveloperRole).toBe(declares ? false : undefined)
    }
  })

  it('keeps gateway capabilities on the route and model capabilities on the model', () => {
    for (const preset of PRESETS.presets) {
      // The thinking budget is documented per model: never speak for the route.
      expect(preset.compat.supportsThinkingTokenBudget).toBeUndefined()
      for (const model of preset.models) {
        if (model.compat === undefined) continue
        expect(Object.keys(model.compat)).toEqual(['supportsThinkingTokenBudget'])
        expect(model.compat.supportsThinkingTokenBudget).toBe(true)
      }
    }
  })

  it('never pins a dialect on an endpoint pi-ai already classifies', () => {
    for (const preset of PRESETS.presets) {
      if (!isDetectedEndpoint(preset.baseURL)) continue
      expect(preset.compat.thinkingFormat).toBeUndefined()
    }
  })

  it('only writes valid adapter vocabulary', () => {
    const formats = new Set(['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
      'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'])
    for (const preset of PRESETS.presets) {
      if (preset.compat.thinkingFormat !== undefined) expect(formats).toContain(preset.compat.thinkingFormat)
      for (const model of preset.models) {
        for (const modality of model.input ?? []) expect(['text', 'image']).toContain(modality)
        for (const level of Object.keys(model.reasoningEfforts ?? {})) {
          expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).toContain(level)
        }
      }
    }
  })
})
