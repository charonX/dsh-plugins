import { describe, expect, it } from 'vitest'
import {
  THINKING_FORMATS,
  candidateFormats,
  compatSuggestion,
  profileOf,
  reasoningEffortsOf,
  type ReasoningOption,
} from '../src/dialect.ts'

const effort = (...values: string[]): ReasoningOption => ({ type: 'effort', values })
const toggle: ReasoningOption = { type: 'toggle' }

describe('profileOf', () => {
  it('reads an effort ladder', () => {
    expect(profileOf([effort('low', 'high', 'max')])).toEqual({
      shapes: ['effort'],
      effortValues: ['low', 'high', 'max'],
    })
  })

  it('reads a bare toggle', () => {
    expect(profileOf([toggle])).toEqual({ shapes: ['toggle'], effortValues: [] })
  })

  it('keeps both shapes and the documented budget', () => {
    expect(profileOf([toggle, { type: 'budget_tokens', min: 128, max: 32768 }])).toEqual({
      shapes: ['toggle', 'budget'],
      effortValues: [],
      budget: { min: 128, max: 32768 },
    })
  })

  it('reports nothing for a model without reasoning options', () => {
    expect(profileOf(undefined)).toEqual({ shapes: [], effortValues: [] })
  })
})

describe('candidateFormats', () => {
  it('tries effort dialects first when an effort ladder is documented', () => {
    expect(candidateFormats(profileOf([effort('low', 'high')]))[0]).toBe('openai')
  })

  it('tries switch dialects first when only a toggle is documented', () => {
    expect(candidateFormats(profileOf([toggle]))[0]).toBe('qwen')
  })

  it('offers both families when both shapes are documented', () => {
    const candidates = candidateFormats(profileOf([toggle, effort('low')]))
    expect(candidates[0]).toBe('openai')
    expect(candidates).toContain('qwen')
  })

  it('probes nothing when the model does not reason', () => {
    expect(candidateFormats(profileOf([]))).toEqual([])
  })

  it('only returns formats the adapter accepts, without duplicates', () => {
    for (const options of [[effort('low')], [toggle], [toggle, effort('low')]]) {
      const candidates = candidateFormats(profileOf(options))
      expect(new Set(candidates).size).toBe(candidates.length)
      for (const candidate of candidates) expect(THINKING_FORMATS).toContain(candidate)
    }
  })
})

describe('compatSuggestion', () => {
  it('recommends the first candidate plus the budget flag', () => {
    expect(compatSuggestion(profileOf([toggle, { type: 'budget_tokens', min: 128, max: 4096 }]))).toEqual({
      thinkingFormat: 'qwen',
      supportsThinkingTokenBudget: true,
      budget: { min: 128, max: 4096 },
    })
  })

  it('recommends nothing for a model without reasoning', () => {
    expect(compatSuggestion(profileOf([]))).toEqual({})
  })
})

describe('reasoningEffortsOf', () => {
  it('always declares off first with an empty wire value', () => {
    expect(reasoningEffortsOf(profileOf([effort('low', 'high')]))).toEqual({
      off: null,
      low: 'low',
      high: 'high',
    })
  })

  it('declares a nominal level for a toggle-only model', () => {
    expect(reasoningEffortsOf(profileOf([toggle]))).toEqual({ off: null, high: 'high' })
  })

  it('declares nothing for a model without reasoning', () => {
    expect(reasoningEffortsOf(profileOf([]))).toBeUndefined()
  })
})
