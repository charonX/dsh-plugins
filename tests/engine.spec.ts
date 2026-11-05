import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { parseBatchOutput, preferNoThinking, stripFence, translateBatch, type EngineLimits } from '../src/engine.ts'
import { TranslateError } from '../src/errors.ts'

const limits: EngineLimits = {
  maxItemsPerBatch: 20,
  maxCharsPerItem: 4000,
  maxOutputTokens: 1024,
  requestTimeoutMs: 5000,
}

interface Captures {
  config?: Record<string, unknown>
  options?: Record<string, unknown>
}

/**
 * Stand-in runtime whose adapter advertises the efforts the caller passes.
 * @param answer - assistant text the fake stream produces.
 * @param captures - sink for the prepared config and dispatched options.
 * @param efforts - effort ids the fake route advertises; empty means no reasoning metadata.
 * @param finishKind - terminal reason kind the fake reports.
 * @returns an LLM runtime shaped like the Host service.
 */
function fakeLlm(
  answer: string,
  captures: Captures,
  efforts: readonly string[] = ['off', 'high'],
  finishKind = 'stop',
): LlmRuntime {
  return {
    prepareCall: async (
      config: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      configure?: (controls: unknown, model: unknown) => Record<string, unknown>,
    ) => {
      const model = efforts.length === 0
        ? { provider: config.provider, id: config.model, name: config.model }
        : { provider: config.provider, id: config.model, name: config.model, reasoning: { efforts: efforts.map(id => ({ id, name: id })) } }
      const controls = configure === undefined ? {} : configure({ ...config }, model)
      const resolved = { ...config, ...controls }
      captures.config = resolved
      return {
        config: resolved,
        stream: (options: Record<string, unknown>) => {
          captures.options = options
          return (async function* produce() {
            yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
            yield { type: 'text-delta' as const, index: 0, text: answer }
            yield { type: 'finish' as const, reason: { kind: finishKind } }
          })()
        },
      }
    },
  } as unknown as LlmRuntime
}

describe('preferNoThinking', () => {
  it('selects off when the route advertises it', () => {
    const controls = preferNoThinking({ maxTokens: 100 }, {
      provider: 'p',
      id: 'm',
      name: 'm',
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }] },
    })
    expect(controls.reasoningEffort).toBe('off')
    expect(controls.maxTokens).toBe(100)
  })

  it('leaves efforts alone when off is absent', () => {
    const controls = preferNoThinking({}, {
      provider: 'p',
      id: 'm',
      name: 'm',
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    })
    expect(controls.reasoningEffort).toBeUndefined()
  })

  it('leaves efforts alone when the route has no reasoning metadata', () => {
    expect(preferNoThinking({}, { provider: 'p', id: 'm', name: 'm' }).reasoningEffort).toBeUndefined()
  })
})

describe('stripFence', () => {
  it('unwraps a fenced answer', () => {
    expect(stripFence('```json\n{"items":[]}\n```')).toBe('{"items":[]}')
  })

  it('keeps bare json untouched', () => {
    expect(stripFence(' {"items":[]} ')).toBe('{"items":[]}')
  })
})

describe('parseBatchOutput', () => {
  it('maps ids back in request order', () => {
    const parsed = parseBatchOutput('{"items":[{"id":"b","text":"乙"},{"id":"a","text":"甲"}]}', ['a', 'b'])
    expect(parsed).toEqual([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }])
  })

  it('refuses an answer that drops an item', () => {
    expect(() => parseBatchOutput('{"items":[{"id":"a","text":"甲"}]}', ['a', 'b'])).toThrow(TranslateError)
  })

  it('refuses a non-array answer', () => {
    expect(() => parseBatchOutput('{"text":"甲"}', ['a'])).toThrow(TranslateError)
  })
})

describe('translateBatch', () => {
  it('requests translation with thinking off and returns request order', async () => {
    const captures: Captures = {}
    const answer = JSON.stringify({ items: [{ id: 'one', text: '一' }, { id: 'two', text: '二' }] })
    const results = await translateBatch(
      fakeLlm(answer, captures),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }, { id: 'two', text: 'two' }],
      limits,
      new AbortController().signal,
    )

    expect(results).toEqual([{ id: 'one', text: '一' }, { id: 'two', text: '二' }])
    expect(captures.config?.reasoningEffort).toBe('off')
    expect(captures.config?.maxTokens).toBe(1024)
    expect(String(captures.options?.system)).toContain('translation engine')
  })

  it('omits the effort when the route cannot turn thinking off', async () => {
    const captures: Captures = {}
    await translateBatch(
      fakeLlm(JSON.stringify({ items: [{ id: 'one', text: '一' }] }), captures, ['high']),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )
    expect(captures.config?.reasoningEffort).toBeUndefined()
  })

  it('refuses an empty batch without calling the model', async () => {
    const captures: Captures = {}
    await expect(translateBatch(
      fakeLlm('{}', captures),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [],
      limits,
      new AbortController().signal,
    )).resolves.toEqual([])
    expect(captures.config).toBeUndefined()
  })

  it('reports a failed finish instead of returning a partial answer', async () => {
    const failure = translateBatch(
      fakeLlm('{"items":[]}', {}, ['off'], 'error'),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )
    await expect(failure).rejects.toBeInstanceOf(TranslateError)
    await expect(failure).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
  })
})
