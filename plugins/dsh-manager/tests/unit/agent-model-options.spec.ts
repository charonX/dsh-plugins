/** Unit tests for host `agentDefaultModel` fallback and override precedence. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { resolveAgentModelOptions } from '../../src/agent-model-options.ts'

describe('resolveAgentModelOptions', () => {
  test('falls back to host agentDefaultModel when bundle config omits provider and model', () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel' as never, {
      currentSelection: () => ({ provider: 'siliconflow', model: 'Qwen/Qwen3-8B', reasoningEffort: 'off' }),
    } as never)

    expect(resolveAgentModelOptions(ctx, {})).toEqual({
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-8B',
      reasoningEffort: 'off',
    })
  })

  test('applies bundle config over host default, and member overrides over bundle config', () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel' as never, {
      currentSelection: () => ({ provider: 'siliconflow', model: 'Qwen/Qwen3-8B' }),
    } as never)

    expect(resolveAgentModelOptions(
      ctx,
      { provider: 'mock', model: 'steward-test' },
      { provider: 'deepseek', model: 'deepseek-reasoner' },
    )).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })
  })

  test('returns explicit layers cleanly when agentDefaultModel is absent', () => {
    const ctx = new Context()
    expect(resolveAgentModelOptions(ctx, { provider: 'mock', model: 'm-1' })).toEqual({
      provider: 'mock',
      model: 'm-1',
    })
    expect(resolveAgentModelOptions(ctx, {})).toEqual({})
  })
})
