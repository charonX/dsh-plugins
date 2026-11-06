import { describe, expect, it } from 'vitest'
import { modelRoutesOf } from '../src/client/model-view.ts'

const value = {
  providers: {
    siliconflow: {
      displayName: 'SiliconFlow',
      baseURL: 'https://api.siliconflow.cn/v1',
      models: [
        { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B', contextWindow: 32768, maxTokens: 8192, reasoningEfforts: { off: null, high: 'high' } },
        { id: 'deepseek-ai/DeepSeek-OCR', name: 'DeepSeek OCR', compat: { supportsThinkingTokenBudget: true } },
      ],
    },
    empty: { displayName: 'No models', models: [] },
  },
}

describe('modelRoutesOf', () => {
  const routes = modelRoutesOf(value, ['providers'])

  it('omits routes with no declared model', () => {
    expect(routes.map(route => route.routeId)).toEqual(['siliconflow'])
  })

  it('addresses every model entry by its path', () => {
    expect(routes[0]?.models.map(model => model.path)).toEqual([
      ['providers', 'siliconflow', 'models', '0'],
      ['providers', 'siliconflow', 'models', '1'],
    ])
  })

  it('reports the facts the page renders', () => {
    expect(routes[0]?.name).toBe('SiliconFlow')
    expect(routes[0]?.baseURL).toBe('https://api.siliconflow.cn/v1')
    expect(routes[0]?.models[0]).toMatchObject({
      id: 'Qwen/Qwen3-8B',
      name: 'Qwen3 8B',
      contextWindow: 32768,
      maxTokens: 8192,
      levels: ['off', 'high'],
    })
    expect(routes[0]?.models[1]?.storedCompat).toEqual({ supportsThinkingTokenBudget: true })
    expect(routes[0]?.models[1]?.levels).toBeUndefined()
  })

  it('skips malformed entries instead of rendering blanks', () => {
    const messy = { providers: { gw: { models: [null, { name: 'no id' }, { id: '' }] } } }
    expect(modelRoutesOf(messy, ['providers'])).toEqual([])
  })

  it('survives a missing or non-object namespace value', () => {
    expect(modelRoutesOf(undefined, ['providers'])).toEqual([])
    expect(modelRoutesOf({ providers: 'nope' }, ['providers'])).toEqual([])
  })
})
