import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  echoesSource,
  instruction,
  parseBatchOutput,
  preferNoThinking,
  stripFence,
  translateBatch,
  type EngineLimits,
} from '../src/engine.ts'
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
 * @param reasoning - reasoning text emitted before the answer, as hybrid routes do.
 * @returns an LLM runtime shaped like the Host service.
 */
function fakeLlm(
  answer: string,
  captures: Captures,
  efforts: readonly string[] = ['off', 'high'],
  finishKind = 'stop',
  reasoning?: string,
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
            if (reasoning !== undefined) {
              yield { type: 'block-start' as const, index: 0, blockType: 'reasoning' as const }
              yield { type: 'reasoning-delta' as const, index: 0, text: reasoning }
              yield { type: 'block-end' as const, index: 0, block: { type: 'reasoning' as const, text: reasoning } }
            }
            yield { type: 'block-start' as const, index: reasoning === undefined ? 0 : 1, blockType: 'text' as const }
            yield { type: 'text-delta' as const, index: reasoning === undefined ? 0 : 1, text: answer }
            yield {
              type: 'finish' as const,
              reason: finishKind === 'error'
                ? { kind: 'error' as const, failure: { code: 'AUTH', message: 'bad key', status: 401 } }
                : { kind: finishKind },
            }
          })()
        },
      }
    },
  } as unknown as LlmRuntime
}

/**
 * Stand-in runtime answering successive requests from one list.
 * @param answers - assistant text per request, in call order.
 * @param prompts - receives the instruction of each request.
 * @returns an LLM runtime shaped like the Host service.
 */
function sequencedLlm(answers: readonly string[], prompts: string[] = []): LlmRuntime {
  let call = 0
  return {
    prepareCall: async (config: Record<string, unknown>) => ({
      config,
      stream: (options: { messages?: readonly { content: readonly { text: string }[] }[] }) => {
        prompts.push(options.messages?.[0]?.content[0]?.text ?? '')
        const answer = answers[call] ?? ''
        call += 1
        return (async function* produce() {
          yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
          yield { type: 'text-delta' as const, index: 0, text: answer }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        })()
      },
    }),
  } as unknown as LlmRuntime
}

describe('instruction', () => {
  it('names the destination language next to its tag', () => {
    expect(instruction('zh-CN')).toContain('简体中文 (zh-CN)')
  })

  it('falls back to the tag when the language has no label', () => {
    expect(instruction('eo')).toContain('Translate the "text" of every input item into eo.')
  })

  it('carries the retry wording only on demand', () => {
    expect(instruction('zh-CN')).not.toContain('copied the source text')
    expect(instruction('zh-CN', true)).toContain('copied the source text')
  })
})

describe('echoesSource', () => {
  it('reports an answer that copied its source', () => {
    expect(echoesSource([{ id: 'a', text: 'computer\n' }], [{ id: 'a', text: 'computer\n' }])).toBe(true)
  })

  it('accepts a real translation', () => {
    expect(echoesSource([{ id: 'a', text: 'computer' }], [{ id: 'a', text: '计算机' }])).toBe(false)
  })

  it('ignores an empty source', () => {
    expect(echoesSource([{ id: 'a', text: '  ' }], [{ id: 'a', text: '' }])).toBe(false)
  })
})

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

    expect(results.items).toEqual([{ id: 'one', text: '一' }, { id: 'two', text: '二' }])
    expect(results.reasoned).toBe(false)
    expect(captures.config?.reasoningEffort).toBe('off')
    expect(captures.config?.maxTokens).toBe(1024)
    const messages = captures.options?.messages as readonly { role: string; content: readonly { text: string }[] }[]
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content[0]?.text).toContain('translation engine')
    expect(captures.options?.system).toBeUndefined()
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
    )).resolves.toEqual({ items: [], reasoned: false, attempts: 0, durationMs: 0, cacheable: false })
    expect(captures.config).toBeUndefined()
  })

  it('keeps the answer when a hybrid route reasons first', async () => {
    const results = await translateBatch(
      fakeLlm(JSON.stringify({ items: [{ id: 'one', text: '一' }] }), {}, ['high'], 'stop', 'weighing wording'),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )
    expect(results.items).toEqual([{ id: 'one', text: '一' }])
    expect(results.reasoned).toBe(true)
  })

  it('refuses an answer with no text block', async () => {
    await expect(translateBatch(
      fakeLlm('', {}, ['high'], 'stop', 'only thinking'),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
  })

  it('surfaces the provider failure behind a failed finish', async () => {
    const failure = translateBatch(
      fakeLlm('{"items":[]}', {}, ['off'], 'error'),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )
    await expect(failure).rejects.toBeInstanceOf(TranslateError)
    await expect(failure).rejects.toMatchObject({
      code: 'MODEL_FAILED',
      message: 'AUTH (HTTP 401): bad key',
    })
  })

  it('retries once when the answer copies its source text', async () => {
    const prompts: string[] = []
    const results = await translateBatch(
      sequencedLlm([
        JSON.stringify({ items: [{ id: 'one', text: 'computer' }] }),
        JSON.stringify({ items: [{ id: 'one', text: '计算机' }] }),
      ], prompts),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'computer' }],
      limits,
      new AbortController().signal,
    )

    expect(results.items).toEqual([{ id: 'one', text: '计算机' }])
    expect(results.attempts).toBe(2)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('copied the source text')
  })

  it('does not retry a translated answer', async () => {
    const prompts: string[] = []
    const results = await translateBatch(
      sequencedLlm([JSON.stringify({ items: [{ id: 'one', text: '计算机' }] })], prompts),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'computer' }],
      limits,
      new AbortController().signal,
    )
    expect(prompts).toHaveLength(1)
    expect(results.attempts).toBe(1)
    expect(results.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps the retried answer even when it copies the source again', async () => {
    const echoed = JSON.stringify({ items: [{ id: 'one', text: 'DSH' }] })
    const results = await translateBatch(
      sequencedLlm([echoed, echoed]),
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'DSH' }],
      limits,
      new AbortController().signal,
    )
    expect(results.items).toEqual([{ id: 'one', text: 'DSH' }])
  })

  it('surfaces a transport failure thrown by the stream', async () => {
    const throwing = {
      prepareCall: async () => ({
        config: { provider: 'p', model: 'm' },
        stream: () => (async function* produce() {
          throw new Error('socket closed')
        })(),
      }),
    } as unknown as LlmRuntime

    await expect(translateBatch(
      throwing,
      { provider: 'p', model: 'm' },
      'zh-CN',
      [{ id: 'one', text: 'one' }],
      limits,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'MODEL_FAILED', message: 'socket closed' })
  })
})
